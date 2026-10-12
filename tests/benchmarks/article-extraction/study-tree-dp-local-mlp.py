#!/usr/bin/env python3
"""Bounded nonlinear local scorer for the single Tree-DP extractor.

Readability's generic signals are already present in the rich feature schema,
but the accepted v7 block scorer can combine them only linearly.  This study
adds a small bounded MLP residual around v7 so interactions such as class ×
link-density and paragraph-evidence × ancestor semantics become expressible.

Human masks, WCXB masks and tri-state candidate provenance train the same local
loss.  The last layer starts at zero, making the initial model exactly v7.
Inference generates no legacy candidates and remains O(N * hidden_width).
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as functional
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


DISTILL_PATH = HERE / "study-tree-dp-candidate-distillation.py"
DISTILL = load_module("qingzhou_local_mlp_data", DISTILL_PATH)
READABILITY = DISTILL.READABILITY
TRAINER = DISTILL.TRAINER


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


@dataclass
class LocalDecode:
    mask: np.ndarray
    roots: list[int]
    available: bool
    retained_tokens: int


class LocalResidual(torch.nn.Module):
    def __init__(self, dimensions: int, width: int, residual_bound: float):
        super().__init__()
        self.residual_bound = residual_bound
        self.network = torch.nn.Sequential(
            torch.nn.Linear(dimensions, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        torch.nn.init.zeros_(self.network[-1].weight)
        torch.nn.init.zeros_(self.network[-1].bias)

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        raw = self.network(features).squeeze(-1)
        return self.residual_bound * torch.tanh(raw / self.residual_bound)


def feature_matrix(item) -> np.ndarray:
    return np.column_stack([item.item.page.features, item.rich_context]).astype(np.float64)


def wcxb_feature_matrix(item) -> np.ndarray:
    return np.column_stack([item.page.features, item.context]).astype(np.float64)


def fit_scaling(zh_pages, wcxb_pages, wmb_pages, maximum_per_page: int) -> Scaling:
    rows = []
    for item, matrix, page in [
        *((item, feature_matrix(item), item.item.page) for item in zh_pages),
        *((item, wcxb_feature_matrix(item), item.page) for item in wcxb_pages),
        *((item, wcxb_feature_matrix(item), item.page) for item in wmb_pages),
    ]:
        selected = np.flatnonzero((page.tokens > 0) & page.gold_known)
        if len(selected) > maximum_per_page:
            positive = selected[page.gold_keep[selected]]
            negative = selected[~page.gold_keep[selected]]
            half = maximum_per_page // 2
            positive = positive[np.linspace(0, len(positive) - 1, min(half, len(positive)), dtype=int)] if len(positive) else positive
            remaining = maximum_per_page - len(positive)
            negative = negative[np.linspace(0, len(negative) - 1, min(remaining, len(negative)), dtype=int)] if len(negative) else negative
            selected = np.unique(np.concatenate([positive, negative]))
        if len(selected):
            rows.append(matrix[selected])
    if not rows:
        raise ValueError("no token-bearing local features")
    values = np.concatenate(rows)
    mean = values.mean(axis=0)
    scale = values.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def normalized(matrix: np.ndarray, scaling: Scaling) -> torch.Tensor:
    values = np.clip((matrix - scaling.mean) / scaling.scale, -8.0, 8.0)
    return torch.as_tensor(values, dtype=torch.float32)


def base_logits(page, rich_context: np.ndarray, beta: np.ndarray) -> np.ndarray:
    return (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + rich_context @ beta
    )


def human_record(item, beta, scaling, weight):
    page = item.item.page
    selected = (page.tokens > 0) & page.gold_known
    if not np.any(selected):
        return None
    node_weight = page.tokens[selected].astype(np.float64)
    node_weight /= max(1.0, float(node_weight.sum()))
    return (
        normalized(feature_matrix(item)[selected], scaling),
        torch.as_tensor(base_logits(page, item.rich_context, beta)[selected], dtype=torch.float32),
        torch.as_tensor(page.gold_keep[selected].astype(np.float32)),
        torch.as_tensor(node_weight, dtype=torch.float32),
        weight,
    )


def wcxb_record(item, beta, scaling, weight):
    page = item.page
    selected = (page.tokens > 0) & page.gold_known
    if not np.any(selected):
        return None
    node_weight = page.tokens[selected].astype(np.float64)
    node_weight /= max(1.0, float(node_weight.sum()))
    return (
        normalized(wcxb_feature_matrix(item)[selected], scaling),
        torch.as_tensor(base_logits(page, item.context, beta,)[selected], dtype=torch.float32),
        torch.as_tensor(page.gold_keep[selected].astype(np.float32)),
        torch.as_tensor(node_weight, dtype=torch.float32),
        weight,
    )


def teacher_records(item, beta, scaling, total_weight):
    page = item.item.page
    matrix = feature_matrix(item)
    offset = base_logits(page, item.rich_context, beta)
    result = []
    teachers = item.ensemble_teachers
    denominator = sum(max(0.0, teacher.quality) for teacher in teachers)
    if denominator <= 0:
        return result
    for teacher in teachers:
        selected = (page.tokens > 0) & teacher.known
        if not np.any(selected):
            continue
        node_weight = page.tokens[selected].astype(np.float64)
        node_weight /= max(1.0, float(node_weight.sum()))
        result.append((
            normalized(matrix[selected], scaling),
            torch.as_tensor(offset[selected], dtype=torch.float32),
            torch.as_tensor(teacher.keep[selected].astype(np.float32)),
            torch.as_tensor(node_weight, dtype=torch.float32),
            total_weight * teacher.quality / denominator,
        ))
    return result


def train_model(zh_pages, wcxb_pages, wmb_pages, beta, args, seed):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling(
        zh_pages, wcxb_pages, wmb_pages, args.scaling_nodes_per_page
    )
    model = LocalResidual(
        16 + len(DISTILL.RICH_FEATURE_NAMES),
        args.hidden_width,
        args.residual_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    records = []
    human_weight = 1.0 / max(1, len(zh_pages))
    for item in zh_pages:
        record = human_record(item, beta, scaling, human_weight)
        if record is not None:
            records.append(record)
    wcxb_weight = args.wcxb_corpus_weight / max(1, len(wcxb_pages))
    for item in wcxb_pages:
        record = wcxb_record(item, beta, scaling, wcxb_weight)
        if record is not None:
            records.append(record)
    wmb_weight = args.wmb_corpus_weight / max(1, len(wmb_pages))
    for item in wmb_pages:
        record = wcxb_record(item, beta, scaling, wmb_weight)
        if record is not None:
            records.append(record)
    candidate_pages = [item for item in zh_pages if item.ensemble_teachers]
    teacher_page_weight = args.teacher_weight / max(1, len(candidate_pages))
    for item in candidate_pages:
        records.extend(teacher_records(item, beta, scaling, teacher_page_weight))

    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(records)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        count = 0
        epoch_loss = 0.0
        for features, offset, target, node_weight, record_weight in records:
            logits = offset + model(features)
            loss = record_weight * torch.sum(
                node_weight
                * functional.binary_cross_entropy_with_logits(
                    logits, target, reduction="none"
                )
            )
            batch = batch + loss
            epoch_loss += float(loss.detach())
            count += 1
            if count == args.batch_records:
                batch.backward()
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                batch = torch.zeros((), dtype=torch.float32)
                count = 0
        if count:
            batch.backward()
            optimizer.step()
        history.append({"epoch": epoch, "loss": epoch_loss})
    return model, scaling, history


def decode_logits(
    page,
    logits: np.ndarray,
    root_weight: float,
    fixed_roots: list[int] | None = None,
) -> LocalDecode:
    total = len(page.tokens)
    local = page.tokens * logits
    root_score = page.readability_root_scores["evidence-tag-class"]
    keep = np.zeros(total, dtype=np.float64)
    plain_free = np.zeros(total, dtype=np.float64)
    prior_free = np.zeros(total, dtype=np.float64)
    keep_choice = [[] for _ in range(total)]
    plain_root = np.zeros(total, dtype=bool)
    prior_mode = np.full(total, -1, dtype=np.int64)
    for index in range(total - 1, -1, -1):
        kept = float(local[index])
        choices = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0, page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS
            )
            retain = keep[child] >= excluded
            kept += keep[child] if retain else excluded
            choices.append(bool(retain))
        keep[index] = kept
        keep_choice[index] = choices
        descend = sum(plain_free[child] for child in page.children[index])
        root_allowed = page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
        as_root = kept - TRAINER.ROOT_PENALTY if root_allowed else -np.inf
        if as_root >= descend and as_root > 0:
            plain_free[index] = as_root
            plain_root[index] = True
        else:
            plain_free[index] = max(0.0, descend)
        prior_free[index] = plain_free[index]
        prior_as_root = as_root + root_weight * root_score[index]
        if prior_as_root >= prior_free[index] and prior_as_root > 0:
            prior_free[index] = prior_as_root
            prior_mode[index] = -2
        for child in page.children[index]:
            child_prior = descend - plain_free[child] + prior_free[child]
            if child_prior > prior_free[index] + 1e-12:
                prior_free[index] = child_prior
                prior_mode[index] = child

    retained = np.zeros(total, dtype=bool)
    roots = []
    if fixed_roots is not None:
        roots = list(fixed_roots)
        keep_stack = list(reversed(roots))
        while keep_stack:
            current = keep_stack.pop()
            retained[current] = True
            for offset, child in enumerate(page.children[current]):
                if keep_choice[current][offset]:
                    keep_stack.append(child)
    else:
        stack = [(0, True)]
        while stack:
            index, use_prior = stack.pop()
            mode = prior_mode[index] if use_prior else -1
            select_root = mode == -2 or (mode == -1 and plain_root[index])
            if select_root:
                roots.append(index)
                keep_stack = [index]
                while keep_stack:
                    current = keep_stack.pop()
                    retained[current] = True
                    for offset, child in enumerate(page.children[current]):
                        if keep_choice[current][offset]:
                            keep_stack.append(child)
            else:
                prior_child = mode if use_prior and mode >= 0 else None
                stack.extend(
                    (child, child == prior_child) for child in page.children[index]
                )
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS and not any(
        page.tags[root] in TRAINER.DEPENDENT_ROOT_TAGS for root in roots
    )
    return LocalDecode(retained, roots, available, retained_tokens)


def evaluate(item, beta, model, scaling, args):
    page = item.item.page
    with torch.no_grad():
        residual = model(normalized(feature_matrix(item), scaling)).numpy()
    logits = base_logits(page, item.rich_context, beta) + residual
    baseline = READABILITY.decode(
        READABILITY.StudyPage(page, item.rich_context, "zh"),
        beta,
        args.root_weight,
    )
    candidate = decode_logits(
        page,
        logits,
        args.root_weight,
        fixed_roots=baseline.roots if args.fixed_root_boundaries else None,
    )
    # A root state is materializable only with the same minimum retained-text
    # invariant as the ordinary DP.  Membership learning cannot turn a valid
    # selected root into an empty answer.
    if args.fixed_root_boundaries and baseline.available and not candidate.available:
        candidate = LocalDecode(
            baseline.mask.copy(),
            list(baseline.roots),
            True,
            baseline.retained_tokens,
        )
    baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(page, candidate.mask) if candidate.available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, page.reference) if page.status == "extract" else 0.0
    candidate_f1 = TRAINER.trigram_f1(candidate_text, page.reference) if page.status == "extract" else 0.0
    return {
        "id": page.id,
        "siteFamily": page.site_family,
        "split": page.split,
        "status": page.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "product": item.product_f1 if page.status == "extract" else 0.0,
        "deltaVsProduct": candidate_f1 - (item.product_f1 if page.status == "extract" else 0.0),
        "baselineAvailable": baseline.available,
        "candidateAvailable": candidate.available,
        "productAvailable": item.product_available,
        "baselineRoots": baseline.roots,
        "candidateRoots": candidate.roots,
    }


def evaluate_auxiliary(item, beta, model, scaling, args):
    page = item.page
    with torch.no_grad():
        residual = model(normalized(wcxb_feature_matrix(item), scaling)).numpy()
    logits = base_logits(page, item.context, beta) + residual
    baseline = READABILITY.decode(item, beta, args.root_weight)
    candidate = decode_logits(
        page,
        logits,
        args.root_weight,
        fixed_roots=baseline.roots if args.fixed_root_boundaries else None,
    )
    if args.fixed_root_boundaries and baseline.available and not candidate.available:
        candidate = LocalDecode(
            baseline.mask.copy(), list(baseline.roots), True, baseline.retained_tokens
        )
    baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(page, candidate.mask) if candidate.available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, page.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, page.reference)
    return {
        "id": page.id,
        "siteFamily": page.site_family,
        "split": page.split,
        "status": page.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "product": baseline_f1,
        "deltaVsProduct": candidate_f1 - baseline_f1,
        "baselineAvailable": baseline.available,
        "candidateAvailable": candidate.available,
        "productAvailable": baseline.available,
        "baselineRoots": baseline.roots,
        "candidateRoots": candidate.roots,
    }


def read_gzip_json(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf8") as handle:
        return json.load(handle)


def load_wmb_pages(directory: Path) -> list[object]:
    report_path = directory / "export-report.json"
    if not report_path.exists():
        raise ValueError(f"WebMainBench export is incomplete: {report_path} is missing")
    report = json.loads(report_path.read_text(encoding="utf8"))
    if report.get("schema") != "qingzhou.webmainbench-tree-dp-training-export.v1":
        raise ValueError(f"unexpected WebMainBench export schema: {report.get('schema')}")
    paths = sorted(directory.glob("*.json.gz"))
    if report.get("exported") != len(paths):
        raise ValueError(
            f"WebMainBench export file count mismatch: {len(paths)} != {report.get('exported')}"
        )
    result = []
    for path in paths:
        record = read_gzip_json(path)
        split = record.get("split")
        if split not in {"wmb-train", "wmb-holdout"}:
            raise ValueError(f"{record.get('id')}: refusing WebMainBench split {split}")
        if record.get("sourceSha256") != report.get("sourceSha256"):
            raise ValueError(f"{record.get('id')}: source provenance differs from export report")
        page = TRAINER.page_from_record(record, {split})
        tree = record["tree"]["treeElements"]
        result.append(READABILITY.StudyPage(
            page=page,
            context=DISTILL.rich_context(tree, page),
            corpus="wmb",
        ))
    return result


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-records", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--residual-bound", type=float, default=2.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--scaling-nodes-per-page", type=int, default=256)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--root-weight", type=float, default=0.25)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--fixed-root-boundaries", action="store_true")
    parser.add_argument("--only-fold", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = load_wmb_pages(args.wmb_units) if args.wmb_units else []
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
        model, scaling, history = train_model(
            train, wcxb_train, wmb_train, beta, args, 15000 + fold
        )
        fold_rows = [evaluate(item, beta, model, scaling, args) for item in test]
        rows.extend(fold_rows)
        folds.append({
            "fold": fold,
            "summary": DISTILL.summarize(fold_rows),
            "beta": beta.tolist(),
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "model": {
                name: value.detach().numpy().tolist()
                for name, value in model.state_dict().items()
            },
            "history": history,
        })
        print(json.dumps({"fold": fold, "summary": folds[-1]["summary"]}, ensure_ascii=False), flush=True)
    summary = DISTILL.summarize(rows)
    final_beta = None
    final_model = None
    final_scaling = None
    final_history = []
    wcxb_holdout_rows = []
    wmb_holdout_rows = []
    if args.only_fold is None:
        final_beta = DISTILL.fit_increment(pages, wcxb_train, "ensemble", args)
        final_model, final_scaling, final_history = train_model(
            pages, wcxb_train, wmb_train, final_beta, args, 16000
        )
        wcxb_holdout = [item for item in wcxb if item.page.split == "wcxb-holdout"]
        wcxb_holdout_rows = [
            evaluate_auxiliary(item, final_beta, final_model, final_scaling, args)
            for item in wcxb_holdout
        ]
        wmb_holdout_rows = [
            evaluate_auxiliary(item, final_beta, final_model, final_scaling, args)
            for item in wmb_holdout
        ]
    report = {
        "schema": "qingzhou.tree-dp-local-mlp-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-bounded-local-mlp-residual-plus-tree-dp",
            "rootMembershipSeparation": (
                "v7-root-boundaries-with-learned-keep-carve"
                if args.fixed_root_boundaries
                else "coupled-local-and-root-energy"
            ),
            "initialModel": "exact-v7-rich-linear-scorer",
            "humanPageWeighting": "one-page-unit-token-weighted-within-page",
            "candidateEvidence": "training-only-exact-or-positive-only-tristate",
            "unknownEvidence": "skipped-not-negative",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "wmbCorpusRole": "training-regularizer-and-domain-held-out-diagnostic",
            "featureNames": [
                *[f"shippedFeature{index}" for index in range(16)],
                *DISTILL.RICH_FEATURE_NAMES,
            ],
            "inferenceComplexity": "O(N*hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "auxiliaryHoldout": {
            "wcxbDevDomainHoldout": {
                "summary": DISTILL.summarize(wcxb_holdout_rows),
                "rows": wcxb_holdout_rows,
            },
            "webMainBenchDomainHoldout": {
                "summary": DISTILL.summarize(wmb_holdout_rows) if wmb_holdout_rows else None,
                "rows": wmb_holdout_rows,
            },
        },
        "finalModel": None if final_model is None else {
            "beta": final_beta.tolist(),
            "scalingMean": final_scaling.mean.tolist(),
            "scalingScale": final_scaling.scale.tolist(),
            "state": {
                name: value.detach().numpy().tolist()
                for name, value in final_model.state_dict().items()
            },
            "history": final_history,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "candidateDistillationStudySha256": TRAINER.sha256_file(DISTILL_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
