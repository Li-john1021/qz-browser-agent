#!/usr/bin/env python3
"""Measure a small nonlinear root energy inside the single Tree-DP model.

The local keep/carve recurrence is fixed to the strongest site-family OOF
linear block scorer.  Every legal root is represented by generic DOM,
Readability-derived, materialized-shape, and current-energy features.  A small
histogram gradient tree predicts the human-compatible root quality; ``empty``
competes through the same fixed quality threshold.  There is no runtime
Readability candidate and no site, URL, page-type, timing, or gold feature.

This is a capacity study, not a production dependency.  If it succeeds, its
purpose is to identify stable interactions that can be distilled back into a
compact serving scorer.
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
GLOBAL_PATH = HERE / "study-tree-dp-global-choice.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_global_choice", GLOBAL_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {GLOBAL_PATH}")
GLOBAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GLOBAL
SPEC.loader.exec_module(GLOBAL)
READABILITY = GLOBAL.READABILITY
ROOT_QUALITY = GLOBAL.ROOT_QUALITY
TRAINER = GLOBAL.TRAINER

FEATURE_NAMES = [*GLOBAL.CHOICE_FEATURE_NAMES, "currentEnergyBelowPageBest"]


def sampled_offsets(page, maximum: int) -> np.ndarray:
    count = len(page.indices)
    if count <= maximum:
        return np.arange(count, dtype=np.int64)
    buckets = [
        np.argsort(page.current_energy[page.indices])[-maximum // 4 :],
        np.argsort(page.quality)[-maximum // 4 :],
        np.argsort(page.root_page.kept_tokens[page.indices])[-maximum // 4 :],
        np.linspace(0, count - 1, maximum // 4, dtype=np.int64),
    ]
    selected = np.unique(np.concatenate(buckets))
    # The unions can overlap.  Fill the remaining deterministic slots from
    # document order instead of introducing a random sampling hyperparameter.
    if len(selected) < maximum:
        missing = np.setdiff1d(np.arange(count), selected, assume_unique=True)
        selected = np.concatenate([selected, missing[: maximum - len(selected)]])
    return np.sort(selected[:maximum])


def model_features(page) -> np.ndarray:
    return np.column_stack([page.features, page.energy_offset]).astype(np.float64)


def training_matrix(pages, maximum_roots: int):
    matrices = []
    targets = []
    weights = []
    for page in pages:
        if not len(page.indices):
            continue
        offsets = sampled_offsets(page, maximum_roots)
        matrix = model_features(page)[offsets]
        target = page.quality[offsets]
        # Each page has exactly unit mass.  A small quality multiplier ensures
        # the rare good root remains represented without drowning the hard
        # negatives or turning DOM roots into independent examples.
        weight = 0.25 + target
        weight /= max(1e-12, float(weight.sum()))
        matrices.append(matrix)
        targets.append(target)
        weights.append(weight)
    if not matrices:
        raise ValueError("no legal root candidates")
    return (
        np.concatenate(matrices),
        np.concatenate(targets),
        np.concatenate(weights) / max(1, len(matrices)),
    )


def fit_model(zh_pages, wcxb_pages, args):
    zh_matrix, zh_target, zh_weight = training_matrix(
        zh_pages,
        args.maximum_roots_per_page,
    )
    matrices = [zh_matrix]
    targets = [zh_target]
    weights = [zh_weight]
    if wcxb_pages and args.wcxb_corpus_weight > 0:
        wcxb_matrix, wcxb_target, wcxb_weight = training_matrix(
            wcxb_pages,
            args.maximum_roots_per_page,
        )
        matrices.append(wcxb_matrix)
        targets.append(wcxb_target)
        weights.append(args.wcxb_corpus_weight * wcxb_weight)
    matrix = np.concatenate(matrices)
    target = np.concatenate(targets)
    weight = np.concatenate(weights)
    model = HistGradientBoostingRegressor(
        loss="squared_error",
        learning_rate=args.learning_rate,
        max_iter=args.maximum_iterations,
        max_leaf_nodes=args.maximum_leaf_nodes,
        max_depth=args.maximum_depth,
        min_samples_leaf=args.minimum_samples_leaf,
        l2_regularization=args.regularization,
        early_stopping=False,
        random_state=0,
    )
    model.fit(matrix, target, sample_weight=weight)
    return model, len(target)


def page_row(page, model, threshold: float) -> dict:
    source = page.root_page.item.page
    baseline = ROOT_QUALITY.decode(
        page.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    prediction = model.predict(model_features(page)) if len(page.indices) else np.zeros(0)
    offset = int(np.argmax(prediction)) if len(prediction) else None
    predicted_quality = float(prediction[offset]) if offset is not None else 0.0
    root = int(page.indices[offset]) if offset is not None and predicted_quality >= threshold else None
    mask = (
        GLOBAL.reconstruct(page.root_page, root)
        if root is not None
        else np.zeros(len(source.tokens), dtype=bool)
    )
    retained_tokens = int(source.tokens[mask].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        mask[:] = False
        root = None
        retained_tokens = 0
    baseline_text = TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
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
        "candidateRoots": [] if root is None else [root],
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": retained_tokens,
        "predictedQuality": predicted_quality,
        "candidateMaskQuality": (
            float(page.quality[offset]) if root is not None else 0.0
        ),
        "bestMaskQuality": page.best_quality,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--maximum-roots-per-page", type=int, default=128)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--maximum-iterations", type=int, default=80)
    parser.add_argument("--maximum-leaf-nodes", type=int, default=15)
    parser.add_argument("--maximum-depth", type=int, default=3)
    parser.add_argument("--minimum-samples-leaf", type=int, default=50)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--thresholds", type=float, nargs="+", default=[0.2, 0.4, 0.6])
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages = READABILITY.load_study_pages(args.zh_units, "zh")
    wcxb = READABILITY.load_study_pages(args.wcxb_units, "wcxb") if args.wcxb_units else []
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.page.site_family for item in pages])
    rows = {str(value): [] for value in args.thresholds}
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups),
        1,
    ):
        train_items = [pages[int(index)] for index in train_indices]
        test_items = [pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train_items,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        train_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in train_items
        ]
        test_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in test_items
        ]
        wcxb_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in wcxb_train
        ]
        model, samples = fit_model(train_pages, wcxb_pages, args)
        fold_summaries = {}
        for threshold in args.thresholds:
            key = str(threshold)
            fold_rows = [page_row(page, model, threshold) for page in test_pages]
            rows[key].extend(fold_rows)
            fold_summaries[key] = ROOT_QUALITY.summarize(fold_rows)
        folds.append({
            "fold": fold,
            "trainingRootSamples": samples,
            "readabilityBeta": beta.tolist(),
            "summaries": fold_summaries,
        })
        print(json.dumps({"fold": fold, "summaries": fold_summaries}, ensure_ascii=False), flush=True)

    configurations = []
    for threshold in args.thresholds:
        key = str(threshold)
        configurations.append({
            "threshold": threshold,
            "summary": ROOT_QUALITY.summarize(rows[key]),
            "rows": rows[key],
        })
    report = {
        "schema": "qingzhou.tree-dp-global-tree-study.v1",
        "protocol": {
            "model": "small-nonlinear-root-energy-over-empty-and-legal-roots",
            "runtimeReadabilityCandidate": False,
            "featureNames": FEATURE_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "rootSampleWeighting": "one-page-unit-mass-times-(0.25+mask-quality)",
            "target": "fixed-keep-carve-human-mask-F1",
            "inferenceComplexity": "O(N*trees*depth)",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
        },
        "hyperparameters": vars(args) | {
            "zh_units": str(args.zh_units),
            "wcxb_units": str(args.wcxb_units) if args.wcxb_units else None,
            "output": str(args.output),
        },
        "configurations": configurations,
        "folds": folds,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "globalChoiceStudySha256": TRAINER.sha256_file(GLOBAL_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "configurations": [
            {"threshold": row["threshold"], "summary": row["summary"]}
            for row in configurations
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
