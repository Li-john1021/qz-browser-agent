#!/usr/bin/env python3
"""Evaluate a monotone absolute-quality root potential inside Tree-DP.

Unlike the rejected root-quality prototype, the learned quality term is
strictly non-negative.  It may make a previously losing primary root feasible,
but it can never subtract from the established Readability-enriched Tree-DP
objective.  This isolates whether generic root-quality calibration can rescue
empty/wrong-root pages without reintroducing a candidate selector.
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
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ROOT_QUALITY = load_module(
    "qingzhou_root_quality_for_confidence",
    HERE / "study-tree-dp-root-quality.py",
)
ROOT_RANKING = load_module(
    "qingzhou_root_ranking_for_confidence",
    HERE / "study-tree-dp-root-ranking.py",
)
READABILITY = ROOT_QUALITY.READABILITY
TRAINER = ROOT_QUALITY.TRAINER


def page_row(root_page, model, scale: float, threshold: float) -> dict:
    page = root_page.item.page
    baseline = ROOT_RANKING.decode_with_bonus(
        root_page,
        np.zeros(len(page.tokens), dtype=np.float64),
    )
    quality = np.clip(model.predict(root_page.features), 0.0, 1.0)
    bonus = scale * np.maximum(0.0, quality - threshold)
    candidate = ROOT_RANKING.decode_with_bonus(root_page, bonus)
    if candidate.value + 1e-8 < baseline.value:
        raise AssertionError(f"{page.id}: monotone confidence lowered DP objective")
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
        "maxPredictedRootQuality": float(np.max(quality)),
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
    configurations = [
        (float(scale), float(threshold))
        for scale in args.scales.split(",")
        for threshold in args.thresholds.split(",")
    ]
    pooled = {configuration: [] for configuration in configurations}
    groups = np.asarray([item.page.site_family for item in pages])
    indices = np.arange(len(pages))
    folds = []
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
        train_roots = [ROOT_QUALITY.build_root_page(item, beta) for item in train]
        test_roots = [ROOT_QUALITY.build_root_page(item, beta) for item in test]
        model = ROOT_QUALITY.fit_quality_model(train_roots, args.ridge_alpha)
        summaries = {}
        for configuration in configurations:
            scale, threshold = configuration
            rows = [page_row(item, model, scale, threshold) for item in test_roots]
            pooled[configuration].extend(rows)
            summaries[f"{scale:g}@{threshold:g}"] = ROOT_QUALITY.summarize(rows)
        fold_report = {"fold": fold, "summaries": summaries}
        folds.append(fold_report)
        print(json.dumps(fold_report, ensure_ascii=False), flush=True)

    configurations_report = []
    for scale, threshold in configurations:
        rows = pooled[(scale, threshold)]
        configurations_report.append({
            "scale": scale,
            "threshold": threshold,
            "summary": ROOT_QUALITY.summarize(rows),
            "rows": rows,
        })
    safe = [
        row for row in configurations_report
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
    final_roots = [ROOT_QUALITY.build_root_page(item, final_beta) for item in pages]
    final_model = ROOT_QUALITY.fit_quality_model(final_roots, args.ridge_alpha)
    validation_report = None
    if selected and validation:
        roots = [ROOT_QUALITY.build_root_page(item, final_beta) for item in validation]
        rows = [
            page_row(item, final_model, selected["scale"], selected["threshold"])
            for item in roots
        ]
        validation_report = {"summary": ROOT_QUALITY.summarize(rows), "rows": rows}

    report = {
        "schema": "qingzhou.tree-dp-root-confidence-study.v1",
        "protocol": {
            "model": "absolute-root-quality-plus-monotone-one-root-bonus",
            "runtimeReadabilityCandidate": False,
            "rootFeatureNames": ROOT_QUALITY.ROOT_FEATURE_NAMES,
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
        "configurations": configurations_report,
        "selected": ({
            "scale": selected["scale"],
            "threshold": selected["threshold"],
            "summary": selected["summary"],
        } if selected else None),
        "folds": folds,
        "zhValidation": validation_report,
        "model": {
            "scalerMean": final_model[0].mean_.tolist(),
            "scalerScale": final_model[0].scale_.tolist(),
            "coefficients": final_model[1].coef_.tolist(),
            "intercept": float(final_model[1].intercept_),
        },
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "rootQualityStudySha256": TRAINER.sha256_file(ROOT_QUALITY.ROOT_STUDY_PATH if hasattr(ROOT_QUALITY, "ROOT_STUDY_PATH") else HERE / "study-tree-dp-root-quality.py"),
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
