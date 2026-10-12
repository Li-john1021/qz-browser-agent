#!/usr/bin/env python3
"""Learn one page-normalized Tree-DP decision over ``empty ∪ legal roots``.

The shipped block scorer and keep/carve recurrence produce, for every element,
the best connected candidate rooted there.  This study replaces the separate
root threshold with a single conditional model: all legal roots and the empty
answer compete in one page-level softmax.  The training unit is a page, never a
DOM node; inference remains O(N) and does not run Readability as a candidate.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.special import logsumexp
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
SINGLE_PATH = HERE / "study-tree-dp-single-root-structured.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_single_root_study", SINGLE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SINGLE_PATH}")
SINGLE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SINGLE
SPEC.loader.exec_module(SINGLE)
READABILITY = SINGLE.READABILITY
ROOT_QUALITY = SINGLE.ROOT_QUALITY
TRAINER = SINGLE.TRAINER


CANDIDATE_AGGREGATE_FEATURE_NAMES = [
    "retainedAnchorShare",
    "retainedBoilerplateShare",
    "retainedContentShare",
    "retainedReadabilityPositiveScopeShare",
    "retainedReadabilityNegativeScopeShare",
    "retainedReadabilityUnlikelyScopeShare",
    "retainedReadabilityExtraneousScopeShare",
    "retainedReadabilityBylineScopeShare",
    "retainedReadabilityShareScopeShare",
    "retainedReadabilityRoleRejectedScopeShare",
    "retainedParagraphShare",
    "retainedHeadingShare",
    "retainedListItemShare",
    "retainedTableShare",
    "retainedPunctuationPerToken",
    "retainedElementCountLog",
    "retainedParagraphCountLog",
    "retainedHeadingCountLog",
    "retainedAnchorCountLog",
    "retainedListItemCountLog",
    "retainedTableCountLog",
    "retainedImageCountLog",
    "retainedControlCountLog",
    "retainedRepeatedMeanLog",
    "retainedRepeatedMaxLog",
    "keptSubtreeTokenShare",
    "documentPosition",
    "documentCentrality",
    "rootChildCountLog",
    "rootDecisionMarginPerToken",
]
ROOT_READABILITY_SIGNAL_FEATURE_NAMES = [
    "rootReadabilityPositiveHits",
    "rootReadabilityNegativeHits",
    "rootReadabilityOkMaybe",
]
CHOICE_FEATURE_NAMES = [
    *ROOT_QUALITY.ROOT_FEATURE_NAMES,
    *SINGLE.READABILITY_SCOPE_FEATURE_NAMES,
    *ROOT_READABILITY_SIGNAL_FEATURE_NAMES,
    *CANDIDATE_AGGREGATE_FEATURE_NAMES,
    "currentEnergyPerRetainedToken",
    "currentEnergyPerPageToken",
    "nonempty",
]


@dataclass
class ChoicePage:
    root_page: object
    indices: np.ndarray
    features: np.ndarray
    energy_offset: np.ndarray
    target_offset: int | None
    current_energy: np.ndarray
    quality: np.ndarray
    best_quality: float
    baseline_quality: float


@dataclass
class ChoiceModel:
    parameters: np.ndarray
    objective: float
    iterations: int
    converged: bool
    message: str


def candidate_aggregate_features(root_page, current_energy: np.ndarray) -> np.ndarray:
    """Aggregate final keep/carve shape for every possible root in O(ND)."""
    page = root_page.item.page
    total = len(page.tokens)
    tags = np.asarray(page.tags)
    tokens = page.tokens
    # Readability's class/id decisions are attached mainly to structural
    # wrappers, most of which have no direct text.  Treat them as the scope of
    # their descendant text rather than weighting the wrapper's own tokens.
    # The resulting columns still aggregate through the exact Tree-DP
    # keep/carve recurrence below, so carved subtrees stop contributing.
    readability_scope = np.zeros((total, 7), dtype=np.float64)
    direct_scope = np.column_stack([
        np.clip(page.readability_positive_hits / 2.0, 0.0, 1.0),
        np.clip(page.readability_negative_hits / 2.0, 0.0, 1.0),
        page.readability_unlikely,
        page.readability_extraneous,
        page.readability_byline,
        page.readability_share,
        page.readability_role_rejected,
    ]).astype(np.float64)
    for index in range(total):
        readability_scope[index] = direct_scope[index]
        parent = int(page.parent[index])
        if parent >= 0:
            readability_scope[index] = np.maximum(
                readability_scope[index], readability_scope[parent]
            )
    # Additive columns.  Token shares use the exact inherited Tree-DP context
    # already present in the shipped 16-D features; counts describe structure.
    additive = np.column_stack([
        tokens,
        tokens * page.features[:, 6],
        tokens * (page.features[:, 10] > 0),
        tokens * (page.features[:, 11] > 0),
        *(tokens * readability_scope[:, column] for column in range(7)),
        tokens * page.features[:, 0],
        tokens * page.features[:, 1],
        tokens * page.features[:, 2],
        tokens * page.features[:, 3],
        tokens * page.features[:, 8],
        np.ones(total, dtype=np.float64),
        (tags == "p").astype(np.float64),
        np.isin(tags, ["h1", "h2", "h3", "h4", "h5", "h6"]).astype(np.float64),
        (tags == "a").astype(np.float64),
        np.isin(tags, ["li", "dt", "dd"]).astype(np.float64),
        np.isin(tags, ["table", "tr", "td", "th"]).astype(np.float64),
        np.isin(tags, ["img", "picture", "figure"]).astype(np.float64),
        np.isin(tags, ["button", "form", "input", "select", "textarea"]).astype(np.float64),
        tokens * page.features[:, 12],
    ]).astype(np.float64)
    maximum_repeat = page.features[:, 12].copy()
    for index in range(total - 1, -1, -1):
        for offset, child in enumerate(page.children[index]):
            if not root_page.keep_choice[index][offset]:
                continue
            additive[index] += additive[child]
            maximum_repeat[index] = max(maximum_repeat[index], maximum_repeat[child])

    retained = np.maximum(1.0, additive[:, 0])
    page_tokens = max(1.0, float(tokens.sum()))
    kept_subtree = np.divide(
        root_page.kept_tokens,
        np.maximum(1.0, page.subtree_tokens),
    )
    position = np.arange(total, dtype=np.float64) / max(1, total - 1)

    plain_free = np.zeros(total, dtype=np.float64)
    root_margin = np.full(total, -4.0, dtype=np.float64)
    for index in range(total - 1, -1, -1):
        descend = sum(plain_free[child] for child in page.children[index])
        if root_page.feasible[index]:
            root_margin[index] = np.clip(
                (current_energy[index] - descend)
                / max(TRAINER.MIN_RETAINED_TOKENS, root_page.kept_tokens[index]),
                -4.0,
                4.0,
            )
            plain_free[index] = max(0.0, descend, current_energy[index])
        else:
            plain_free[index] = max(0.0, descend)

    return np.column_stack([
        additive[:, 1] / retained,
        additive[:, 2] / retained,
        additive[:, 3] / retained,
        additive[:, 4] / retained,
        additive[:, 5] / retained,
        additive[:, 6] / retained,
        additive[:, 7] / retained,
        additive[:, 8] / retained,
        additive[:, 9] / retained,
        additive[:, 10] / retained,
        additive[:, 11] / retained,
        additive[:, 12] / retained,
        additive[:, 13] / retained,
        additive[:, 14] / retained,
        additive[:, 15] / retained,
        np.log1p(additive[:, 16]) / 10.0,
        np.log1p(additive[:, 17]) / 8.0,
        np.log1p(additive[:, 18]) / 8.0,
        np.log1p(additive[:, 19]) / 8.0,
        np.log1p(additive[:, 20]) / 8.0,
        np.log1p(additive[:, 21]) / 8.0,
        np.log1p(additive[:, 22]) / 8.0,
        np.log1p(additive[:, 23]) / 8.0,
        additive[:, 24] / retained,
        maximum_repeat,
        np.clip(kept_subtree, 0.0, 1.0),
        position,
        1.0 - np.abs(2.0 * position - 1.0),
        np.log1p(np.asarray([len(children) for children in page.children])) / 8.0,
        root_margin,
    ]).astype(np.float64)


def build_choice_page(
    item,
    beta: np.ndarray,
    scope_prior_weight: float,
) -> ChoicePage:
    root_page = ROOT_QUALITY.build_root_page(item, beta)
    return build_choice_page_from_root_page(root_page, scope_prior_weight)


def build_choice_page_from_root_page(
    root_page,
    scope_prior_weight: float,
) -> ChoicePage:
    """Build page-global root actions from an already decoded local state.

    Keeping this boundary explicit lets benchmark studies compare alternative
    local keep/carve energies without copying or subtly changing the global
    Readability-derived root features.  The production path above remains the
    exact linear local scorer.
    """
    item = root_page.item
    direct_features = root_page.features.copy()
    SINGLE.add_readability_scope_features(root_page)
    scope_features = root_page.features[:, -len(SINGLE.READABILITY_SCOPE_FEATURE_NAMES):]
    page = item.page
    raw_prior = (
        0.25 * page.readability_root_scores["evidence-tag-class"]
        + scope_prior_weight * root_page.readability_scope_prior
    )
    current_energy = root_page.keep - TRAINER.ROOT_PENALTY + raw_prior
    aggregate_features = candidate_aggregate_features(root_page, current_energy)
    root_readability_features = np.column_stack([
        np.clip(page.readability_positive_hits / 2.0, 0.0, 1.0),
        np.clip(page.readability_negative_hits / 2.0, 0.0, 1.0),
        page.readability_ok_maybe.astype(np.float64),
    ])
    indices = np.flatnonzero(root_page.feasible)
    if not len(indices):
        return ChoicePage(
            root_page,
            indices,
            np.zeros((0, len(CHOICE_FEATURE_NAMES)), dtype=np.float64),
            np.zeros(0, dtype=np.float64),
            None,
            current_energy,
            np.zeros(0, dtype=np.float64),
            0.0,
            0.0,
        )
    retained = np.maximum(TRAINER.MIN_RETAINED_TOKENS, root_page.kept_tokens[indices])
    page_tokens = max(1.0, float(page.tokens.sum()))
    best_energy = max(0.0, float(np.max(current_energy[indices])))
    # Treat the shipped root energy as a fixed prior, not another freely
    # learned feature.  A learned coefficient repeatedly overrode stable
    # ordering on unseen site families.  The global model below therefore
    # learns only a residual around this page-local prior.
    energy_offset = np.clip(
        (current_energy[indices] - best_energy) / TRAINER.ROOT_PENALTY,
        -8.0,
        0.0,
    )
    energy_features = np.column_stack([
        np.clip(current_energy[indices] / retained, -4.0, 4.0),
        np.clip(current_energy[indices] / page_tokens, -4.0, 4.0),
        np.ones(len(indices), dtype=np.float64),
    ])
    features = np.column_stack([
        direct_features[indices],
        scope_features[indices],
        root_readability_features[indices],
        aggregate_features[indices],
        energy_features,
    ]).astype(np.float64)

    target_offset = None
    quality = np.zeros(len(indices), dtype=np.float64)
    best_quality = 0.0
    baseline_quality = 0.0
    if page.status == "extract":
        quality = root_page.target[indices].copy()
        best_quality = float(np.max(quality))
        baseline = ROOT_QUALITY.decode(
            root_page,
            np.zeros(len(page.tokens), dtype=np.float64),
            0.0,
            0.0,
        )
        selected = float(page.tokens[baseline.mask].sum())
        gold = float(page.tokens[page.gold_keep].sum())
        matched = float(page.tokens[baseline.mask & page.gold_keep].sum())
        precision = matched / selected if selected else 0.0
        recall = matched / gold if gold else 0.0
        baseline_quality = (
            2.0 * precision * recall / (precision + recall)
            if precision + recall
            else 0.0
        )
        tied = np.flatnonzero(quality >= best_quality - 1e-12)
        # Stable gold boundary: maximize exact materialized mask quality, then
        # prefer the current DP energy and finally document order.
        target_offset = int(max(
            tied,
            key=lambda offset: (
                float(current_energy[indices[offset]]),
                -int(indices[offset]),
            ),
        ))
    return ChoicePage(
        root_page,
        indices,
        features,
        energy_offset,
        target_offset,
        current_energy,
        quality,
        best_quality,
        baseline_quality,
    )


def page_weights(
    pages: list[ChoicePage],
    corpus_weight: float,
    exclude_weight: float,
    site_family_balanced: bool,
) -> np.ndarray:
    raw = np.asarray([
        exclude_weight if page.root_page.item.page.status == "exclude" else 1.0
        for page in pages
    ], dtype=np.float64)
    if not site_family_balanced:
        return corpus_weight * raw / max(1e-12, float(raw.sum()))
    families: dict[str, list[int]] = {}
    for index, page in enumerate(pages):
        families.setdefault(page.root_page.item.page.site_family, []).append(index)
    weights = np.zeros(len(pages), dtype=np.float64)
    family_mass = corpus_weight / max(1, len(families))
    for member_indices in families.values():
        family_raw = raw[member_indices]
        denominator = max(1e-12, float(family_raw.sum()))
        weights[member_indices] = family_mass * family_raw / denominator
    return weights


def fit_choice_model(
    zh_pages: list[ChoicePage],
    wcxb_pages: list[ChoicePage],
    *,
    regularization: float,
    wcxb_corpus_weight: float,
    exclude_weight: float,
    loss_margin: float,
    risk_margin: float,
    current_energy_prior: float,
    site_family_balanced: bool,
    maximum_iterations: int,
) -> ChoiceModel:
    corpora = [(zh_pages, 1.0)]
    if wcxb_pages and wcxb_corpus_weight > 0:
        corpora.append((wcxb_pages, wcxb_corpus_weight))
    weighted_pages: list[tuple[ChoicePage, float]] = []
    total_corpus_weight = sum(weight for pages, weight in corpora if pages)
    for pages, corpus_weight in corpora:
        if not pages:
            continue
        weights = page_weights(
            pages,
            corpus_weight / total_corpus_weight,
            exclude_weight if corpus_weight == 1.0 else 1.0,
            site_family_balanced,
        )
        weighted_pages.extend(zip(pages, weights, strict=True))

    def objective(parameters: np.ndarray) -> tuple[float, np.ndarray]:
        value = 0.5 * regularization * float(parameters @ parameters)
        gradient = regularization * parameters
        for page, weight in weighted_pages:
            scores = (
                current_energy_prior * page.energy_offset
                + page.features @ parameters
            )
            if page.target_offset is None:
                root_cost = np.full(
                    len(scores),
                    loss_margin + risk_margin,
                    dtype=np.float64,
                )
                empty_cost = 0.0
            else:
                regression = np.maximum(0.0, page.baseline_quality - page.quality)
                root_cost = (
                    loss_margin * (page.best_quality - page.quality)
                    + risk_margin * regression * regression
                )
                empty_regression = page.baseline_quality
                empty_cost = (
                    loss_margin * page.best_quality
                    + risk_margin * empty_regression * empty_regression
                )
            augmented_scores = scores + root_cost
            denominator = (
                float(np.logaddexp(empty_cost, logsumexp(augmented_scores)))
                if len(scores)
                else empty_cost
            )
            value += weight * denominator
            if len(scores):
                probabilities = np.exp(augmented_scores - denominator)
                gradient += weight * (probabilities @ page.features)
            if page.target_offset is not None:
                value -= weight * float(scores[page.target_offset])
                gradient -= weight * page.features[page.target_offset]
        return value, gradient

    initial = np.zeros(len(CHOICE_FEATURE_NAMES), dtype=np.float64)
    result = minimize(
        objective,
        initial,
        jac=True,
        method="L-BFGS-B",
        options={
            "maxiter": maximum_iterations,
            "ftol": 1e-12,
            "gtol": 1e-8,
            "maxls": 50,
        },
    )
    return ChoiceModel(
        np.asarray(result.x, dtype=np.float64),
        float(result.fun),
        int(result.nit),
        bool(result.success),
        str(result.message),
    )


def reconstruct(root_page, root: int) -> np.ndarray:
    page = root_page.item.page
    retained = np.zeros(len(page.tokens), dtype=bool)
    stack = [root]
    while stack:
        index = stack.pop()
        retained[index] = True
        for offset, child in enumerate(page.children[index]):
            if root_page.keep_choice[index][offset]:
                stack.append(child)
    return retained


def page_row(
    page: ChoicePage,
    model: ChoiceModel,
    current_energy_prior: float,
) -> dict:
    root_page = page.root_page
    source = root_page.item.page
    baseline = ROOT_QUALITY.decode(
        root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    scores = (
        current_energy_prior * page.energy_offset
        + page.features @ model.parameters
    )
    offset = int(np.argmax(scores)) if len(scores) and float(np.max(scores)) > 0 else None
    root = int(page.indices[offset]) if offset is not None else None
    mask = reconstruct(root_page, root) if root is not None else np.zeros(len(source.tokens), dtype=bool)
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
        "choiceScore": float(scores[offset]) if offset is not None else 0.0,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--regularization", type=float, default=1.0)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--risk-margin", type=float, default=0.0)
    parser.add_argument("--current-energy-prior", type=float, default=1.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.0)
    parser.add_argument("--site-family-balanced", action="store_true")
    parser.add_argument("--maximum-iterations", type=int, default=100)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
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
    wcxb_holdout = [item for item in wcxb if item.page.split == "wcxb-holdout"]

    groups = np.asarray([item.page.site_family for item in pages])
    indices = np.arange(len(pages))
    rows: list[dict] = []
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
            build_choice_page(item, beta, args.scope_prior_weight)
            for item in train_items
        ]
        test_pages = [
            build_choice_page(item, beta, args.scope_prior_weight)
            for item in test_items
        ]
        wcxb_pages = [
            build_choice_page(item, beta, args.scope_prior_weight)
            for item in wcxb_train
        ]
        model = fit_choice_model(
            train_pages,
            wcxb_pages,
            regularization=args.regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
            exclude_weight=args.exclude_weight,
            loss_margin=args.loss_margin,
            risk_margin=args.risk_margin,
            current_energy_prior=args.current_energy_prior,
            site_family_balanced=args.site_family_balanced,
            maximum_iterations=args.maximum_iterations,
        )
        fold_rows = [
            page_row(page, model, args.current_energy_prior)
            for page in test_pages
        ]
        rows.extend(fold_rows)
        summary = ROOT_QUALITY.summarize(fold_rows)
        folds.append({
            "fold": fold,
            "summary": summary,
            "objective": model.objective,
            "iterations": model.iterations,
            "converged": model.converged,
            "message": model.message,
            "parameters": model.parameters.tolist(),
        })
        print(json.dumps({"fold": fold, "summary": summary}, ensure_ascii=False), flush=True)

    oof = ROOT_QUALITY.summarize(rows)
    accepted = (
        oof["meanDelta"] > 0
        and oof["regressionsBelowMinusPointOne"] == 0
        and oof["candidateExcludeFalsePositives"] <= oof["baselineExcludeFalsePositives"]
    )
    final_beta = READABILITY.fit_increment(
        pages,
        wcxb_train,
        regularization=args.readability_regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    final_pages = [
        build_choice_page(item, final_beta, args.scope_prior_weight)
        for item in pages
    ]
    final_wcxb = [
        build_choice_page(item, final_beta, args.scope_prior_weight)
        for item in wcxb_train
    ]
    final_model = fit_choice_model(
        final_pages,
        final_wcxb,
        regularization=args.regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
        exclude_weight=args.exclude_weight,
        loss_margin=args.loss_margin,
        risk_margin=args.risk_margin,
        current_energy_prior=args.current_energy_prior,
        site_family_balanced=args.site_family_balanced,
        maximum_iterations=args.maximum_iterations,
    )

    validation_report = None
    wcxb_report = None
    if accepted and validation:
        validation_pages = [
            build_choice_page(item, final_beta, args.scope_prior_weight)
            for item in validation
        ]
        validation_rows = [
            page_row(page, final_model, args.current_energy_prior)
            for page in validation_pages
        ]
        validation_report = {
            "summary": ROOT_QUALITY.summarize(validation_rows),
            "rows": validation_rows,
        }
    if accepted and wcxb_holdout:
        holdout_pages = [
            build_choice_page(item, final_beta, args.scope_prior_weight)
            for item in wcxb_holdout
        ]
        holdout_rows = [
            page_row(page, final_model, args.current_energy_prior)
            for page in holdout_pages
        ]
        wcxb_report = {
            "summary": ROOT_QUALITY.summarize(holdout_rows),
            "rows": holdout_rows,
        }

    report = {
        "schema": "qingzhou.tree-dp-global-choice-study.v1",
        "protocol": {
            "model": "page-normalized-linear-softmax-over-empty-and-legal-roots",
            "runtimeReadabilityCandidate": False,
            "featureNames": CHOICE_FEATURE_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "pageWeighting": (
                "site-family-balanced-pages-with-explicit-exclude-cost"
                if args.site_family_balanced
                else "page-balanced-with-explicit-exclude-cost"
            ),
            "rootGold": "best-fixed-keep-carve-mask-f1",
            "inferenceComplexity": "O(N)",
            "selectionGate": "OOF positive, no delta<-0.1, exclude-FP non-increasing",
            "zhValidationOpened": bool(validation_report),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            "folds": args.folds,
            "regularization": args.regularization,
            "excludeWeight": args.exclude_weight,
            "lossMargin": args.loss_margin,
            "riskMargin": args.risk_margin,
            "currentEnergyPrior": args.current_energy_prior,
            "scopePriorWeight": args.scope_prior_weight,
            "siteFamilyBalanced": args.site_family_balanced,
            "maximumIterations": args.maximum_iterations,
            "readabilityRegularization": args.readability_regularization,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
        },
        "accepted": accepted,
        "siteFamilyOof": {"summary": oof, "rows": rows, "folds": folds},
        "finalModel": {
            "readabilityBeta": final_beta.tolist(),
            "parameters": final_model.parameters.tolist(),
            "objective": final_model.objective,
            "iterations": final_model.iterations,
            "converged": final_model.converged,
            "message": final_model.message,
        },
        "zhValidation": validation_report,
        "wcxbHoldout": wcxb_report,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "singleRootStudySha256": TRAINER.sha256_file(SINGLE_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "accepted": accepted,
        "oof": oof,
        "validation": validation_report and validation_report["summary"],
        "wcxbHoldout": wcxb_report and wcxb_report["summary"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
