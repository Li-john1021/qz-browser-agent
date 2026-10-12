#!/usr/bin/env python3
"""Train a single Tree-DP model that owns both extraction and abstention.

This is deliberately different from a candidate selector.  ``empty`` and every
materializable content forest live in the same dynamic program.  The model
keeps Qingzhou's shipped 16-D score as an offset, absorbs two Readability-derived
path signals, gives at most one root the Readability primary-candidate prior,
and learns a once-per-page non-empty energy with a page-balanced structured
hinge loss.  Inference remains O(number of DOM elements).

Only base+train site-family folds are used for model development.  Validation
is an explicitly consumed diagnostic and test is never accepted by this tool.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
READABILITY_STUDY_PATH = HERE / "study-tree-dp-readability.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_tree_dp_readability_study",
    READABILITY_STUDY_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {READABILITY_STUDY_PATH}")
READABILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READABILITY
SPEC.loader.exec_module(READABILITY)
TRAINER = READABILITY.TRAINER

LOCAL_FEATURE_NAMES = [
    "intercept",
    *[f"shippedFeature{index}" for index in range(16)],
    *READABILITY.FEATURE_NAMES,
]
NONEMPTY_ENERGY_SCALE = TRAINER.ROOT_PENALTY
NEGATIVE_INFINITY = -1e100


@dataclass
class ForestDecode:
    mask: np.ndarray
    roots: list[int]
    value: float
    retained_tokens: int
    available: bool
    local_phi: np.ndarray
    nonempty_phi: float


@dataclass
class TrainedModel:
    delta: np.ndarray
    nonempty_parameter: float
    history: list[dict]


def local_features(item) -> np.ndarray:
    page = item.page
    return np.column_stack([
        np.ones(len(page.tokens), dtype=np.float64),
        page.features,
        item.context,
    ])


def base_logit(item, beta: np.ndarray) -> np.ndarray:
    page = item.page
    return (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + item.context @ beta
    )


def _reconstruct_forest(
    item,
    keep_choice: list[list[bool]],
    plain_optional_root: np.ndarray,
    plain_required_mode: np.ndarray,
    prior_required_mode: np.ndarray,
) -> tuple[np.ndarray, list[int]]:
    page = item.page
    retained = np.zeros(len(page.tokens), dtype=bool)
    roots: list[int] = []
    # State names: po=plain optional, pr=plain required, rr=one-prior required.
    stack: list[tuple[int, str]] = [(0, "rr")]
    while stack:
        index, state = stack.pop()
        if state == "po":
            if plain_optional_root[index]:
                select_root = True
            else:
                stack.extend((child, "po") for child in page.children[index])
                continue
        elif state == "pr":
            mode = int(plain_required_mode[index])
            if mode == -2:
                select_root = True
            else:
                stack.extend(
                    (child, "pr" if child == mode else "po")
                    for child in page.children[index]
                )
                continue
        else:
            mode = int(prior_required_mode[index])
            if mode == -3:
                select_root = True
            elif mode == -2:
                stack.append((index, "pr"))
                continue
            else:
                stack.extend(
                    (child, "rr" if child == mode else "po")
                    for child in page.children[index]
                )
                continue

        if select_root:
            roots.append(index)
            keep_stack = [index]
            while keep_stack:
                current = keep_stack.pop()
                retained[current] = True
                for offset, child in enumerate(page.children[current]):
                    if keep_choice[current][offset]:
                        keep_stack.append(child)
    return retained, roots


def decode(
    item,
    beta: np.ndarray,
    delta: np.ndarray,
    nonempty_parameter: float,
    *,
    root_weight: float,
    loss_gold: np.ndarray | None = None,
    false_positive_cost: float = 1.25,
    false_negative_cost: float = 0.75,
) -> tuple[ForestDecode, float]:
    """Decode the best valid forest; optionally perform loss augmentation.

    The returned constant is the missing-positive constant in the decomposed
    loss.  Adding it to ``decode.value`` yields score + token loss.
    """
    page = item.page
    features = local_features(item)
    page_tokens = max(1.0, float(page.tokens.sum()))
    local = page.tokens * (base_logit(item, beta) + features @ delta)
    loss_constant = 0.0
    if loss_gold is not None:
        positive_tokens = float(page.tokens[loss_gold].sum())
        negative_tokens = max(0.0, page_tokens - positive_tokens)
        if positive_tokens:
            local[loss_gold] -= (
                false_negative_cost * page_tokens / positive_tokens
            ) * page.tokens[loss_gold]
            loss_constant = false_negative_cost * page_tokens
        if negative_tokens:
            negative = ~loss_gold
            local[negative] += (
                false_positive_cost * page_tokens / negative_tokens
            ) * page.tokens[negative]

    count = len(page.tokens)
    keep = np.zeros(count, dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(count)]
    plain_optional = np.zeros(count, dtype=np.float64)
    plain_optional_root = np.zeros(count, dtype=bool)
    plain_required = np.full(count, NEGATIVE_INFINITY, dtype=np.float64)
    # -2 means this node is the required root; otherwise the value is the one
    # child that carries the non-empty requirement.
    plain_required_mode = np.full(count, -1, dtype=np.int64)
    prior_required = np.full(count, NEGATIVE_INFINITY, dtype=np.float64)
    # -3 means this node is the prior-bearing root, -2 falls back to the plain
    # required solution, otherwise the value is the prior-required child.
    prior_required_mode = np.full(count, -2, dtype=np.int64)
    root_score = page.readability_root_scores["evidence-tag-class"]

    for index in range(count - 1, -1, -1):
        kept = float(local[index])
        choices = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            kept += keep[child] if retain else excluded
            choices.append(bool(retain))
        keep[index] = kept
        keep_choice[index] = choices

        descend = sum(plain_optional[child] for child in page.children[index])
        root_allowed = (
            page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
            and page.subtree_tokens[index] >= TRAINER.MIN_RETAINED_TOKENS
        )
        as_root = kept - TRAINER.ROOT_PENALTY if root_allowed else NEGATIVE_INFINITY
        if as_root >= descend and as_root > 0:
            plain_optional[index] = as_root
            plain_optional_root[index] = True
        else:
            plain_optional[index] = max(0.0, descend)

        plain_required[index] = as_root
        plain_required_mode[index] = -2
        for child in page.children[index]:
            required_child = (
                plain_required[child]
                + descend
                - plain_optional[child]
            )
            if required_child > plain_required[index] + 1e-12:
                plain_required[index] = required_child
                plain_required_mode[index] = child

        prior_required[index] = plain_required[index]
        prior_required_mode[index] = -2
        prior_as_root = as_root + root_weight * root_score[index]
        if prior_as_root > prior_required[index] + 1e-12:
            prior_required[index] = prior_as_root
            prior_required_mode[index] = -3
        for child in page.children[index]:
            required_child = (
                prior_required[child]
                + descend
                - plain_optional[child]
            )
            if required_child > prior_required[index] + 1e-12:
                prior_required[index] = required_child
                prior_required_mode[index] = child

    nonempty_bonus = NONEMPTY_ENERGY_SCALE * nonempty_parameter
    if prior_required[0] + nonempty_bonus <= 0:
        empty = np.zeros(count, dtype=bool)
        return ForestDecode(
            mask=empty,
            roots=[],
            value=0.0,
            retained_tokens=0,
            available=False,
            local_phi=np.zeros(features.shape[1], dtype=np.float64),
            nonempty_phi=0.0,
        ), loss_constant

    retained, roots = _reconstruct_forest(
        item,
        keep_choice,
        plain_optional_root,
        plain_required_mode,
        prior_required_mode,
    )
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        retained[:] = False
        roots = []
        retained_tokens = 0
        value = 0.0
    else:
        value = float(prior_required[0] + nonempty_bonus)
    return ForestDecode(
        mask=retained,
        roots=roots,
        value=value,
        retained_tokens=retained_tokens,
        available=available,
        local_phi=features.T @ (page.tokens * retained),
        nonempty_phi=NONEMPTY_ENERGY_SCALE if available else 0.0,
    ), loss_constant


def constrained_gold_value(
    item,
    beta: np.ndarray,
    delta: np.ndarray,
    nonempty_parameter: float,
    *,
    root_weight: float,
) -> tuple[float, np.ndarray, float]:
    """Best latent structure compatible with all token-bearing gold labels."""
    page = item.page
    features = local_features(item)
    if page.status != "extract":
        return 0.0, np.zeros(features.shape[1], dtype=np.float64), 0.0

    required = (page.tokens > 0) & page.gold_keep
    forbidden = (page.tokens > 0) & ~page.gold_keep
    required_subtree = required.astype(np.int64)
    for index in range(len(page.tokens) - 1, 0, -1):
        required_subtree[page.parent[index]] += required_subtree[index]
    if required_subtree[0] == 0:
        raise ValueError(f"{page.id}: extract gold has no token-bearing content")

    local = page.tokens * (base_logit(item, beta) + features @ delta)
    keep = np.full(len(page.tokens), NEGATIVE_INFINITY, dtype=np.float64)
    plain = np.full(len(page.tokens), NEGATIVE_INFINITY, dtype=np.float64)
    prior = np.full(len(page.tokens), NEGATIVE_INFINITY, dtype=np.float64)
    root_score = page.readability_root_scores["evidence-tag-class"]
    for index in range(len(page.tokens) - 1, -1, -1):
        if not forbidden[index]:
            kept = float(local[index])
            feasible = True
            for child in page.children[index]:
                excluded = (
                    -TRAINER.EXCLUDE_PENALTY * min(
                        1.0,
                        page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
                    )
                    if required_subtree[child] == 0
                    else NEGATIVE_INFINITY
                )
                choice = max(keep[child], excluded)
                if choice <= NEGATIVE_INFINITY / 2:
                    feasible = False
                    break
                kept += choice
            if feasible:
                keep[index] = kept

        root_allowed = (
            page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
            and page.subtree_tokens[index] >= TRAINER.MIN_RETAINED_TOKENS
        )
        as_root = (
            keep[index] - TRAINER.ROOT_PENALTY
            if root_allowed and keep[index] > NEGATIVE_INFINITY / 2
            else NEGATIVE_INFINITY
        )
        descend = NEGATIVE_INFINITY
        if not required[index] and all(
            plain[child] > NEGATIVE_INFINITY / 2
            for child in page.children[index]
        ):
            descend = sum(plain[child] for child in page.children[index])
        empty = 0.0 if required_subtree[index] == 0 else NEGATIVE_INFINITY
        plain[index] = max(empty, as_root, descend)

        prior[index] = plain[index]
        prior_as_root = as_root + root_weight * root_score[index]
        if prior_as_root > prior[index]:
            prior[index] = prior_as_root
        if not required[index] and all(
            plain[child] > NEGATIVE_INFINITY / 2
            for child in page.children[index]
        ):
            plain_descend = sum(plain[child] for child in page.children[index])
            for child in page.children[index]:
                if prior[child] <= NEGATIVE_INFINITY / 2:
                    continue
                prior[index] = max(
                    prior[index],
                    prior[child] + plain_descend - plain[child],
                )
    if prior[0] <= NEGATIVE_INFINITY / 2:
        raise ValueError(f"{page.id}: gold token mask is outside the Tree-DP state space")
    gold_phi = features.T @ (page.tokens * required)
    nonempty_phi = NONEMPTY_ENERGY_SCALE
    value = float(
        prior[0]
        + NONEMPTY_ENERGY_SCALE * nonempty_parameter
    )
    return value, gold_phi, nonempty_phi


def train_structured(
    pages,
    beta: np.ndarray,
    *,
    root_weight: float,
    epochs: int,
    local_learning_rate: float,
    nonempty_learning_rate: float,
    regularization: float,
    nonempty_regularization: float,
    false_positive_cost: float,
    false_negative_cost: float,
    trace: bool = False,
) -> TrainedModel:
    parameters = np.zeros(len(LOCAL_FEATURE_NAMES) + 1, dtype=np.float64)
    first_moment = np.zeros_like(parameters)
    second_moment = np.zeros_like(parameters)
    learning_rates = np.full_like(parameters, local_learning_rate)
    learning_rates[-1] = nonempty_learning_rate
    history = []
    for epoch in range(1, epochs + 1):
        gradient = np.zeros_like(parameters)
        hinge_sum = 0.0
        active = 0
        for item in pages:
            page = item.page
            page_tokens = max(1.0, float(page.tokens.sum()))
            gold_mask = (page.tokens > 0) & page.gold_keep
            predicted, loss_constant = decode(
                item,
                beta,
                parameters[:-1],
                float(parameters[-1]),
                root_weight=root_weight,
                loss_gold=gold_mask,
                false_positive_cost=false_positive_cost,
                false_negative_cost=false_negative_cost,
            )
            gold_value, gold_phi, gold_nonempty_phi = constrained_gold_value(
                item,
                beta,
                parameters[:-1],
                float(parameters[-1]),
                root_weight=root_weight,
            )
            violation = (predicted.value + loss_constant - gold_value) / page_tokens
            if violation <= 1e-12:
                continue
            gradient[:-1] += (predicted.local_phi - gold_phi) / page_tokens
            gradient[-1] += (
                predicted.nonempty_phi - gold_nonempty_phi
            ) / page_tokens
            hinge_sum += violation
            active += 1

        gradient /= max(1, len(pages))
        gradient[:-1] += regularization * parameters[:-1]
        gradient[-1] += nonempty_regularization * parameters[-1]
        first_moment = 0.9 * first_moment + 0.1 * gradient
        second_moment = 0.999 * second_moment + 0.001 * gradient * gradient
        corrected_first = first_moment / (1.0 - 0.9 ** epoch)
        corrected_second = second_moment / (1.0 - 0.999 ** epoch)
        parameters -= (
            learning_rates
            * corrected_first
            / (np.sqrt(corrected_second) + 1e-8)
        )
        objective = (
            hinge_sum / max(1, len(pages))
            + 0.5 * regularization * float(parameters[:-1] @ parameters[:-1])
            + 0.5 * nonempty_regularization * float(parameters[-1] ** 2)
        )
        row = {
            "epoch": epoch,
            "objective": objective,
            "activePages": active,
            "localShiftNorm": float(np.linalg.norm(parameters[:-1])),
            "nonemptyParameter": float(parameters[-1]),
            "nonemptyEnergy": float(NONEMPTY_ENERGY_SCALE * parameters[-1]),
        }
        history.append(row)
        if trace:
            print(json.dumps(row), flush=True)
    return TrainedModel(parameters[:-1].copy(), float(parameters[-1]), history)


def page_row(item, beta: np.ndarray, model: TrainedModel, root_weight: float) -> dict:
    page = item.page
    baseline, _ = decode(
        item,
        beta,
        np.zeros(len(LOCAL_FEATURE_NAMES), dtype=np.float64),
        0.0,
        root_weight=root_weight,
    )
    candidate, _ = decode(
        item,
        beta,
        model.delta,
        model.nonempty_parameter,
        root_weight=root_weight,
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
        "baselineAvailable": baseline.available,
        "candidateAvailable": candidate.available,
        "baselineRoots": baseline.roots,
        "candidateRoots": candidate.roots,
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": candidate.retained_tokens,
    }


def summarize(rows: list[dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    deltas = [row["delta"] for row in extract]
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "baselineMeanF1": float(np.mean([row["baseline"] for row in extract])) if extract else 0.0,
        "candidateMeanF1": float(np.mean([row["candidate"] for row in extract])) if extract else 0.0,
        "meanDelta": float(np.mean(deltas)) if deltas else 0.0,
        "wins": sum(value > 1e-9 for value in deltas),
        "ties": sum(abs(value) <= 1e-9 for value in deltas),
        "losses": sum(value < -1e-9 for value in deltas),
        "worst": min(deltas, default=0.0),
        "regressionsBelowMinusPointOne": sum(value < -0.1 for value in deltas),
        "regressionsBelowMinusPointTwo": sum(value < -0.2 for value in deltas),
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


def masks_for_pages(pages, beta_for_page, model_for_page, root_weight: float) -> dict:
    result = {}
    for item in pages:
        page = item.page
        beta = beta_for_page[page.id]
        model = model_for_page[page.id]
        baseline, _ = decode(
            item,
            beta,
            np.zeros(len(LOCAL_FEATURE_NAMES), dtype=np.float64),
            0.0,
            root_weight=root_weight,
        )
        candidate, _ = decode(
            item,
            beta,
            model.delta,
            model.nonempty_parameter,
            root_weight=root_weight,
        )
        result[page.id] = {
            "baselineRetained": np.flatnonzero(baseline.mask).tolist(),
            "candidateRetained": np.flatnonzero(candidate.mask).tolist(),
            "baselineRoots": baseline.roots,
            "candidateRoots": candidate.roots,
            "baselineAvailable": baseline.available,
            "candidateAvailable": candidate.available,
        }
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--masks-output", type=Path)
    parser.add_argument("--validation-masks-output", type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--regularization", type=float, default=2.0)
    parser.add_argument("--nonempty-regularization", type=float, default=2.0)
    parser.add_argument("--local-learning-rate", type=float, default=0.002)
    parser.add_argument("--nonempty-learning-rate", type=float, default=0.05)
    parser.add_argument("--false-positive-cost", type=float, default=1.25)
    parser.add_argument("--false-negative-cost", type=float, default=0.75)
    parser.add_argument("--root-weight", type=float, default=0.25)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--trace", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    zh_pages = READABILITY.load_study_pages(args.zh_units, "zh")
    validation_pages = READABILITY.load_study_pages(
        args.zh_validation_units,
        "zh",
        allowed_zh_splits=frozenset({"validation"}),
    ) if args.zh_validation_units else []
    wcxb_pages = READABILITY.load_study_pages(args.wcxb_units, "wcxb") if args.wcxb_units else []
    wcxb_train = [item for item in wcxb_pages if item.page.split == "wcxb-train"]

    groups = np.asarray([item.page.site_family for item in zh_pages])
    indices = np.arange(len(zh_pages))
    splitter = GroupKFold(n_splits=args.folds)
    beta_for_page = {}
    model_for_page = {}
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        splitter.split(indices, groups=groups),
        1,
    ):
        train_pages = [zh_pages[int(index)] for index in train_indices]
        test_pages = [zh_pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train_pages,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        model = train_structured(
            train_pages,
            beta,
            root_weight=args.root_weight,
            epochs=args.epochs,
            local_learning_rate=args.local_learning_rate,
            nonempty_learning_rate=args.nonempty_learning_rate,
            regularization=args.regularization,
            nonempty_regularization=args.nonempty_regularization,
            false_positive_cost=args.false_positive_cost,
            false_negative_cost=args.false_negative_cost,
            trace=args.trace,
        )
        rows = [page_row(item, beta, model, args.root_weight) for item in test_pages]
        for item in test_pages:
            beta_for_page[item.page.id] = beta
            model_for_page[item.page.id] = model
        fold_report = {
            "fold": fold,
            "trainPages": len(train_pages),
            "testPages": len(test_pages),
            "testSiteFamilies": len({item.page.site_family for item in test_pages}),
            "readabilityBeta": beta.tolist(),
            "structuredDelta": model.delta.tolist(),
            "nonemptyParameter": model.nonempty_parameter,
            "nonemptyEnergy": NONEMPTY_ENERGY_SCALE * model.nonempty_parameter,
            "history": model.history,
            "summary": summarize(rows),
        }
        folds.append(fold_report)
        print(json.dumps({
            "fold": fold,
            "summary": fold_report["summary"],
            "nonemptyEnergy": fold_report["nonemptyEnergy"],
        }, ensure_ascii=False), flush=True)

    oof_rows = [
        page_row(item, beta_for_page[item.page.id], model_for_page[item.page.id], args.root_weight)
        for item in zh_pages
    ]
    final_beta = READABILITY.fit_increment(
        zh_pages,
        wcxb_train,
        regularization=args.readability_regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    final_model = train_structured(
        zh_pages,
        final_beta,
        root_weight=args.root_weight,
        epochs=args.epochs,
        local_learning_rate=args.local_learning_rate,
        nonempty_learning_rate=args.nonempty_learning_rate,
        regularization=args.regularization,
        nonempty_regularization=args.nonempty_regularization,
        false_positive_cost=args.false_positive_cost,
        false_negative_cost=args.false_negative_cost,
        trace=args.trace,
    )
    validation_rows = [
        page_row(item, final_beta, final_model, args.root_weight)
        for item in validation_pages
    ]
    report = {
        "schema": "qingzhou.tree-dp-full-replacement-study.v1",
        "protocol": {
            "model": "single-tree-dp-with-internal-empty-state",
            "runtimeReadabilityCandidate": False,
            "localFeatureNames": LOCAL_FEATURE_NAMES,
            "readabilitySignals": [
                "exact-positive-negative-class-id-regexes",
                "paragraph-evidence",
                "tag-prior",
                "unlikely-ancestor",
                "one-primary-root-budget",
            ],
            "rootFeasibleSet": "dependent-html-fragments-removed-inside-dp",
            "structuredLoss": "page-balanced-token-fp-fn",
            "grouping": "siteFamily",
            "trainSplits": ["base", "train"],
            "zhValidationOpened": bool(validation_pages),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbTestOpened": False,
            "zhSourceFingerprints": READABILITY.source_fingerprints(zh_pages),
            "zhValidationSourceFingerprints": READABILITY.source_fingerprints(validation_pages),
            "wcxbSourceFingerprints": READABILITY.source_fingerprints(wcxb_pages),
        },
        "hyperparameters": {
            "folds": args.folds,
            "epochs": args.epochs,
            "regularization": args.regularization,
            "nonemptyRegularization": args.nonempty_regularization,
            "localLearningRate": args.local_learning_rate,
            "nonemptyLearningRate": args.nonempty_learning_rate,
            "falsePositiveCost": args.false_positive_cost,
            "falseNegativeCost": args.false_negative_cost,
            "rootWeight": args.root_weight,
            "readabilityRegularization": args.readability_regularization,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
        },
        "siteFamilyOof": {
            "summary": summarize(oof_rows),
            "folds": folds,
            "rows": oof_rows,
        },
        "finalModel": {
            "readabilityBeta": final_beta.tolist(),
            "structuredDelta": final_model.delta.tolist(),
            "nonemptyParameter": final_model.nonempty_parameter,
            "nonemptyEnergy": NONEMPTY_ENERGY_SCALE * final_model.nonempty_parameter,
            "history": final_model.history,
        },
        "zhValidation": {
            "summary": summarize(validation_rows),
            "rows": validation_rows,
        } if validation_rows else None,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "readabilityStudySha256": TRAINER.sha256_file(READABILITY_STUDY_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    if args.masks_output:
        masks = {
            "schema": "qingzhou.tree-dp-full-replacement-oof-masks.v1",
            "protocol": report["protocol"],
            "pages": masks_for_pages(
                zh_pages,
                beta_for_page,
                model_for_page,
                args.root_weight,
            ),
        }
        args.masks_output.parent.mkdir(parents=True, exist_ok=True)
        args.masks_output.write_text(
            json.dumps(masks, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf8",
        )
    if args.validation_masks_output:
        beta_map = {item.page.id: final_beta for item in validation_pages}
        model_map = {item.page.id: final_model for item in validation_pages}
        masks = {
            "schema": "qingzhou.tree-dp-full-replacement-validation-masks.v1",
            "protocol": report["protocol"],
            "pages": masks_for_pages(
                validation_pages,
                beta_map,
                model_map,
                args.root_weight,
            ),
        }
        args.validation_masks_output.parent.mkdir(parents=True, exist_ok=True)
        args.validation_masks_output.write_text(
            json.dumps(masks, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf8",
        )

    print(json.dumps({
        "output": str(args.output),
        "oof": report["siteFamilyOof"]["summary"],
        "validation": report["zhValidation"]["summary"] if report["zhValidation"] else None,
        "finalNonemptyEnergy": report["finalModel"]["nonemptyEnergy"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
