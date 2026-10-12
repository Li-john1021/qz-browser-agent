#!/usr/bin/env python3
"""Two-state local keep/carve energy with one global Tree-DP action model.

State A is the stable rich linear scorer.  State B adds a bounded nonlinear
local residual trained from the same human/cross-lingual/candidate evidence.
Their legal roots compete in one page-global action energy; no Readability or
legacy candidate is generated at inference time.  The second state is a
constant-factor O(N) extension of the same DP, not a post-hoc selector.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BOUNDED_PATH = HERE / "study-tree-dp-bounded-actions.py"
LOCAL_PATH = HERE / "study-tree-dp-local-mlp.py"
BOUNDED = load_module("qingzhou_dual_bounded", BOUNDED_PATH)
LOCAL = load_module("qingzhou_dual_local", LOCAL_PATH)
DISTILL = BOUNDED.DISTILL
GLOBAL_DISTILL = BOUNDED.GLOBAL_DISTILL
CHOICE = BOUNDED.GLOBAL
TRAINER = BOUNDED.TRAINER
ROOT_QUALITY = CHOICE.ROOT_QUALITY


@dataclass(frozen=True)
class ActionReference:
    mask: np.ndarray
    roots: list[int]
    kind: str
    mode: str
    retained_tokens: int


def root_page_from_logits(item, logits: np.ndarray):
    """Exact RootPage recurrence with caller-provided per-token logits."""
    page = item.page
    count = len(page.tokens)
    local = page.tokens * logits
    keep = np.zeros(count, dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(count)]
    kept_tokens = page.tokens.copy()
    kept_gold_tokens = page.tokens * page.gold_keep
    for index in range(count - 1, -1, -1):
        score = float(local[index])
        selected_tokens = float(page.tokens[index])
        selected_gold = float(page.tokens[index] if page.gold_keep[index] else 0.0)
        choices = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            choices.append(bool(retain))
            score += keep[child] if retain else excluded
            if retain:
                selected_tokens += kept_tokens[child]
                selected_gold += kept_gold_tokens[child]
        keep[index] = score
        keep_choice[index] = choices
        kept_tokens[index] = selected_tokens
        kept_gold_tokens[index] = selected_gold

    components = page.readability_root_scores
    evidence = components["evidence"]
    tag_prior = components["tag"]
    class_weight = components["class"]
    link_factor = components["link-factor"]
    raw = components["evidence-tag-class"]
    full = components["full"]
    page_tokens = max(1.0, float(page.tokens.sum()))
    tags = np.asarray(page.tags)
    features = np.column_stack([
        np.clip(
            (keep - TRAINER.ROOT_PENALTY) / np.maximum(20.0, kept_tokens),
            -4.0,
            4.0,
        ),
        np.log1p(kept_tokens),
        np.clip(kept_tokens / page_tokens, 0.0, 1.0),
        np.log1p(np.maximum(0.0, evidence)),
        tag_prior / 5.0,
        class_weight / 25.0,
        link_factor,
        np.clip(raw / 25.0, -4.0, 4.0),
        np.clip(full / 25.0, -4.0, 4.0),
        item.context[:, 0] / 3.0,
        item.context[:, 1],
        page.features[:, 10] / 3.0,
        page.features[:, 11] / 3.0,
        page.features[:, 12],
        page.features[:, 13],
        tags == "body",
        np.isin(tags, ["main", "article"]),
        tags == "section",
        tags == "div",
        np.isin(tags, ["p", "table"]),
    ]).astype(np.float64)
    feasible = np.asarray([
        tag not in TRAINER.DEPENDENT_ROOT_TAGS and kept_tokens[index] >= 20
        for index, tag in enumerate(page.tags)
    ], dtype=bool)
    gold_tokens = (
        float(page.tokens[page.gold_keep].sum())
        if page.status == "extract" else 0.0
    )
    precision = np.divide(
        kept_gold_tokens,
        kept_tokens,
        out=np.zeros_like(kept_tokens),
        where=kept_tokens > 0,
    )
    recall = (
        kept_gold_tokens / gold_tokens
        if gold_tokens else np.zeros_like(kept_tokens)
    )
    target = np.divide(
        2.0 * precision * recall,
        precision + recall,
        out=np.zeros_like(precision),
        where=(precision + recall) > 0,
    )
    target[~feasible] = 0.0
    return ROOT_QUALITY.RootPage(
        item,
        keep,
        keep_choice,
        kept_tokens,
        kept_gold_tokens,
        features,
        target,
        feasible,
    )


def nonlinear_root_teacher(item, beta, local_model, local_scaling, args):
    page = item.item.page
    with torch.no_grad():
        residual = local_model(
            LOCAL.normalized(LOCAL.feature_matrix(item), local_scaling)
        ).numpy()
    logits = LOCAL.base_logits(page, item.rich_context, beta) + residual
    rich_item = DISTILL.READABILITY.StudyPage(
        page=page,
        context=item.rich_context,
        corpus="zh",
    )
    root_page = root_page_from_logits(rich_item, logits)
    choice = CHOICE.build_choice_page_from_root_page(
        root_page, args.scope_prior_weight
    )
    teacher = GLOBAL_DISTILL.exact_teacher(item, "ensemble")
    teacher_quality = GLOBAL_DISTILL.root_teacher_quality(choice, teacher)
    return GLOBAL_DISTILL.RootTeacherPage(
        source=item,
        choice=choice,
        teacher_quality=teacher_quality,
        teacher_source_quality=(
            0.0 if teacher_quality is None else float(teacher.quality)
        ),
        teacher_key=(None if teacher_quality is None else teacher.key),
    )


def action_references(page, mode: str) -> list[ActionReference]:
    action = page.utility.relative.action
    result = []
    for roots, kind in zip(
        page.utility.roots, page.utility.kinds, strict=True
    ):
        mask = (
            action.baseline.mask.copy()
            if kind == "ordinary"
            else BOUNDED.GLOBAL.reconstruct(
                action.choice.root_page, int(roots[0])
            )
        )
        result.append(ActionReference(
            mask=mask,
            roots=list(roots),
            kind=kind,
            mode=mode,
            retained_tokens=int(action.source.tokens[mask].sum()),
        ))
    return result


def merge_teacher_targets(a, b, b_offsets):
    a_by_key = {key: (target, strength) for key, target, strength in a}
    b_by_key = {key: (target, strength) for key, target, strength in b}
    result = []
    for key in sorted(set(a_by_key) & set(b_by_key)):
        a_target, a_strength = a_by_key[key]
        b_target, b_strength = b_by_key[key]
        result.append((
            key,
            np.concatenate((a_target, b_target[b_offsets])),
            min(a_strength, b_strength),
        ))
    return result


def merge_states(linear, nonlinear):
    linear_refs = action_references(linear, "linear")
    nonlinear_refs = action_references(nonlinear, "nonlinear")
    seen = {reference.mask.tobytes() for reference in linear_refs}
    b_offsets = np.asarray([
        offset
        for offset, reference in enumerate(nonlinear_refs)
        if reference.mask.tobytes() not in seen
    ], dtype=np.int64)
    refs = [*linear_refs, *(nonlinear_refs[offset] for offset in b_offsets)]
    features = np.concatenate((
        np.column_stack((
            linear.features,
            np.zeros(len(linear.features), dtype=np.float64),
        )),
        np.column_stack((
            nonlinear.features[b_offsets],
            np.ones(len(b_offsets), dtype=np.float64),
        )),
    ))
    prior = np.concatenate((linear.prior, nonlinear.prior[b_offsets]))
    ordinary = np.concatenate((
        linear.ordinary,
        np.zeros(len(b_offsets), dtype=bool),
    ))
    a_utility = linear.utility
    b_utility = nonlinear.utility
    utility = SimpleNamespace(
        source=a_utility.source,
        relative=a_utility.relative,
        roots=[reference.roots for reference in refs],
        kinds=[reference.kind for reference in refs],
        precision=np.concatenate((
            a_utility.precision, b_utility.precision[b_offsets]
        )),
        recall=np.concatenate((
            a_utility.recall, b_utility.recall[b_offsets]
        )),
        f1=np.concatenate((a_utility.f1, b_utility.f1[b_offsets])),
    )
    result = BOUNDED.StructuredPage(
        utility=utility,
        features=features,
        prior=prior,
        ordinary=ordinary,
        teacher_targets=merge_teacher_targets(
            linear.teacher_targets,
            nonlinear.teacher_targets,
            b_offsets,
        ),
    )
    result.action_references = refs
    return result


def linear_page(item, beta, args):
    return BOUNDED.build_structured_page(
        GLOBAL_DISTILL.build_page(item, beta, "ensemble", args), args
    )


def dual_page(item, beta, local_model, local_scaling, args):
    return merge_states(
        linear_page(item, beta, args),
        BOUNDED.build_structured_page(
            nonlinear_root_teacher(
                item, beta, local_model, local_scaling, args
            ),
            args,
        ),
    )


def auxiliary_page(item, beta, args):
    page = BOUNDED.build_structured_page(
        GLOBAL_DISTILL.build_wcxb_page(item, beta, args), args
    )
    page.features = np.column_stack((
        page.features,
        np.zeros(len(page.features), dtype=np.float64),
    ))
    return page


def evaluate(page, model, scaling, args):
    action = page.utility.relative.action
    source = action.source
    if len(page.prior):
        with torch.no_grad():
            scores, empty_score, _, _ = model(
                *BOUNDED.page_tensors(page, scaling, args)
            )
        scores = scores.numpy()
        empty_score = float(empty_score)
        eligible = np.ones(len(scores), dtype=bool)
        if not action.baseline.available:
            retained = np.asarray([
                reference.retained_tokens
                for reference in page.action_references
            ])
            eligible = (
                (retained >= args.minimum_rescue_tokens)
                | (scores >= args.short_rescue_score)
            )
        if np.any(eligible):
            offsets = np.flatnonzero(eligible)
            selected = int(offsets[np.argmax(scores[eligible])])
            choose_empty = empty_score >= float(scores[selected])
        else:
            selected = int(np.argmax(scores))
            choose_empty = True
    else:
        scores = np.zeros(0)
        empty_score = 0.0
        selected = -1
        choose_empty = True
    if choose_empty:
        reference = None
        mask = np.zeros(len(source.tokens), dtype=bool)
        available = False
        selected_score = empty_score
    else:
        reference = page.action_references[selected]
        mask = reference.mask
        available = reference.retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
        selected_score = float(scores[selected])
    baseline = action.baseline
    baseline_text = (
        TRAINER.materialized_text(source, baseline.mask)
        if baseline.available else ""
    )
    candidate_text = (
        TRAINER.materialized_text(source, mask) if available else ""
    )
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.utility.source.product_f1 if source.status == "extract" else 0.0
    return {
        "id": source.id,
        "siteFamily": source.site_family,
        "split": source.split,
        "status": source.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "baselineAvailable": baseline.available,
        "candidateAvailable": available,
        "baselineRoots": baseline.roots,
        "candidateRoots": [] if reference is None else reference.roots,
        "candidateMode": None if reference is None else reference.mode,
        "candidateRetainedTokens": int(source.tokens[mask].sum()) if available else 0,
        "selectedAction": "empty" if reference is None else reference.kind,
        "selectedScore": selected_score,
        "emptyScore": empty_score,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.utility.source.product_available,
        "teacherKey": ",".join(
            key for key, _, _ in page.teacher_targets
        ) or None,
        "teacherSourceQuality": max(
            (strength for _, _, strength in page.teacher_targets),
            default=0.0,
        ),
    }


def local_args(args):
    return SimpleNamespace(
        scaling_nodes_per_page=args.local_scaling_nodes_per_page,
        hidden_width=args.local_hidden_width,
        residual_bound=args.local_residual_bound,
        learning_rate=args.local_learning_rate,
        weight_decay=args.local_weight_decay,
        epochs=args.local_epochs,
        batch_records=args.local_batch_records,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
        wmb_corpus_weight=args.wmb_corpus_weight,
        teacher_weight=args.teacher_weight,
    )


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--only-fold", type=int)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--residual-bound", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--tail-loss-margin", type=float, default=8.0)
    parser.add_argument("--tail-delta", type=float, default=0.10)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--teacher-loss-weight", type=float, default=0.15)
    parser.add_argument("--current-energy-prior", type=float, default=2.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--maximum-roots-per-page", type=int, default=128)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--minimum-rescue-tokens", type=int, default=64)
    parser.add_argument("--short-rescue-score", type=float, default=2.5)
    parser.add_argument("--local-epochs", type=int, default=12)
    parser.add_argument("--local-batch-records", type=int, default=32)
    parser.add_argument("--local-hidden-width", type=int, default=16)
    parser.add_argument("--local-residual-bound", type=float, default=2.0)
    parser.add_argument("--local-learning-rate", type=float, default=0.002)
    parser.add_argument("--local-weight-decay", type=float, default=0.01)
    parser.add_argument("--local-scaling-nodes-per-page", type=int, default=256)
    # Locked strong single-state settings expected by imported helpers.
    parser.set_defaults(
        page_context=False,
        canonicalize_same=False,
        readability_aggregates=False,
        teacher_mode="single-exact",
        fixed_empty_reference=False,
        action_validity=False,
        validity_loss_weight=1.0,
        product_floor_loss=True,
        incumbent_ranking_loss=False,
        incumbent_ranking_weight=1.0,
        incumbent_ranking_margin=1.0,
        adaptive_override=False,
        override_bound=6.0,
        override_penalty=0.05,
        site_balanced_training=False,
    )
    return parser.parse_args()


def main():
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = BOUNDED.RELATIVE.load_wmb_pages(args.wmb_units)
    wmb_train = [item for item in wmb if item.page.split == "wmb-train"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        if args.only_fold is not None and fold != args.only_fold:
            continue
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        local_model, local_scaling, local_history = LOCAL.train_model(
            train,
            wcxb_train,
            wmb_train,
            beta,
            local_args(args),
            25000 + fold,
        )
        train_pages = [
            dual_page(item, beta, local_model, local_scaling, args)
            for item in train
        ]
        test_pages = [
            dual_page(item, beta, local_model, local_scaling, args)
            for item in test
        ]
        wcxb_pages = [auxiliary_page(item, beta, args) for item in wcxb_train]
        wmb_pages = [auxiliary_page(item, beta, args) for item in wmb_train]
        model, scaling, history = BOUNDED.train_model(
            train_pages, wcxb_pages, wmb_pages, args, 26000 + fold
        )
        fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        summary = GLOBAL_DISTILL.summary(fold_rows)
        folds.append({
            "fold": fold,
            "summary": summary,
            "localHistory": local_history,
            "globalHistory": history,
        })
        print(json.dumps({"fold": fold, "summary": summary}, ensure_ascii=False), flush=True)
    summary = GLOBAL_DISTILL.summary(rows)
    report = {
        "schema": "qingzhou.tree-dp-dual-state-action-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeStates": ["rich-linear", "bounded-local-nonlinear"],
            "stateSelection": "one-global-action-energy",
            "readabilityUsage": "generic DOM features only",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "inferenceComplexity": "O(2*N*localWidth + actions*globalWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "boundedStudySha256": TRAINER.sha256_file(BOUNDED_PATH),
            "localStudySha256": TRAINER.sha256_file(LOCAL_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
