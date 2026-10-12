#!/usr/bin/env python3
"""Learn a monotone, within-page primary-root ranking potential for Tree-DP.

This experiment deliberately does not predict an absolute cross-page quality
score.  It learns only which of two feasible roots on the same page is better.
At inference the shipped/Readability-enriched Tree-DP is decoded first, then a
second O(N) DP may give one alternative root a *non-negative* bonus relative to
the best learned score among the baseline roots.  Consequently the learned
term can never lower the baseline objective or make an existing extraction
disappear.  Readability is used only as fixed DOM features; no Readability
candidate or post-hoc selector participates.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
ROOT_STUDY_PATH = HERE / "study-tree-dp-root-quality.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_root_quality_study", ROOT_STUDY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {ROOT_STUDY_PATH}")
ROOT_STUDY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ROOT_STUDY
SPEC.loader.exec_module(ROOT_STUDY)
READABILITY = ROOT_STUDY.READABILITY
TRAINER = ROOT_STUDY.TRAINER


@dataclass
class RankingModel:
    scaler: StandardScaler
    classifier: LogisticRegression
    pair_count: int
    page_count: int

    def score(self, features: np.ndarray) -> np.ndarray:
        return np.asarray(
            self.classifier.decision_function(self.scaler.transform(features)),
            dtype=np.float64,
        )


@dataclass
class Decode:
    mask: np.ndarray
    roots: list[int]
    value: float
    available: bool
    retained_tokens: int


def root_current_energy(root_page) -> np.ndarray:
    page = root_page.item.page
    return (
        root_page.keep
        - TRAINER.ROOT_PENALTY
        + 0.25 * page.readability_root_scores["evidence-tag-class"]
    )


def pairwise_examples(root_page) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Return symmetric within-page comparisons with one-page total weight."""
    if root_page.item.page.status != "extract":
        return None
    indices = ROOT_STUDY.sampled_root_indices(root_page)
    if not len(indices):
        return None
    target = root_page.target
    best = float(np.max(target[indices]))
    if best < 0.75:
        return None
    positives = indices[(target[indices] >= best - 0.03) & (target[indices] >= 0.75)]
    if not len(positives):
        return None
    positives = positives[np.argsort(target[positives])[-4:]]
    negative_ceiling = min(0.70, best - 0.15)
    negatives = indices[target[indices] <= negative_ceiling]
    if not len(negatives):
        return None

    # Prefer mistakes the current energy is most likely to make, while keeping
    # a few large and position-diverse roots so the ranker does not see only a
    # narrow score neighbourhood.
    energy = root_current_energy(root_page)
    by_energy = negatives[np.argsort(energy[negatives])[-16:]]
    by_size = negatives[np.argsort(root_page.kept_tokens[negatives])[-4:]]
    by_position = negatives[
        np.linspace(0, len(negatives) - 1, min(4, len(negatives)), dtype=int)
    ]
    negatives = np.unique(np.concatenate([by_energy, by_size, by_position]))

    differences = []
    labels = []
    for positive in positives:
        for negative in negatives:
            difference = root_page.features[positive] - root_page.features[negative]
            if np.max(np.abs(difference)) <= 1e-12:
                continue
            differences.extend([difference, -difference])
            labels.extend([1.0, 0.0])
    if not differences:
        return None
    matrix = np.asarray(differences, dtype=np.float64)
    label = np.asarray(labels, dtype=np.float64)
    weight = np.full(len(label), 1.0 / len(label), dtype=np.float64)
    return matrix, label, weight


def fit_ranking_model(
    zh_roots: list,
    wcxb_roots: list,
    *,
    regularization_c: float,
    wcxb_corpus_weight: float,
) -> RankingModel:
    matrices = []
    labels = []
    weights = []
    page_count = 0
    for roots, corpus_weight in ((zh_roots, 1.0), (wcxb_roots, wcxb_corpus_weight)):
        if not roots or corpus_weight <= 0:
            continue
        eligible = []
        for root_page in roots:
            example = pairwise_examples(root_page)
            if example is not None:
                eligible.append(example)
        if not eligible:
            continue
        corpus_page_weight = corpus_weight / len(eligible)
        for matrix, label, weight in eligible:
            matrices.append(matrix)
            labels.append(label)
            weights.append(weight * corpus_page_weight)
            page_count += 1
    if not matrices:
        raise ValueError("no within-page root comparisons available")
    matrix = np.concatenate(matrices)
    label = np.concatenate(labels)
    weight = np.concatenate(weights)
    # Symmetric (+d, -d) pairs make zero the natural ranking boundary.  Do not
    # center: transform(root_a-root_b) must equal transform(root_a)-transform(root_b).
    scaler = StandardScaler(with_mean=False)
    scaler.fit(matrix, sample_weight=weight)
    classifier = LogisticRegression(
        C=regularization_c,
        fit_intercept=False,
        solver="lbfgs",
        max_iter=1000,
        tol=1e-10,
    )
    classifier.fit(scaler.transform(matrix), label, sample_weight=weight)
    return RankingModel(scaler, classifier, len(label), page_count)


def decode_with_bonus(root_page, root_bonus: np.ndarray) -> Decode:
    """Exact one-primary-root DP with a non-negative learned bonus."""
    page = root_page.item.page
    count = len(page.tokens)
    plain_free = np.zeros(count, dtype=np.float64)
    prior_free = np.zeros(count, dtype=np.float64)
    plain_root = np.zeros(count, dtype=bool)
    prior_mode = np.full(count, -1, dtype=np.int64)
    raw_prior = 0.25 * page.readability_root_scores["evidence-tag-class"]
    if np.any(root_bonus < -1e-12):
        raise ValueError("root ranking bonus must be monotone non-negative")
    root_prior = raw_prior + np.maximum(0.0, root_bonus)
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
            stack.extend((child, child == prior_child) for child in page.children[index])
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        retained[:] = False
        roots = []
        retained_tokens = 0
    return Decode(retained, roots, float(prior_free[0]), available, retained_tokens)


def page_row(root_page, model: RankingModel, scale: float, margin: float) -> dict:
    page = root_page.item.page
    baseline = decode_with_bonus(root_page, np.zeros(len(page.tokens), dtype=np.float64))
    prediction = model.score(root_page.features)
    if baseline.roots:
        reference = max(float(prediction[root]) for root in baseline.roots)
        bonus = scale * np.maximum(0.0, prediction - reference - margin)
    else:
        # Pairwise ranking has no calibrated cross-page origin.  Empty-page
        # rescue needs a separate extractability loss and is intentionally not
        # smuggled into this experiment.
        bonus = np.zeros(len(page.tokens), dtype=np.float64)
    candidate = decode_with_bonus(root_page, bonus)
    if candidate.value + 1e-8 < baseline.value:
        raise AssertionError(f"{page.id}: monotone root bonus lowered DP objective")
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
        "changed": not np.array_equal(baseline.mask, candidate.mask),
        "maxRankingAdvantage": (
            float(np.max(prediction) - reference) if baseline.roots else None
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--ranking-c", type=float, default=1.0)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--scales", default="20,40,80")
    parser.add_argument("--margins", default="0.25,0.5,1")
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
    configurations = [
        (float(scale), float(margin))
        for scale in args.scales.split(",")
        for margin in args.margins.split(",")
    ]
    pooled = {configuration: [] for configuration in configurations}
    groups = np.asarray([item.page.site_family for item in pages])
    indices = np.arange(len(pages))
    fold_reports = []
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
        train_roots = [ROOT_STUDY.build_root_page(item, beta) for item in train]
        test_roots = [ROOT_STUDY.build_root_page(item, beta) for item in test]
        wcxb_roots = [ROOT_STUDY.build_root_page(item, beta) for item in wcxb_train]
        model = fit_ranking_model(
            train_roots,
            wcxb_roots,
            regularization_c=args.ranking_c,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        summaries = {}
        for configuration in configurations:
            scale, margin = configuration
            rows = [page_row(item, model, scale, margin) for item in test_roots]
            pooled[configuration].extend(rows)
            summaries[f"{scale:g}@{margin:g}"] = ROOT_STUDY.summarize(rows)
        fold_report = {
            "fold": fold,
            "trainingPairRows": model.pair_count,
            "trainingPages": model.page_count,
            "summaries": summaries,
        }
        fold_reports.append(fold_report)
        print(json.dumps(fold_report, ensure_ascii=False), flush=True)

    configuration_reports = []
    for scale, margin in configurations:
        rows = pooled[(scale, margin)]
        configuration_reports.append({
            "scale": scale,
            "margin": margin,
            "summary": ROOT_STUDY.summarize(rows),
            "rows": rows,
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
    final_roots = [ROOT_STUDY.build_root_page(item, final_beta) for item in pages]
    final_wcxb_roots = [ROOT_STUDY.build_root_page(item, final_beta) for item in wcxb_train]
    final_model = fit_ranking_model(
        final_roots,
        final_wcxb_roots,
        regularization_c=args.ranking_c,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    validation_report = None
    if selected and validation:
        validation_roots = [ROOT_STUDY.build_root_page(item, final_beta) for item in validation]
        rows = [
            page_row(item, final_model, selected["scale"], selected["margin"])
            for item in validation_roots
        ]
        validation_report = {"summary": ROOT_STUDY.summarize(rows), "rows": rows}

    report = {
        "schema": "qingzhou.tree-dp-root-ranking-study.v1",
        "protocol": {
            "model": "within-page-pairwise-linear-ranking-plus-monotone-one-root-bonus",
            "runtimeReadabilityCandidate": False,
            "rootFeatureNames": ROOT_STUDY.ROOT_FEATURE_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "emptyBaselinePolicy": "unchanged-fail-closed",
            "selectionGate": "OOF no delta<-0.1 and exclude-FP non-increasing",
            "zhValidationOpened": bool(validation_report),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            "rankingC": args.ranking_c,
            "readabilityRegularization": args.readability_regularization,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
            "folds": args.folds,
        },
        "configurations": configuration_reports,
        "selected": ({
            "scale": selected["scale"],
            "margin": selected["margin"],
            "summary": selected["summary"],
        } if selected else None),
        "folds": fold_reports,
        "zhValidation": validation_report,
        "rankingModel": {
            "pairRows": final_model.pair_count,
            "trainingPages": final_model.page_count,
            "scale": final_model.scaler.scale_.tolist(),
            "coefficients": final_model.classifier.coef_[0].tolist(),
        },
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "rootStudySha256": TRAINER.sha256_file(ROOT_STUDY_PATH),
        "readabilityStudySha256": TRAINER.sha256_file(ROOT_STUDY.STUDY_PATH),
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
