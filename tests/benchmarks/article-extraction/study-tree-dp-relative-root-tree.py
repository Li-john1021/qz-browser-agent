#!/usr/bin/env python3
"""Quantile tree for the relative root state of one Tree-DP model.

The shipped keep/carve recurrence remains fixed.  A small histogram tree
predicts the lower-quantile quality gain of every legal root over the ordinary
Tree-DP forest on the same page.  Only a strictly positive lower bound may
replace that forest.  Readability-derived evidence is therefore consumed as
generic root features; no Readability candidate exists at inference time.

This is a benchmark-only capacity study.  Chinese validation/test and the
multilingual holdouts remain unopened.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
RELATIVE_PATH = HERE / "study-tree-dp-relative-root.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_relative_root_tree_base", RELATIVE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {RELATIVE_PATH}")
RELATIVE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RELATIVE
SPEC.loader.exec_module(RELATIVE)
GLOBAL = RELATIVE.GLOBAL
DISTILL = RELATIVE.DISTILL
GLOBAL_DISTILL = RELATIVE.GLOBAL_DISTILL
TRAINER = RELATIVE.TRAINER


def sampled_offsets(page, maximum: int) -> np.ndarray:
    count = len(page.choice.indices)
    if count <= maximum:
        return np.arange(count, dtype=np.int64)
    choice = page.choice
    target = choice.quality - choice.baseline_quality
    buckets = [
        np.argsort(choice.current_energy[choice.indices])[-maximum // 4 :],
        np.argsort(target)[-maximum // 4 :],
        np.argsort(choice.root_page.kept_tokens[choice.indices])[-maximum // 4 :],
        np.linspace(0, count - 1, maximum // 4, dtype=np.int64),
    ]
    selected = np.unique(np.concatenate(buckets))
    if len(selected) < maximum:
        missing = np.setdiff1d(np.arange(count), selected, assume_unique=True)
        selected = np.concatenate([selected, missing[: maximum - len(selected)]])
    return np.sort(selected[:maximum])


def model_features(page) -> np.ndarray:
    choice = page.choice
    # energy_offset is page-normalized and cannot grow with DOM size.  The
    # remaining columns are generic node/subtree/Readability evidence.
    return np.column_stack([choice.features, choice.energy_offset]).astype(np.float64)


def training_matrix(pages, maximum_roots: int):
    matrices = []
    targets = []
    weights = []
    for page in pages:
        choice = page.choice
        if not len(choice.indices):
            continue
        offsets = sampled_offsets(page, maximum_roots)
        matrix = model_features(page)[offsets]
        if choice.root_page.item.page.status == "exclude":
            target = np.full(len(offsets), -1.0, dtype=np.float64)
        else:
            target = choice.quality[offsets] - choice.baseline_quality
        # Every page has unit mass.  Emphasize consequential alternatives,
        # without allowing a large DOM to become thousands of training pages.
        weight = 0.10 + np.abs(target)
        weight /= max(1e-12, float(weight.sum()))
        matrices.append(matrix)
        targets.append(target)
        weights.append(weight)
    if not matrices:
        raise ValueError("no legal root candidates")
    return (
        np.concatenate(matrices),
        np.concatenate(targets),
        np.concatenate(weights) / len(matrices),
    )


def fit_model(zh_pages, wcxb_pages, wmb_pages, args):
    corpora = [(zh_pages, 1.0)]
    if wcxb_pages and args.wcxb_corpus_weight > 0:
        corpora.append((wcxb_pages, args.wcxb_corpus_weight))
    if wmb_pages and args.wmb_corpus_weight > 0:
        corpora.append((wmb_pages, args.wmb_corpus_weight))
    matrices = []
    targets = []
    weights = []
    for pages, corpus_weight in corpora:
        matrix, target, weight = training_matrix(
            pages, args.maximum_roots_per_page
        )
        matrices.append(matrix)
        targets.append(target)
        weights.append(corpus_weight * weight)
    model = HistGradientBoostingRegressor(
        loss="quantile",
        quantile=args.gain_quantile,
        learning_rate=args.learning_rate,
        max_iter=args.maximum_iterations,
        max_leaf_nodes=args.maximum_leaf_nodes,
        max_depth=args.maximum_depth,
        min_samples_leaf=args.minimum_samples_leaf,
        l2_regularization=args.regularization,
        early_stopping=False,
        random_state=0,
    )
    matrix = np.concatenate(matrices)
    target = np.concatenate(targets)
    weight = np.concatenate(weights)
    model.fit(matrix, target, sample_weight=weight)
    return model, len(target)


def evaluate(page, model) -> dict:
    choice = page.choice
    source = choice.root_page.item.page
    baseline = GLOBAL.ROOT_QUALITY.decode(
        choice.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    prediction = (
        model.predict(model_features(page))
        if len(choice.indices)
        else np.zeros(0, dtype=np.float64)
    )
    offset = int(np.argmax(prediction)) if len(prediction) else None
    lower_bound = float(prediction[offset]) if offset is not None else 0.0
    root = (
        int(choice.indices[offset])
        if offset is not None and lower_bound > 0.0
        else None
    )
    if root is None:
        mask = baseline.mask.copy()
        roots = baseline.roots
        retained_tokens = baseline.retained_tokens
        available = baseline.available
    else:
        mask = GLOBAL.reconstruct(choice.root_page, root)
        roots = [root]
        retained_tokens = int(source.tokens[mask].sum())
        available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
        if not available:
            mask = baseline.mask.copy()
            roots = baseline.roots
            retained_tokens = baseline.retained_tokens
            available = baseline.available
            root = None
            offset = None
            lower_bound = 0.0
    baseline_text = (
        TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    )
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.source.product_f1 if source.status == "extract" else 0.0
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
        "candidateRoots": roots,
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": retained_tokens,
        "predictedGainLowerBound": lower_bound,
        "candidateMaskQuality": (
            float(choice.quality[offset])
            if offset is not None
            else choice.baseline_quality
        ),
        "bestMaskQuality": choice.best_quality,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.source.product_available,
        "teacherKey": page.teacher_key,
        "teacherSourceQuality": page.teacher_source_quality,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--maximum-roots-per-page", type=int, default=128)
    parser.add_argument("--gain-quantile", type=float, default=0.10)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--maximum-iterations", type=int, default=80)
    parser.add_argument("--maximum-leaf-nodes", type=int, default=15)
    parser.add_argument("--maximum-depth", type=int, default=3)
    parser.add_argument("--minimum-samples-leaf", type=int, default=50)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    # Parsed by the shared exact-provenance loader.
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = RELATIVE.load_wmb_pages(args.wmb_units)
    wmb_train = [item for item in wmb if item.page.split == "wmb-train"]
    wmb_holdout = [item for item in wmb if item.page.split == "wmb-holdout"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        train_pages = [
            GLOBAL_DISTILL.build_page(item, beta, "human", args) for item in train
        ]
        test_pages = [
            GLOBAL_DISTILL.build_page(item, beta, "human", args) for item in test
        ]
        wcxb_pages = [
            GLOBAL_DISTILL.build_wcxb_page(item, beta, args) for item in wcxb_train
        ]
        wmb_pages = [RELATIVE.build_wmb_page(item, beta, args) for item in wmb_train]
        model, samples = fit_model(train_pages, wcxb_pages, wmb_pages, args)
        fold_rows = [evaluate(page, model) for page in test_pages]
        rows.extend(fold_rows)
        fold_summary = GLOBAL_DISTILL.summary(fold_rows)
        folds.append({
            "fold": fold,
            "trainingRootSamples": samples,
            "summary": fold_summary,
            "localBeta": beta.tolist(),
        })
        print(json.dumps({"fold": fold, "summary": fold_summary}, ensure_ascii=False), flush=True)
        if (
            fold_summary["regressionsBelowMinusPointOne"]
            or fold_summary["candidateExcludeFalsePositives"]
            > fold_summary["baselineExcludeFalsePositives"]
        ):
            raise RuntimeError(f"fold {fold} failed the preregistered safety gate")

    summary = GLOBAL_DISTILL.summary(rows)
    report = {
        "schema": "qingzhou.tree-dp-relative-root-tree-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-tree-dp-with-quantile-tree-relative-root-state",
            "decision": "replace-ordinary-dp-forest-only-when-predicted-q10-gain-is-positive",
            "candidateAnswers": "local-block-training-only",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "wmbLoss": "conditional-root-gain-only",
            "inferenceComplexity": "O(N*trees*depth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "relativeRootStudySha256": TRAINER.sha256_file(RELATIVE_PATH),
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
