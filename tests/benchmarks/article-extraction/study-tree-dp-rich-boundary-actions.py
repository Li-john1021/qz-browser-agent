#!/usr/bin/env python3
"""Fit one Tree-DP with rich token scores and zero-text boundary energy.

Readability's useful class/role evidence often lives on structural wrappers
whose own token count is zero.  A purely token-weighted block scorer cannot
use that evidence to alter keep/carve decisions.  This benchmark composes two
parts into one local Tree-DP energy:

* the existing rich linear per-token score; and
* a small, sign-constrained Readability boundary residual on every element.

The resulting keep/carve state is then consumed by the existing bounded
page-action objective.  Inference is still one DOM, one scorer and one
Tree-DP; no Readability candidate or post-hoc selector is constructed.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
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
BOUNDARY_PATH = HERE / "study-tree-dp-readability-boundaries.py"
BOUNDED = load_module("qingzhou_rich_boundary_bounded", BOUNDED_PATH)
BOUNDARY = load_module("qingzhou_rich_boundary_local", BOUNDARY_PATH)

DISTILL = BOUNDED.DISTILL
GLOBAL_DISTILL = BOUNDED.GLOBAL_DISTILL
GLOBAL = BOUNDED.GLOBAL
ROOT_QUALITY = GLOBAL.ROOT_QUALITY
RELATIVE = BOUNDED.RELATIVE
TRAINER = BOUNDED.TRAINER


def parse_args():
    boundary = argparse.ArgumentParser(add_help=False)
    boundary.add_argument(
        "--boundary-feature-set",
        choices=sorted(BOUNDARY.FEATURE_SETS),
        default="core",
    )
    boundary.add_argument("--boundary-epochs", type=int, default=12)
    boundary.add_argument("--boundary-learning-rate", type=float, default=0.05)
    boundary.add_argument("--boundary-regularization", type=float, default=0.25)
    boundary.add_argument("--boundary-false-positive-cost", type=float, default=1.25)
    boundary.add_argument("--boundary-false-negative-cost", type=float, default=0.75)
    boundary.add_argument(
        "--boundary-parameter-cap",
        type=float,
        default=1.0 / BOUNDARY.FEATURE_SCALE,
    )
    boundary.add_argument(
        "--boundary-only",
        action="store_true",
        help="evaluate the combined local Tree-DP without the page-action model",
    )
    known, remaining = boundary.parse_known_args()
    original = sys.argv
    try:
        sys.argv = [original[0], *remaining]
        args = BOUNDED.parse_args()
    finally:
        sys.argv = original
    for key, value in vars(known).items():
        setattr(args, key, value)
    return args


def study_item(item, corpus: str):
    if hasattr(item, "rich_context"):
        return DISTILL.READABILITY.StudyPage(
            page=item.item.page,
            context=item.rich_context,
            corpus=corpus,
        )
    return item


def rich_base_energy(item, beta: np.ndarray) -> np.ndarray:
    page = item.page
    return page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + item.context @ beta
    )


def boundary_page(item, beta: np.ndarray, feature_set: str):
    return BOUNDARY.BoundaryPage(
        page=item.page,
        features=BOUNDARY.boundary_features(item.page, feature_set),
        base_energy=rich_base_energy(item, beta),
    )


def fit_boundary(items, beta: np.ndarray, args):
    feature_indices = BOUNDARY.FEATURE_SETS[args.boundary_feature_set]
    feature_names = [
        BOUNDARY.ALL_FEATURE_NAMES[index] for index in feature_indices
    ]
    pages = [
        boundary_page(study_item(item, "zh"), beta, args.boundary_feature_set)
        for item in items
    ]
    model = BOUNDARY.train(
        pages,
        feature_names=feature_names,
        epochs=args.boundary_epochs,
        learning_rate=args.boundary_learning_rate,
        regularization=args.boundary_regularization,
        false_positive_cost=args.boundary_false_positive_cost,
        false_negative_cost=args.boundary_false_negative_cost,
        nonnegative=False,
        semantic_sign_constraints=True,
        semantic_parameter_cap=args.boundary_parameter_cap,
        legal_roots=True,
    )
    return model, feature_names


def rebuild_root_page(item, beta: np.ndarray, gamma: np.ndarray, feature_set: str):
    """Recompute the exact keep/carve state from one combined local energy."""
    root_page = ROOT_QUALITY.build_root_page(item, beta)
    page = item.page
    local = (
        rich_base_energy(item, beta)
        + BOUNDARY.boundary_features(page, feature_set) @ gamma
    )
    total = len(page.tokens)
    keep = np.zeros(total, dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(total)]
    kept_tokens = page.tokens.copy()
    kept_gold_tokens = page.tokens * page.gold_keep
    for index in range(total - 1, -1, -1):
        score = float(local[index])
        selected_tokens = float(page.tokens[index])
        selected_gold = float(page.tokens[index] if page.gold_keep[index] else 0.0)
        choices = []
        for child in page.children[index]:
            excluded = BOUNDARY.exclusion_energy(page, child)
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

    features = root_page.features.copy()
    page_tokens = max(1.0, float(page.tokens.sum()))
    features[:, 0] = np.clip(
        (keep - TRAINER.ROOT_PENALTY) / np.maximum(20.0, kept_tokens),
        -4.0,
        4.0,
    )
    features[:, 1] = np.log1p(kept_tokens)
    features[:, 2] = np.clip(kept_tokens / page_tokens, 0.0, 1.0)
    feasible = np.asarray([
        tag not in TRAINER.DEPENDENT_ROOT_TAGS
        and kept_tokens[index] >= TRAINER.MIN_RETAINED_TOKENS
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
        item=item,
        keep=keep,
        keep_choice=keep_choice,
        kept_tokens=kept_tokens,
        kept_gold_tokens=kept_gold_tokens,
        features=features,
        target=target,
        feasible=feasible,
    )


def build_zh_page(item, beta, gamma, args):
    local_item = study_item(item, "zh")
    root_page = rebuild_root_page(
        local_item, beta, gamma, args.boundary_feature_set
    )
    choice = GLOBAL.build_choice_page_from_root_page(
        root_page, args.scope_prior_weight
    )
    teacher = GLOBAL_DISTILL.exact_teacher(item, "ensemble")
    quality = GLOBAL_DISTILL.root_teacher_quality(choice, teacher)
    return GLOBAL_DISTILL.RootTeacherPage(
        source=item,
        choice=choice,
        teacher_quality=quality,
        teacher_source_quality=(
            0.0 if quality is None else float(teacher.quality)
        ),
        teacher_key=None if quality is None else teacher.key,
    )


def build_wcxb_page(item, beta, gamma, args):
    root_page = rebuild_root_page(
        item, beta, gamma, args.boundary_feature_set
    )
    choice = GLOBAL.build_choice_page_from_root_page(
        root_page, args.scope_prior_weight
    )
    return GLOBAL_DISTILL.RootTeacherPage(
        source=None,
        choice=choice,
        teacher_quality=None,
        teacher_source_quality=0.0,
        teacher_key=None,
    )


def shipped_result(source):
    decoded = TRAINER.decode(source, TRAINER.CURRENT_THETA)
    text = TRAINER.materialized_text(source, decoded.mask) if decoded.available else ""
    return decoded, TRAINER.trigram_f1(text, source.reference)


def evaluate(page, model, scaling, args):
    row = BOUNDED.evaluate(page, model, scaling, args)
    source = page.utility.relative.action.source
    shipped, shipped_quality = shipped_result(source)
    row["richBoundaryOrdinary"] = row["baseline"]
    row["deltaVsRichBoundaryOrdinary"] = row["delta"]
    row["richBoundaryOrdinaryAvailable"] = row["baselineAvailable"]
    row["richBoundaryOrdinaryRoots"] = row["baselineRoots"]
    row["richBoundaryOrdinaryRetainedTokens"] = row["baselineRetainedTokens"]
    row["baseline"] = shipped_quality
    row["baselineAvailable"] = shipped.available
    row["baselineRoots"] = shipped.roots
    row["baselineRetainedTokens"] = shipped.retained_tokens
    row["delta"] = row["candidate"] - row["baseline"]
    return row


def build_pages(items, beta, gamma, args):
    return [
        BOUNDED.build_structured_page(
            build_zh_page(item, beta, gamma, args), args
        )
        for item in items
    ]


def evaluate_boundary_ordinary(item, beta, gamma, args):
    source = item.item.page
    root_page = rebuild_root_page(
        study_item(item, "zh"), beta, gamma, args.boundary_feature_set
    )
    candidate = ROOT_QUALITY.decode(
        root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    shipped, baseline_f1 = shipped_result(source)
    candidate_text = (
        TRAINER.materialized_text(source, candidate.mask)
        if candidate.available else ""
    )
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = item.product_f1 if source.status == "extract" else 0.0
    return {
        "id": source.id,
        "siteFamily": source.site_family,
        "split": source.split,
        "status": source.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "baselineAvailable": shipped.available,
        "candidateAvailable": candidate.available,
        "baselineRoots": shipped.roots,
        "candidateRoots": candidate.roots,
        "baselineRetainedTokens": shipped.retained_tokens,
        "candidateRetainedTokens": candidate.retained_tokens,
        "selectedAction": "ordinary",
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": item.product_available,
        "teacherKey": None,
        "teacherSourceQuality": 0.0,
    }


def main():
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = [] if args.boundary_only else RELATIVE.load_wmb_pages(args.wmb_units)
    wmb_train = [item for item in wmb if item.page.split == "wmb-train"]
    wmb_holdout = [item for item in wmb if item.page.split == "wmb-holdout"]
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
        boundary_model, boundary_names = fit_boundary(train, beta, args)
        gamma = boundary_model.parameters
        if args.boundary_only:
            fold_rows = [
                evaluate_boundary_ordinary(item, beta, gamma, args)
                for item in test
            ]
            rows.extend(fold_rows)
            summary = GLOBAL_DISTILL.summary(fold_rows)
            folds.append({
                "fold": fold,
                "summaryVsShipped": summary,
                "boundaryFeatureNames": boundary_names,
                "boundaryGamma": gamma.tolist(),
                "boundaryHistory": boundary_model.history,
            })
            print(json.dumps({"fold": fold, "vsShipped": summary}, ensure_ascii=False), flush=True)
            continue

        train_pages = build_pages(train, beta, gamma, args)
        test_pages = build_pages(test, beta, gamma, args)
        wcxb_pages = [
            BOUNDED.build_structured_page(
                build_wcxb_page(item, beta, gamma, args), args
            )
            for item in wcxb_train
        ]
        wmb_pages = [
            BOUNDED.build_structured_page(
                RELATIVE.build_wmb_page(item, beta, args), args
            )
            for item in wmb_train
        ]
        model, scaling, history = BOUNDED.train_model(
            train_pages, wcxb_pages, wmb_pages, args, 19000 + fold
        )
        fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        summary = GLOBAL_DISTILL.summary(fold_rows)
        action_summary = GLOBAL_DISTILL.summary([
            row | {
                "baseline": row["richBoundaryOrdinary"],
                "delta": row["deltaVsRichBoundaryOrdinary"],
            }
            for row in fold_rows
        ])
        folds.append({
            "fold": fold,
            "summaryVsShipped": summary,
            "summaryVsRichBoundaryOrdinary": action_summary,
            "history": history,
            "model": {
                name: value.detach().numpy().tolist()
                for name, value in model.state_dict().items()
            },
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "localBeta": beta.tolist(),
            "boundaryFeatureNames": boundary_names,
            "boundaryGamma": gamma.tolist(),
            "boundaryHistory": boundary_model.history,
        })
        print(json.dumps({
            "fold": fold,
            "vsShipped": summary,
            "vsRichBoundaryOrdinary": action_summary,
        }, ensure_ascii=False), flush=True)

    validation_report = None
    if args.zh_validation_units is not None:
        validation, validation_audit = DISTILL.load_pages(
            args,
            directory=args.zh_validation_units,
            allowed_splits=frozenset({"validation"}),
        )
        beta = DISTILL.fit_increment(pages, wcxb_train, "ensemble", args)
        boundary_model, boundary_names = fit_boundary(pages, beta, args)
        gamma = boundary_model.parameters
        if args.boundary_only:
            validation_rows = [
                evaluate_boundary_ordinary(item, beta, gamma, args)
                for item in validation
            ]
            validation_report = {
                "summaryVsShipped": GLOBAL_DISTILL.summary(validation_rows),
                "rows": validation_rows,
                "audit": validation_audit,
                "localBeta": beta.tolist(),
                "boundaryFeatureNames": boundary_names,
                "boundaryGamma": gamma.tolist(),
                "boundaryHistory": boundary_model.history,
            }
        else:
            train_pages = build_pages(pages, beta, gamma, args)
            validation_pages = build_pages(validation, beta, gamma, args)
            wcxb_pages = [
                BOUNDED.build_structured_page(
                    build_wcxb_page(item, beta, gamma, args), args
                )
                for item in wcxb_train
            ]
            wmb_pages = [
                BOUNDED.build_structured_page(
                    RELATIVE.build_wmb_page(item, beta, args), args
                )
                for item in wmb_train
            ]
            model, scaling, history = BOUNDED.train_model(
                train_pages, wcxb_pages, wmb_pages, args, 19999
            )
            validation_rows = [
                evaluate(page, model, scaling, args) for page in validation_pages
            ]
            validation_report = {
                "summaryVsShipped": GLOBAL_DISTILL.summary(validation_rows),
                "summaryVsRichBoundaryOrdinary": GLOBAL_DISTILL.summary([
                    row | {
                        "baseline": row["richBoundaryOrdinary"],
                        "delta": row["deltaVsRichBoundaryOrdinary"],
                    }
                    for row in validation_rows
                ]),
                "rows": validation_rows,
                "audit": validation_audit,
                "history": history,
                "model": {
                    name: value.detach().numpy().tolist()
                    for name, value in model.state_dict().items()
                },
                "scalingMean": scaling.mean.tolist(),
                "scalingScale": scaling.scale.tolist(),
                "localBeta": beta.tolist(),
                "boundaryFeatureNames": boundary_names,
                "boundaryGamma": gamma.tolist(),
                "boundaryHistory": boundary_model.history,
            }

    report = {
        "schema": "qingzhou.tree-dp-rich-boundary-action-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily GroupKFold",
            "runtimeCandidates": False,
            "localEnergy": "rich-token-linear + bounded-zero-token-boundary",
            "pageActionModel": not args.boundary_only,
            "boundaryFeatureSet": args.boundary_feature_set,
            "boundarySignConstrained": True,
            "readabilityCandidateAtInference": False,
            "zhValidationOpened": args.zh_validation_units is not None,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "inferenceComplexity": "O(nodes * hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {
            "summaryVsShipped": GLOBAL_DISTILL.summary(rows),
            "summaryVsRichBoundaryOrdinary": (
                None if args.boundary_only else GLOBAL_DISTILL.summary([
                    row | {
                        "baseline": row["richBoundaryOrdinary"],
                        "delta": row["deltaVsRichBoundaryOrdinary"],
                    }
                    for row in rows
                ])
            ),
            "rows": rows,
            "folds": folds,
        },
        "zhValidation": validation_report,
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "boundedStudySha256": TRAINER.sha256_file(BOUNDED_PATH),
            "boundaryStudySha256": TRAINER.sha256_file(BOUNDARY_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({
        "output": str(args.output),
        "summary": report["siteFamilyOof"]["summaryVsShipped"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
