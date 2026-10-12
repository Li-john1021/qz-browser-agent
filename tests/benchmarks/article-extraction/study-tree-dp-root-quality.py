#!/usr/bin/env python3
"""Learn Readability-style primary-root quality inside Tree-DP.

The block scorer and keep/carve recurrence stay fixed.  A small linear model
learns the quality of selecting each feasible root from generic Tree-DP and
Readability signals.  Its energy is available to at most one primary root, so
it cannot reward fragmentation.  This is a latent state of one O(N) dynamic
program, not a post-hoc candidate selector.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
STUDY_PATH = HERE / "study-tree-dp-readability.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_readability_study", STUDY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {STUDY_PATH}")
READABILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READABILITY
SPEC.loader.exec_module(READABILITY)
TRAINER = READABILITY.TRAINER


ROOT_FEATURE_NAMES = [
    "keepScorePerRetainedToken",
    "logRetainedTokens",
    "retainedPageShare",
    "readabilityParagraphEvidenceLog",
    "readabilityTagPrior",
    "readabilityClassWeight",
    "readabilityLinkFactor",
    "readabilityRawScore",
    "readabilityLinkAdjustedScore",
    "readabilityAncestorClass",
    "readabilityUnlikelyAncestor",
    "treeBoilerplateHits",
    "treeContentHits",
    "treeRepeatedLog",
    "treeDepth",
    "tagBody",
    "tagMainOrArticle",
    "tagSection",
    "tagDiv",
    "tagParagraphOrTable",
]


@dataclass
class RootPage:
    item: object
    keep: np.ndarray
    keep_choice: list[list[bool]]
    kept_tokens: np.ndarray
    kept_gold_tokens: np.ndarray
    features: np.ndarray
    target: np.ndarray
    feasible: np.ndarray


@dataclass
class Decode:
    mask: np.ndarray
    roots: list[int]
    available: bool
    retained_tokens: int


def build_root_page(item, beta: np.ndarray) -> RootPage:
    page = item.page
    count = len(page.tokens)
    local = page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + item.context @ beta
    )
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
    gold_tokens = float(page.tokens[page.gold_keep].sum()) if page.status == "extract" else 0.0
    precision = np.divide(
        kept_gold_tokens,
        kept_tokens,
        out=np.zeros_like(kept_tokens),
        where=kept_tokens > 0,
    )
    recall = kept_gold_tokens / gold_tokens if gold_tokens else np.zeros_like(kept_tokens)
    target = np.divide(
        2.0 * precision * recall,
        precision + recall,
        out=np.zeros_like(precision),
        where=(precision + recall) > 0,
    )
    target[~feasible] = 0.0
    return RootPage(item, keep, keep_choice, kept_tokens, kept_gold_tokens, features, target, feasible)


def sampled_root_indices(root_page: RootPage, maximum: int = 256) -> np.ndarray:
    indices = np.flatnonzero(root_page.feasible)
    if len(indices) <= maximum:
        return indices
    page = root_page.item.page
    current = (
        root_page.keep
        - TRAINER.ROOT_PENALTY
        + 0.25 * page.readability_root_scores["evidence-tag-class"]
    )
    buckets = [
        indices[np.argsort(current[indices])[-64:]],
        indices[np.argsort(root_page.target[indices])[-64:]],
        indices[np.argsort(root_page.kept_tokens[indices])[-64:]],
        indices[np.linspace(0, len(indices) - 1, 64, dtype=int)],
    ]
    return np.unique(np.concatenate(buckets))


def fit_quality_model(root_pages: list[RootPage], alpha: float):
    matrices = []
    targets = []
    weights = []
    for root_page in root_pages:
        indices = sampled_root_indices(root_page)
        if not len(indices):
            continue
        target = root_page.target[indices]
        # Every page has unit total weight.  A mild quality multiplier keeps
        # the best compatible root visible without turning low-quality roots
        # into an unrepresented class.
        weight = 0.25 + target
        weight /= weight.sum()
        matrices.append(root_page.features[indices])
        targets.append(target)
        weights.append(weight)
    matrix = np.concatenate(matrices)
    target = np.concatenate(targets)
    weight = np.concatenate(weights)
    model = make_pipeline(StandardScaler(), Ridge(alpha=alpha))
    model.fit(matrix, target, ridge__sample_weight=weight)
    return model


def decode(root_page: RootPage, predicted_quality: np.ndarray, scale: float, threshold: float) -> Decode:
    page = root_page.item.page
    count = len(page.tokens)
    plain_free = np.zeros(count, dtype=np.float64)
    prior_free = np.zeros(count, dtype=np.float64)
    plain_root = np.zeros(count, dtype=bool)
    prior_mode = np.full(count, -1, dtype=np.int64)
    raw_prior = 0.25 * page.readability_root_scores["evidence-tag-class"]
    quality_prior = scale * (np.clip(predicted_quality, 0.0, 1.0) - threshold)
    root_prior = raw_prior + quality_prior
    for index in range(count - 1, -1, -1):
        descend = sum(plain_free[child] for child in page.children[index])
        as_root = (
            root_page.keep[index] - TRAINER.ROOT_PENALTY
            if root_page.feasible[index]
            else -np.inf
        )
        if as_root >= descend and as_root > 0:
            plain_free[index] = as_root
            plain_root[index] = True
        else:
            plain_free[index] = max(0.0, descend)

        prior_free[index] = plain_free[index]
        prior_as_root = as_root + root_prior[index]
        if prior_as_root >= prior_free[index] and prior_as_root > 0:
            prior_free[index] = prior_as_root
            prior_mode[index] = -2
        for child in page.children[index]:
            child_prior = descend - plain_free[child] + prior_free[child]
            if child_prior > prior_free[index] + 1e-12:
                prior_free[index] = child_prior
                prior_mode[index] = child

    retained = np.zeros(count, dtype=bool)
    roots: list[int] = []
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
                    if root_page.keep_choice[current][offset]:
                        keep_stack.append(child)
        else:
            prior_child = mode if use_prior and mode >= 0 else None
            stack.extend(
                (child, child == prior_child)
                for child in page.children[index]
            )
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        retained[:] = False
        roots = []
        retained_tokens = 0
    return Decode(retained, roots, available, retained_tokens)


def page_row(root_page: RootPage, quality_model, scale: float, threshold: float) -> dict:
    item = root_page.item
    page = item.page
    # The exact v7 root prior with the already-built local beta in root_page.
    baseline = decode(
        root_page,
        np.full(len(page.tokens), threshold),
        0.0,
        threshold,
    )
    prediction = quality_model.predict(root_page.features)
    candidate = decode(root_page, prediction, scale, threshold)
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
        "baselineAvailable": baseline.available,
        "candidateAvailable": candidate.available,
        "baselineRoots": baseline.roots,
        "candidateRoots": candidate.roots,
    }


def summarize(rows: list[dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    delta = [row["delta"] for row in extract]
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "baselineMeanF1": float(np.mean([row["baseline"] for row in extract])) if extract else 0.0,
        "candidateMeanF1": float(np.mean([row["candidate"] for row in extract])) if extract else 0.0,
        "meanDelta": float(np.mean(delta)) if delta else 0.0,
        "wins": sum(value > 1e-9 for value in delta),
        "ties": sum(abs(value) <= 1e-9 for value in delta),
        "losses": sum(value < -1e-9 for value in delta),
        "worst": min(delta, default=0.0),
        "regressionsBelowMinusPointOne": sum(value < -0.1 for value in delta),
        "regressionsBelowMinusPointTwo": sum(value < -0.2 for value in delta),
        "baselineAvailable": sum(row["baselineAvailable"] for row in extract),
        "candidateAvailable": sum(row["candidateAvailable"] for row in extract),
        "baselineExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["baselineAvailable"] for row in rows
        ),
        "candidateExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["candidateAvailable"] for row in rows
        ),
        "worstPages": [
            {"id": row["id"], "delta": row["delta"]}
            for row in sorted(extract, key=lambda value: value["delta"])[:15]
        ],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--ridge-alpha", type=float, default=10.0)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--scales", default="40,80,120")
    parser.add_argument("--thresholds", default="0.5,0.65,0.8")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages = READABILITY.load_study_pages(args.zh_units, "zh")
    validation = READABILITY.load_study_pages(
        args.zh_validation_units,
        "zh",
        allowed_zh_splits=frozenset({"validation"}),
    ) if args.zh_validation_units else []
    wcxb = READABILITY.load_study_pages(args.wcxb_units, "wcxb") if args.wcxb_units else []
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    scales = [float(value) for value in args.scales.split(",")]
    thresholds = [float(value) for value in args.thresholds.split(",")]
    configurations = [(scale, threshold) for scale in scales for threshold in thresholds]
    pooled = {configuration: [] for configuration in configurations}
    folds = []
    groups = np.asarray([item.page.site_family for item in pages])
    indices = np.arange(len(pages))
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups),
        1,
    ):
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        train_roots = [build_root_page(item, beta) for item in train]
        test_roots = [build_root_page(item, beta) for item in test]
        model = fit_quality_model(train_roots, args.ridge_alpha)
        summaries = {}
        for configuration in configurations:
            scale, threshold = configuration
            rows = [page_row(item, model, scale, threshold) for item in test_roots]
            pooled[configuration].extend(rows)
            summaries[f"{scale:g}@{threshold:g}"] = summarize(rows)
        fold_report = {"fold": fold, "summaries": summaries}
        folds.append(fold_report)
        print(json.dumps(fold_report, ensure_ascii=False), flush=True)

    configuration_reports = []
    for configuration in configurations:
        scale, threshold = configuration
        summary = summarize(pooled[configuration])
        configuration_reports.append({
            "scale": scale,
            "threshold": threshold,
            "summary": summary,
            "rows": pooled[configuration],
        })
    safe = [
        row for row in configuration_reports
        if row["summary"]["regressionsBelowMinusPointOne"] == 0
        and row["summary"]["candidateExcludeFalsePositives"]
        <= row["summary"]["baselineExcludeFalsePositives"]
    ]
    selected = max(safe, key=lambda row: row["summary"]["meanDelta"], default=None)

    final_beta = READABILITY.fit_increment(
        pages,
        wcxb_train,
        regularization=args.readability_regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    final_roots = [build_root_page(item, final_beta) for item in pages]
    final_model = fit_quality_model(final_roots, args.ridge_alpha)
    validation_report = None
    if selected and validation:
        validation_roots = [build_root_page(item, final_beta) for item in validation]
        rows = [
            page_row(item, final_model, selected["scale"], selected["threshold"])
            for item in validation_roots
        ]
        validation_report = {"summary": summarize(rows), "rows": rows}
    report = {
        "schema": "qingzhou.tree-dp-root-quality-study.v1",
        "protocol": {
            "model": "single-tree-dp-one-primary-root-quality-state",
            "runtimeReadabilityCandidate": False,
            "rootFeatureNames": ROOT_FEATURE_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "selectionGate": "OOF no delta<-0.1 and exclude-FP non-increasing",
            "zhValidationOpened": bool(validation_report),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            "ridgeAlpha": args.ridge_alpha,
            "readabilityRegularization": args.readability_regularization,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
            "folds": args.folds,
        },
        "configurations": configuration_reports,
        "selected": {
            "scale": selected["scale"],
            "threshold": selected["threshold"],
            "summary": selected["summary"],
        } if selected else None,
        "folds": folds,
        "zhValidation": validation_report,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "readabilityStudySha256": TRAINER.sha256_file(STUDY_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "selected": report["selected"],
        "validation": validation_report and validation_report["summary"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
