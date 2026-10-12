#!/usr/bin/env python3
"""Rank empty, ordinary-forest, and legal-root actions inside one Tree-DP.

This capacity study treats the ordinary Tree-DP forest as one page-local
action, alongside the empty answer and every legal single-root reconstruction.
A compact LambdaMART model ranks those actions from generic DOM,
Readability-derived, candidate-shape, and self-overlap evidence.  No external
extractor candidate is generated at inference time.

Chinese validation/test and multilingual holdouts are refused by construction.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
RELATIVE_PATH = HERE / "study-tree-dp-relative-root.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_action_ranker_base", RELATIVE_PATH
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


ACTION_FEATURE_NAMES = [
    *GLOBAL.CHOICE_FEATURE_NAMES,
    "currentEnergyBelowPageBest",
    "isEmptyAction",
    "isOrdinaryForestAction",
    "isOrdinaryRoot",
    "ordinaryAvailable",
    "ordinaryRootCountLog",
    "retainedOrdinaryTokenRecall",
    "retainedOrdinaryTokenPrecision",
    "retainedToOrdinaryLogRatio",
    "pageTokensLog",
    "pageElementCountLog",
    "pageParagraphCountLog",
    "pageHeadingCountLog",
    "pageListCountLog",
    "pageTableCountLog",
    "pageReadabilityEvidenceLog",
    "pageReadabilityPositiveMassLog",
]
EXTRACT_ABSTAIN_QUALITY = 0.5


@dataclass
class ActionPage:
    source: object
    choice: object
    baseline: object
    features: np.ndarray
    quality: np.ndarray
    kinds: list[str]
    roots: list[int | None]
    eligible: np.ndarray


def ordinary_quality(choice, baseline) -> float:
    source = choice.root_page.item.page
    if source.status != "extract" or not baseline.available:
        return 0.0
    selected = float(source.tokens[baseline.mask].sum())
    gold = float(source.tokens[source.gold_keep].sum())
    matched = float(source.tokens[baseline.mask & source.gold_keep].sum())
    precision = matched / selected if selected else 0.0
    recall = matched / gold if gold else 0.0
    return 2.0 * precision * recall / (precision + recall) if precision + recall else 0.0


def kept_weight(root_page, weight: np.ndarray) -> np.ndarray:
    result = weight.astype(np.float64).copy()
    for index in range(len(result) - 1, -1, -1):
        for offset, child in enumerate(root_page.item.page.children[index]):
            if root_page.keep_choice[index][offset]:
                result[index] += result[child]
    return result


def page_context(source) -> np.ndarray:
    tags = np.asarray(source.tags)
    readability = source.readability_root_scores
    return np.asarray([
        np.log1p(float(source.tokens.sum())) / 12.0,
        np.log1p(len(source.tokens)) / 12.0,
        np.log1p(float(np.sum(tags == "p"))) / 8.0,
        np.log1p(float(np.sum(np.isin(tags, ["h1", "h2", "h3", "h4", "h5", "h6"])))) / 8.0,
        np.log1p(float(np.sum(np.isin(tags, ["li", "dt", "dd"])))) / 8.0,
        np.log1p(float(np.sum(np.isin(tags, ["table", "tr", "td", "th"])))) / 8.0,
        np.log1p(float(np.max(np.maximum(0.0, readability["evidence"])))) / 8.0,
        np.log1p(float(np.sum(np.maximum(0.0, readability["full"])))) / 12.0,
    ], dtype=np.float64)


def root_action_features(choice, baseline) -> np.ndarray:
    source = choice.root_page.item.page
    root_page = choice.root_page
    indices = choice.indices
    ordinary_tokens = source.tokens * baseline.mask
    retained_ordinary = kept_weight(root_page, ordinary_tokens)[indices]
    ordinary_total = max(1.0, float(ordinary_tokens.sum()))
    retained = np.maximum(1.0, root_page.kept_tokens[indices])
    ordinary_roots = set(baseline.roots)
    best_energy = max(0.0, float(np.max(choice.current_energy[indices]))) if len(indices) else 0.0
    page_values = np.tile(page_context(source), (len(indices), 1))
    extras = np.column_stack([
        choice.energy_offset,
        np.zeros(len(indices)),
        np.zeros(len(indices)),
        np.asarray([index in ordinary_roots for index in indices], dtype=np.float64),
        np.full(len(indices), float(baseline.available)),
        np.full(len(indices), np.log1p(len(baseline.roots)) / 4.0),
        np.clip(retained_ordinary / ordinary_total, 0.0, 1.0),
        np.clip(retained_ordinary / retained, 0.0, 1.0),
        np.clip(np.log((retained + 1.0) / (ordinary_total + 1.0)), -8.0, 8.0) / 8.0,
    ])
    return np.column_stack([choice.features, extras, page_values]).astype(np.float64)


def synthetic_action_feature(choice, baseline, kind: str) -> np.ndarray:
    source = choice.root_page.item.page
    width = len(GLOBAL.CHOICE_FEATURE_NAMES)
    root_matrix = root_action_features(choice, baseline)
    if kind == "ordinary" and baseline.roots and len(choice.indices):
        offsets = [
            int(np.flatnonzero(choice.indices == root)[0])
            for root in baseline.roots
            if np.any(choice.indices == root)
        ]
        if offsets:
            weights = choice.root_page.kept_tokens[
                choice.indices[np.asarray(offsets, dtype=np.int64)]
            ]
            weights = weights / max(1.0, float(weights.sum()))
            row = np.average(root_matrix[offsets], axis=0, weights=weights)
        else:
            row = np.zeros(len(ACTION_FEATURE_NAMES), dtype=np.float64)
    else:
        row = np.zeros(len(ACTION_FEATURE_NAMES), dtype=np.float64)
    # Shared page context must remain defined even for the empty action.
    row[-len(page_context(source)):] = page_context(source)
    # Clear root-action-only fields and set the action identity/self-overlap.
    extra = width
    row[extra] = 0.0  # currentEnergyBelowPageBest
    row[extra + 1] = float(kind == "empty")
    row[extra + 2] = float(kind == "ordinary")
    row[extra + 3] = 0.0
    row[extra + 4] = float(baseline.available)
    row[extra + 5] = np.log1p(len(baseline.roots)) / 4.0
    row[extra + 6] = float(kind == "ordinary" and baseline.available)
    row[extra + 7] = float(kind == "ordinary" and baseline.available)
    row[extra + 8] = 0.0
    return row


def build_action_page(page) -> ActionPage:
    choice = page.choice
    source = choice.root_page.item.page
    baseline = GLOBAL.ROOT_QUALITY.decode(
        choice.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    root_features = root_action_features(choice, baseline)
    features = [synthetic_action_feature(choice, baseline, "empty")]
    quality = [
        1.0 if source.status == "exclude" else EXTRACT_ABSTAIN_QUALITY
    ]
    kinds = ["empty"]
    roots: list[int | None] = [None]
    eligible = [not baseline.available]
    if baseline.available:
        features.append(synthetic_action_feature(choice, baseline, "ordinary"))
        quality.append(ordinary_quality(choice, baseline))
        kinds.append("ordinary")
        roots.append(None)
        eligible.append(True)
    ordinary_recall_column = len(GLOBAL.CHOICE_FEATURE_NAMES) + 6
    for offset, root in enumerate(choice.indices):
        features.append(root_features[offset])
        quality.append(float(choice.quality[offset]))
        kinds.append("root")
        roots.append(int(root))
        eligible.append(
            not baseline.available
            or root_features[offset, ordinary_recall_column] >= 1.0 - 1e-12
        )
    return ActionPage(
        source=source,
        choice=choice,
        baseline=baseline,
        features=np.asarray(features, dtype=np.float64),
        quality=np.asarray(quality, dtype=np.float64),
        kinds=kinds,
        roots=roots,
        eligible=np.asarray(eligible, dtype=bool),
    )


def sampled_actions(page: ActionPage, maximum_roots: int) -> np.ndarray:
    synthetic = np.flatnonzero((np.asarray(page.kinds) != "root") & page.eligible)
    root_offsets = np.flatnonzero((np.asarray(page.kinds) == "root") & page.eligible)
    if len(root_offsets) <= maximum_roots:
        return np.concatenate([synthetic, root_offsets])
    choice = page.choice
    root_quality = page.quality[root_offsets]
    choice_offsets = np.asarray([
        int(np.flatnonzero(choice.indices == page.roots[action])[0])
        for action in root_offsets
    ], dtype=np.int64)
    root_energy = choice.current_energy[choice.indices[choice_offsets]]
    root_tokens = choice.root_page.kept_tokens[choice.indices[choice_offsets]]
    buckets = [
        root_offsets[np.argsort(root_energy)[-maximum_roots // 4 :]],
        root_offsets[np.argsort(root_quality)[-maximum_roots // 4 :]],
        root_offsets[np.argsort(root_tokens)[-maximum_roots // 4 :]],
        root_offsets[np.linspace(0, len(root_offsets) - 1, maximum_roots // 4, dtype=np.int64)],
    ]
    selected = np.unique(np.concatenate(buckets))
    if len(selected) < maximum_roots:
        missing = np.setdiff1d(root_offsets, selected, assume_unique=True)
        selected = np.concatenate([selected, missing[: maximum_roots - len(selected)]])
    return np.concatenate([synthetic, np.sort(selected[:maximum_roots])])


def training_data(corpora, args):
    matrices = []
    labels = []
    weights = []
    groups = []
    for pages, corpus_weight in corpora:
        for page in pages:
            offsets = sampled_actions(page, args.maximum_roots_per_page)
            values = page.quality[offsets]
            relevance = np.rint(np.clip(values, 0.0, 1.0) * args.relevance_levels).astype(np.int32)
            page_weight = (
                args.exclude_weight
                if page.source.status == "exclude"
                else 1.0
            ) * corpus_weight
            matrices.append(page.features[offsets])
            labels.append(relevance)
            weights.append(np.full(len(offsets), page_weight / len(offsets)))
            groups.append(len(offsets))
    return (
        np.concatenate(matrices),
        np.concatenate(labels),
        np.concatenate(weights),
        groups,
    )


def fit_ranker(zh_pages, wcxb_pages, wmb_pages, args):
    corpora = [(zh_pages, 1.0)]
    if wcxb_pages and args.wcxb_corpus_weight > 0:
        corpora.append((wcxb_pages, args.wcxb_corpus_weight))
    if wmb_pages and args.wmb_corpus_weight > 0:
        corpora.append((wmb_pages, args.wmb_corpus_weight))
    matrix, label, weight, groups = training_data(corpora, args)
    model = lgb.LGBMRanker(
        objective="lambdarank",
        metric="ndcg",
        label_gain=list(range(args.relevance_levels + 1)),
        learning_rate=args.learning_rate,
        n_estimators=args.maximum_iterations,
        num_leaves=args.maximum_leaf_nodes,
        max_depth=args.maximum_depth,
        min_child_samples=args.minimum_samples_leaf,
        reg_lambda=args.regularization,
        verbosity=-1,
        random_state=0,
        n_jobs=1,
    )
    model.fit(matrix, label, group=groups, sample_weight=weight)
    return model, len(label)


def evaluate(page: ActionPage, model) -> dict:
    scores = model.booster_.predict(page.features)
    scores = np.where(page.eligible, scores, -np.inf)
    action = int(np.argmax(scores))
    kind = page.kinds[action]
    root = page.roots[action]
    source = page.source
    if kind == "ordinary":
        mask = page.baseline.mask.copy()
        roots = page.baseline.roots
        available = page.baseline.available
    elif kind == "root" and root is not None:
        mask = GLOBAL.reconstruct(page.choice.root_page, root)
        roots = [root]
        available = int(source.tokens[mask].sum()) >= TRAINER.MIN_RETAINED_TOKENS
    else:
        mask = np.zeros(len(source.tokens), dtype=bool)
        roots = []
        available = False
    retained_tokens = int(source.tokens[mask].sum()) if available else 0
    baseline_text = (
        TRAINER.materialized_text(source, page.baseline.mask)
        if page.baseline.available
        else ""
    )
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.choice.root_page.item.source.product_f1 if hasattr(page.choice.root_page.item, "source") else 0.0
    return {
        "id": source.id,
        "siteFamily": source.site_family,
        "split": source.split,
        "status": source.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "baselineAvailable": page.baseline.available,
        "candidateAvailable": available,
        "baselineRoots": page.baseline.roots,
        "candidateRoots": roots,
        "baselineRetainedTokens": page.baseline.retained_tokens,
        "candidateRetainedTokens": retained_tokens,
        "selectedAction": kind,
        "selectedScore": float(scores[action]),
        "selectedMaskQuality": float(page.quality[action]),
        "bestActionQuality": float(page.quality.max()),
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": product > 0,
        "teacherKey": None,
        "teacherSourceQuality": 0.0,
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
    parser.add_argument("--relevance-levels", type=int, default=31)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--maximum-iterations", type=int, default=80)
    parser.add_argument("--maximum-leaf-nodes", type=int, default=15)
    parser.add_argument("--maximum-depth", type=int, default=3)
    parser.add_argument("--minimum-samples-leaf", type=int, default=50)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
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
        train_pages = [build_action_page(GLOBAL_DISTILL.build_page(item, beta, "human", args)) for item in train]
        test_pages = [build_action_page(GLOBAL_DISTILL.build_page(item, beta, "human", args)) for item in test]
        wcxb_pages = [build_action_page(GLOBAL_DISTILL.build_wcxb_page(item, beta, args)) for item in wcxb_train]
        wmb_pages = [build_action_page(RELATIVE.build_wmb_page(item, beta, args)) for item in wmb_train]
        model, samples = fit_ranker(train_pages, wcxb_pages, wmb_pages, args)
        fold_rows = [evaluate(page, model) for page in test_pages]
        # Restore exact product diagnostic from the source DistillPage.
        products = {item.item.page.id: item for item in test}
        for row in fold_rows:
            item = products[row["id"]]
            row["product"] = item.product_f1 if row["status"] == "extract" else 0.0
            row["deltaVsProduct"] = row["candidate"] - row["product"]
            row["productAvailable"] = item.product_available
        rows.extend(fold_rows)
        fold_summary = GLOBAL_DISTILL.summary(fold_rows)
        folds.append({"fold": fold, "trainingActions": samples, "summary": fold_summary, "localBeta": beta.tolist()})
        print(json.dumps({"fold": fold, "summary": fold_summary}, ensure_ascii=False), flush=True)

    summary = GLOBAL_DISTILL.summary(rows)
    report = {
        "schema": "qingzhou.tree-dp-action-ranker-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeActions": ["empty", "ordinary-tree-dp-forest", "legal-single-root"],
            "actionFeasibleSet": "nonempty-forest-dominates-empty; replacement-root-must-retain-all-ordinary-text-tokens",
            "extractEmptyUtility": EXTRACT_ABSTAIN_QUALITY,
            "featureNames": ACTION_FEATURE_NAMES,
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "inferenceComplexity": "O(N*trees*depth)",
        },
        "hyperparameters": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()},
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {"studySha256": TRAINER.sha256_file(Path(__file__)), "relativeRootStudySha256": TRAINER.sha256_file(RELATIVE_PATH)},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
