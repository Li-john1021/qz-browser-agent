#!/usr/bin/env python3
"""Fit a full Readability-context residual on the shipped Tree-DP scorer.

This is the controlled follow-up to ``study-tree-dp-readability.py``.  The
shipped 16-D score remains a fixed offset and the exact keep/carve/descend
recurrence is unchanged.  The residual exposes the remaining generic signals
that Readability uses before candidate selection: positive/negative class and
id matches, ok-maybe exceptions, unlikely/role/extraneous/byline/share scope,
paragraph evidence, link density, and repeated-container context.

No class string, site, URL, page type, candidate answer, timing, or gold field
is used at inference.  Chinese validation/test and WCXB test are refused by
the imported loaders.  All reported Chinese numbers are site-family OOF over
base+train; WCXB dev-holdout is never fitted.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
BASE_PATH = HERE / "study-tree-dp-readability.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_readability_full_base", BASE_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {BASE_PATH}")
BASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = BASE
SPEC.loader.exec_module(BASE)
TRAINER = BASE.TRAINER


FEATURE_NAMES = [
    "readabilityClassAncestorNetCapped3",
    "readabilityPositiveAncestorCapped3",
    "readabilityNegativeAncestorCapped3",
    "readabilityOkMaybeAncestor",
    "readabilityUnlikelyAncestor",
    "readabilityRoleRejectedAncestor",
    "readabilityExtraneousAncestor",
    "readabilityBylineAncestor",
    "readabilityShareAncestor",
    "readabilityParagraphEvidenceScopeLog",
    "readabilityPositiveCandidateScope",
    "readabilityNegativeCandidateScope",
    "readabilityLinkDensityScope",
    "maxRepeatedAncestorLog",
    "repeatedAncestorCount",
    "repeatedNonAnchorContext",
    "directReadabilityClassNet",
    "directReadabilityOkMaybe",
    "directReadabilityUnlikely",
    "directReadabilityRoleRejected",
]
FEATURE_SETS = {
    "compact": (0, 4),
    "boundary": (0, 3, 4, 5, 6, 7, 8),
    "all": tuple(range(len(FEATURE_NAMES))),
}


def full_context(page) -> np.ndarray:
    count = len(page.tokens)
    direct_positive = np.clip(page.readability_positive_hits, 0.0, 3.0)
    direct_negative = np.clip(page.readability_negative_hits, 0.0, 3.0)
    direct_class = np.clip(direct_positive - direct_negative, -3.0, 3.0)
    ancestor_class = direct_class.copy()
    ancestor_positive = direct_positive.copy()
    ancestor_negative = direct_negative.copy()
    ancestor_ok = page.readability_ok_maybe.astype(np.float64)
    ancestor_unlikely = page.readability_unlikely.astype(np.float64)
    ancestor_role = page.readability_role_rejected.astype(np.float64)
    ancestor_extraneous = page.readability_extraneous.astype(np.float64)
    ancestor_byline = page.readability_byline.astype(np.float64)
    ancestor_share = page.readability_share.astype(np.float64)
    max_repeated = np.maximum(0.0, page.features[:, 12] - np.log(2.0))
    repeated_count = (page.features[:, 12] > np.log(2.0) + 1e-12).astype(np.float64)

    components = page.readability_root_scores
    evidence_scope = np.log1p(np.maximum(0.0, components["evidence"])) / 8.0
    positive_scope = np.clip(np.maximum(0.0, components["full"]) / 25.0, 0.0, 4.0)
    negative_scope = np.clip(np.maximum(0.0, -components["full"]) / 25.0, 0.0, 4.0)
    link_density_scope = np.clip(1.0 - components["link-factor"], 0.0, 1.0)

    for index in range(1, count):
        parent = page.parent[index]
        ancestor_class[index] = np.clip(
            ancestor_class[index] + ancestor_class[parent], -3.0, 3.0
        )
        ancestor_positive[index] = min(
            3.0, ancestor_positive[index] + ancestor_positive[parent]
        )
        ancestor_negative[index] = min(
            3.0, ancestor_negative[index] + ancestor_negative[parent]
        )
        ancestor_ok[index] = max(ancestor_ok[index], ancestor_ok[parent])
        ancestor_unlikely[index] = max(
            ancestor_unlikely[index], ancestor_unlikely[parent]
        )
        ancestor_role[index] = max(ancestor_role[index], ancestor_role[parent])
        ancestor_extraneous[index] = max(
            ancestor_extraneous[index], ancestor_extraneous[parent]
        )
        ancestor_byline[index] = max(
            ancestor_byline[index], ancestor_byline[parent]
        )
        ancestor_share[index] = max(ancestor_share[index], ancestor_share[parent])
        evidence_scope[index] = max(evidence_scope[index], evidence_scope[parent])
        positive_scope[index] = max(positive_scope[index], positive_scope[parent])
        negative_scope[index] = max(negative_scope[index], negative_scope[parent])
        link_density_scope[index] = max(
            link_density_scope[index], link_density_scope[parent]
        )
        max_repeated[index] = max(max_repeated[index], max_repeated[parent])
        repeated_count[index] = min(
            3.0, repeated_count[index] + repeated_count[parent]
        )

    return np.column_stack((
        ancestor_class,
        ancestor_positive,
        ancestor_negative,
        ancestor_ok,
        ancestor_unlikely,
        ancestor_role,
        ancestor_extraneous,
        ancestor_byline,
        ancestor_share,
        evidence_scope,
        positive_scope,
        negative_scope,
        link_density_scope,
        np.clip(max_repeated, 0.0, 4.0) / 4.0,
        repeated_count / 3.0,
        (np.clip(max_repeated, 0.0, 4.0) / 4.0) * (1.0 - page.features[:, 6]),
        direct_class,
        page.readability_ok_maybe,
        page.readability_unlikely,
        page.readability_role_rejected,
    )).astype(np.float64)


def replace_context(items):
    return [
        BASE.StudyPage(item.page, full_context(item.page), item.corpus)
        for item in items
    ]


def fit_increment(
    zh_pages,
    wcxb_pages,
    *,
    regularization: float,
    wcxb_corpus_weight: float,
) -> np.ndarray:
    groups = [(zh_pages, 1.0)]
    if wcxb_pages and wcxb_corpus_weight:
        groups.append((wcxb_pages, wcxb_corpus_weight))
    matrices = []
    labels = []
    offsets = []
    weights = []
    for pages, corpus_weight in groups:
        fit_pages = [item for item in pages if item.page.status == "extract"]
        corpus_tokens = sum(
            float(item.page.tokens[item.page.tokens > 0].sum())
            for item in fit_pages
        )
        if not corpus_tokens:
            continue
        for item in fit_pages:
            page = item.page
            selected = page.tokens > 0
            if not np.any(selected):
                continue
            matrices.append(item.context[selected])
            labels.append(page.gold_keep[selected].astype(np.float64))
            offsets.append((
                TRAINER.CURRENT_THETA[0]
                + page.features @ TRAINER.CURRENT_THETA[1:]
            )[selected])
            weights.append(
                page.tokens[selected] * corpus_weight / corpus_tokens
            )
    matrix = np.concatenate(matrices)
    label = np.concatenate(labels)
    offset = np.concatenate(offsets)
    weight = np.concatenate(weights)

    def objective(beta: np.ndarray):
        logit = offset + matrix @ beta
        probability = 1.0 / (1.0 + np.exp(-np.clip(logit, -50.0, 50.0)))
        loss = float(np.sum(
            weight * (np.logaddexp(0.0, logit) - label * logit)
        ))
        loss += 0.5 * regularization * float(beta @ beta)
        gradient = (
            matrix.T @ (weight * (probability - label))
            + regularization * beta
        )
        return loss, gradient

    fitted = minimize(
        objective,
        np.zeros(zh_pages[0].context.shape[1], dtype=np.float64),
        jac=True,
        method="L-BFGS-B",
        options={"maxiter": 300, "ftol": 1e-12, "gtol": 1e-9},
    )
    if not fitted.success:
        raise RuntimeError(f"full Readability residual fit failed: {fitted.message}")
    return np.asarray(fitted.x, dtype=np.float64)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--root-weight", type=float, default=0.25)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument(
        "--feature-set", choices=sorted(FEATURE_SETS), default="boundary"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    feature_indices = FEATURE_SETS[args.feature_set]
    feature_names = [FEATURE_NAMES[index] for index in feature_indices]
    zh = replace_context(BASE.load_study_pages(args.zh_units, "zh"))
    wcxb = replace_context(
        BASE.load_study_pages(args.wcxb_units, "wcxb")
    ) if args.wcxb_units else []
    for item in [*zh, *wcxb]:
        item.context = item.context[:, feature_indices]
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wcxb_holdout = [item for item in wcxb if item.page.split == "wcxb-holdout"]
    indices = np.arange(len(zh))
    groups = np.asarray([item.page.site_family for item in zh])
    beta_for_page = {}
    fold_reports = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        train = [zh[int(index)] for index in train_indices]
        test = [zh[int(index)] for index in test_indices]
        beta = fit_increment(
            train,
            wcxb_train,
            regularization=args.regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        for item in test:
            beta_for_page[item.page.id] = beta
        rows, _ = BASE.score_rows(
            test,
            {item.page.id: beta for item in test},
            args.root_weight,
        )
        fold_reports.append({
            "fold": fold,
            "trainPages": len(train),
            "testPages": len(test),
            "testSiteFamilies": len({item.page.site_family for item in test}),
            "beta": beta.tolist(),
            "summary": BASE.summarize(rows),
        })
        print(json.dumps({
            "fold": fold,
            "summary": fold_reports[-1]["summary"],
        }, ensure_ascii=False), flush=True)
    rows, _ = BASE.score_rows(zh, beta_for_page, args.root_weight)
    final_beta = fit_increment(
        zh,
        wcxb_train,
        regularization=args.regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    holdout_rows, _ = BASE.score_rows(
        wcxb_holdout,
        {item.page.id: final_beta for item in wcxb_holdout},
        args.root_weight,
    ) if wcxb_holdout else ([], {})
    report = {
        "schema": "qingzhou.tree-dp-readability-full-study.v1",
        "protocol": {
            "featureNames": feature_names,
            "baseScorer": "shipped-v6b-fixed-offset",
            "fitStatuses": ["extract"],
            "recurrence": "single-tree-dp-keep-carve-descend",
            "rootFeasibleSet": "exclude-dependent-html-fragments-inside-dp",
            "rootPrior": "one-readability-primary-root-budget",
            "grouping": "siteFamily",
            "trainingSplits": ["base", "train"],
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbTestOpened": False,
            "runtimeCandidates": False,
            "inferenceComplexity": "O(nodes * featureCount)",
        },
        "hyperparameters": {
            "regularization": args.regularization,
            "rootWeight": args.root_weight,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
            "folds": args.folds,
            "featureSet": args.feature_set,
        },
        "siteFamilyOof": {
            "summary": BASE.summarize(rows),
            "folds": fold_reports,
            "rows": rows,
        },
        "wcxbHoldout": {
            "summary": BASE.summarize(holdout_rows),
            "rows": holdout_rows,
        } if holdout_rows else None,
        "finalBeta": final_beta.tolist(),
        "source": {
            "zh": BASE.source_fingerprints(zh),
            "wcxb": BASE.source_fingerprints(wcxb),
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "baseStudySha256": TRAINER.sha256_file(BASE_PATH),
            "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(args.output),
        "zh": report["siteFamilyOof"]["summary"],
        "wcxb": report["wcxbHoldout"]["summary"] if report["wcxbHoldout"] else None,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
