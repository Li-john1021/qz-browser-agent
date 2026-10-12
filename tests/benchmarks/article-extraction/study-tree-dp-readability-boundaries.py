#!/usr/bin/env python3
"""Learn Readability-derived structural boundary energy inside Tree-DP.

The shipped block score is proportional to an element's own text tokens.  A
class/id signal on a zero-text wrapper therefore cannot influence whether its
subtree is kept or carved.  Readability does make that distinction.  This
benchmark-only study adds one small, local structural potential to the exact
keep/carve/descend recurrence and fits it with latent structured loss.

Human gold supervises token-bearing nodes only.  Zero-text wrappers remain
latent: the compatible-gold DP chooses the highest-scoring structure that
produces the complete gold text mask.  Inference stays O(N), constructs no
Readability candidate, and uses no site, URL, page type, or gold feature.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
READABILITY_PATH = HERE / "study-tree-dp-readability.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_readability_boundary_base", READABILITY_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {READABILITY_PATH}")
READABILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READABILITY
SPEC.loader.exec_module(READABILITY)
TRAINER = READABILITY.TRAINER


FEATURE_SCALE = 25.0
ALL_FEATURE_NAMES = [
    "readabilityClassWeight",
    "readabilityOkMaybe",
    "readabilityUnlikely",
    "readabilityRoleRejected",
    "readabilityExtraneous",
    "readabilityByline",
    "readabilityShare",
    "zeroTextRepeatedSiblingLog",
    "repeatedContentMass",
    "repeatedNonAnchorMass",
    "repeatedHeadingScope",
    "repeatedProseScope",
]
FEATURE_SETS = {
    "all": tuple(range(7)),
    # The shipped scorer already sees repeated sibling count on text-bearing
    # nodes.  Its score is token weighted, however, so the same signal is
    # identically zero on the wrapper that defines a repeated card.  Expose
    # only that missing structural term here; repeat==1 has exactly zero
    # potential and therefore cannot reward ordinary wrappers.
    "all-repeated": tuple(range(len(ALL_FEATURE_NAMES))),
    # okMaybe is already the exception used to construct readabilityUnlikely;
    # byline is useful metadata, and share is too collision-prone to be a
    # general subtree-drop signal.  Keep only signals whose semantics directly
    # describe a structural content/noise boundary.
    "core": (0, 2, 3, 4),
    # Readability's sibling inclusion is not a generic repetition bonus: a
    # sibling must look like content.  Couple repetition to independent
    # subtree evidence so repeated navigation/action controls can receive a
    # different weight from result cards and article collections.
    "core-collection": (0, 2, 3, 4, 7, 8, 9, 10, 11),
    # Monotone residual: the shipped scorer remains the complete negative/noise
    # model; collection structure may only add evidence.  This prevents a new
    # wrapper feature from suppressing an already viable content forest.
    "collection-positive": (8, 9, 10, 11),
}
NEGATIVE_INFINITY = -1e100


@dataclass
class BoundaryPage:
    page: object
    features: np.ndarray
    base_energy: np.ndarray | None = None


@dataclass
class Decode:
    mask: np.ndarray
    roots: list[int]
    available: bool
    retained_tokens: int
    value: float
    phi: np.ndarray


@dataclass
class Model:
    parameters: np.ndarray
    history: list[dict]


def boundary_features(page, feature_set: str) -> np.ndarray:
    """Return exact own-element signals; ancestors are deliberately not copied."""
    # Readability's class weight is +25/-25 for each positive/negative match
    # on class and id.  Reconstruct it for every element; the candidate-score
    # mirror intentionally populates class weight only after paragraph
    # evidence has initialized that node, which is too late for a structural
    # boundary potential.
    class_weight = (
        page.readability_positive_hits - page.readability_negative_hits
    )
    repeated_wrapper = np.where(
        page.tokens == 0,
        np.maximum(0.0, page.features[:, 12] - np.log(2.0)),
        0.0,
    )
    subtree_anchor_tokens = page.tokens * page.features[:, 6]
    subtree_heading = np.asarray([
        tag in {"h1", "h2", "h3", "h4", "h5", "h6"}
        for tag in page.tags
    ], dtype=bool)
    subtree_prose = np.asarray([
        tag in {"p", "pre", "blockquote", "td", "th"}
        for tag in page.tags
    ], dtype=bool)
    for index in range(len(page.tokens) - 1, 0, -1):
        parent = page.parent[index]
        subtree_anchor_tokens[parent] += subtree_anchor_tokens[index]
        subtree_heading[parent] |= subtree_heading[index]
        subtree_prose[parent] |= subtree_prose[index]
    subtree_mass = np.minimum(1.0, page.subtree_tokens / 20.0)
    subtree_anchor_share = np.divide(
        subtree_anchor_tokens,
        page.subtree_tokens,
        out=np.zeros_like(subtree_anchor_tokens),
        where=page.subtree_tokens > 0,
    )
    repeated_content_mass = repeated_wrapper * subtree_mass
    all_features = np.column_stack([
        np.clip(class_weight, -2.0, 2.0),
        page.readability_ok_maybe,
        page.readability_unlikely,
        page.readability_role_rejected,
        page.readability_extraneous,
        page.readability_byline,
        page.readability_share,
        repeated_wrapper,
        repeated_content_mass,
        repeated_content_mass * (1.0 - subtree_anchor_share),
        repeated_wrapper * subtree_heading,
        repeated_wrapper * subtree_prose,
    ]).astype(np.float64) * FEATURE_SCALE
    return all_features[:, FEATURE_SETS[feature_set]]


def base_local(page) -> np.ndarray:
    return page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
    )


def item_base_local(item: BoundaryPage) -> np.ndarray:
    """Return the fixed local energy around which the boundary residual fits.

    The standalone study defaults to the shipped 16-D block scorer.  Composite
    benchmark studies may supply an already-fitted single-scorer energy (for
    example the rich Readability-derived linear scorer) without copying or
    changing the latent structured objective below.
    """
    if item.base_energy is None:
        return base_local(item.page)
    values = np.asarray(item.base_energy, dtype=np.float64)
    if values.shape != item.page.tokens.shape:
        raise ValueError(
            f"{item.page.id}: boundary base energy has shape {values.shape}"
        )
    return values


def exclusion_energy(page, child: int) -> float:
    return -TRAINER.EXCLUDE_PENALTY * min(
        1.0,
        page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
    )


def decode(
    item: BoundaryPage,
    parameters: np.ndarray,
    *,
    legal_roots: bool = False,
    loss_gold: np.ndarray | None = None,
    false_positive_cost: float = 1.25,
    false_negative_cost: float = 0.75,
) -> tuple[Decode, float]:
    page = item.page
    total = len(page.tokens)
    local = item_base_local(item) + item.features @ parameters
    page_tokens = max(1.0, float(page.tokens.sum()))
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
            negative = (page.tokens > 0) & ~loss_gold
            local[negative] += (
                false_positive_cost * page_tokens / negative_tokens
            ) * page.tokens[negative]

    dimensions = item.features.shape[1]
    keep = np.zeros(total, dtype=np.float64)
    keep_phi = np.zeros((total, dimensions), dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(total)]
    kept_tokens = page.tokens.copy()
    free = np.zeros(total, dtype=np.float64)
    free_phi = np.zeros((total, dimensions), dtype=np.float64)
    free_root = np.zeros(total, dtype=bool)
    for index in range(total - 1, -1, -1):
        score = float(local[index])
        phi = item.features[index].copy()
        selected_tokens = float(page.tokens[index])
        choices = []
        for child in page.children[index]:
            excluded = exclusion_energy(page, child)
            retain = keep[child] >= excluded
            choices.append(bool(retain))
            if retain:
                score += keep[child]
                phi += keep_phi[child]
                selected_tokens += kept_tokens[child]
            else:
                score += excluded
        keep[index] = score
        keep_phi[index] = phi
        keep_choice[index] = choices
        kept_tokens[index] = selected_tokens

        descend = sum(free[child] for child in page.children[index])
        descend_phi = sum(
            (free_phi[child] for child in page.children[index]),
            start=np.zeros(dimensions, dtype=np.float64),
        )
        # Mirror production exactly: dependent roots participate in the DP and
        # make the materialized candidate unavailable at the final guard.
        # Loss-augmented training can therefore observe and push down such a
        # bad decision instead of silently changing the recurrence.
        root_allowed = (
            not legal_roots
            or page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
        )
        as_root = (
            keep[index] - TRAINER.ROOT_PENALTY
            if root_allowed else NEGATIVE_INFINITY
        )
        if as_root >= descend and as_root > 0:
            free[index] = as_root
            free_phi[index] = keep_phi[index]
            free_root[index] = True
        elif descend > 0:
            free[index] = descend
            free_phi[index] = descend_phi

    retained = np.zeros(total, dtype=bool)
    roots: list[int] = []
    stack = [0]
    while stack:
        index = stack.pop()
        if free_root[index]:
            roots.append(index)
            keep_stack = [index]
            while keep_stack:
                current = keep_stack.pop()
                retained[current] = True
                for offset, child in enumerate(page.children[current]):
                    if keep_choice[current][offset]:
                        keep_stack.append(child)
        else:
            stack.extend(page.children[index])
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS and not any(
        page.tags[root] in TRAINER.DEPENDENT_ROOT_TAGS for root in roots
    )
    return Decode(
        retained,
        roots,
        available,
        retained_tokens,
        float(free[0]),
        free_phi[0].copy(),
    ), loss_constant


def constrained_gold(
    item: BoundaryPage,
    parameters: np.ndarray,
) -> tuple[float, np.ndarray]:
    """Best latent forest compatible with every token-bearing gold decision."""
    page = item.page
    dimensions = item.features.shape[1]
    if page.status == "exclude":
        return 0.0, np.zeros(dimensions, dtype=np.float64)

    required = (page.tokens > 0) & page.gold_keep
    forbidden = (page.tokens > 0) & ~page.gold_keep
    required_subtree = required.astype(np.int64)
    for index in range(len(page.tokens) - 1, 0, -1):
        required_subtree[page.parent[index]] += required_subtree[index]
    if required_subtree[0] <= 0:
        raise ValueError(f"{page.id}: extract gold has no token-bearing content")

    local = item_base_local(item) + item.features @ parameters
    total = len(page.tokens)
    keep = np.full(total, NEGATIVE_INFINITY, dtype=np.float64)
    keep_phi = np.zeros((total, dimensions), dtype=np.float64)
    kept_tokens = page.tokens.copy()
    free = np.full(total, NEGATIVE_INFINITY, dtype=np.float64)
    free_phi = np.zeros((total, dimensions), dtype=np.float64)
    for index in range(total - 1, -1, -1):
        if not forbidden[index]:
            score = float(local[index])
            phi = item.features[index].copy()
            selected_tokens = float(page.tokens[index])
            valid = True
            for child in page.children[index]:
                excluded = exclusion_energy(page, child)
                if required_subtree[child] > 0:
                    if keep[child] <= NEGATIVE_INFINITY / 2:
                        valid = False
                        break
                    score += keep[child]
                    phi += keep_phi[child]
                    selected_tokens += kept_tokens[child]
                elif keep[child] >= excluded:
                    score += keep[child]
                    phi += keep_phi[child]
                    selected_tokens += kept_tokens[child]
                else:
                    score += excluded
            if valid:
                keep[index] = score
                keep_phi[index] = phi
                kept_tokens[index] = selected_tokens

        descend_valid = not required[index]
        descend = 0.0
        descend_phi = np.zeros(dimensions, dtype=np.float64)
        if descend_valid:
            for child in page.children[index]:
                if required_subtree[child] > 0 and free[child] <= NEGATIVE_INFINITY / 2:
                    descend_valid = False
                    break
                if free[child] > NEGATIVE_INFINITY / 2:
                    descend += free[child]
                    descend_phi += free_phi[child]
        best_value = descend if descend_valid else NEGATIVE_INFINITY
        best_phi = descend_phi if descend_valid else np.zeros(dimensions, dtype=np.float64)
        root_allowed = page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
        if (
            root_allowed
            and keep[index] > NEGATIVE_INFINITY / 2
            and kept_tokens[index] >= TRAINER.MIN_RETAINED_TOKENS
        ):
            as_root = keep[index] - TRAINER.ROOT_PENALTY
            if as_root >= best_value:
                best_value = as_root
                best_phi = keep_phi[index]
        if required_subtree[index] == 0 and best_value < 0:
            best_value = 0.0
            best_phi = np.zeros(dimensions, dtype=np.float64)
        free[index] = best_value
        free_phi[index] = best_phi

    if free[0] <= NEGATIVE_INFINITY / 2:
        raise ValueError(f"{page.id}: human gold is outside the Tree-DP state space")
    return float(free[0]), free_phi[0].copy()


def train(
    pages: list[BoundaryPage],
    *,
    feature_names: list[str],
    epochs: int,
    learning_rate: float,
    regularization: float,
    false_positive_cost: float,
    false_negative_cost: float,
    nonnegative: bool,
    semantic_sign_constraints: bool,
    semantic_parameter_cap: float,
    legal_roots: bool,
) -> Model:
    dimensions = pages[0].features.shape[1] if pages else 0
    parameters = np.zeros(dimensions, dtype=np.float64)
    first_moment = np.zeros_like(parameters)
    second_moment = np.zeros_like(parameters)
    history = []
    page_weight = 1.0 / max(1, len(pages))
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
                parameters,
                legal_roots=legal_roots,
                loss_gold=gold_mask,
                false_positive_cost=false_positive_cost,
                false_negative_cost=false_negative_cost,
            )
            gold_value, gold_phi = constrained_gold(item, parameters)
            violation = (predicted.value + loss_constant - gold_value) / page_tokens
            if violation <= 1e-12:
                continue
            gradient += page_weight * (predicted.phi - gold_phi) / page_tokens
            hinge_sum += page_weight * violation
            active += 1
        gradient += regularization * parameters
        first_moment = 0.9 * first_moment + 0.1 * gradient
        second_moment = 0.999 * second_moment + 0.001 * gradient * gradient
        corrected_first = first_moment / (1.0 - 0.9 ** epoch)
        corrected_second = second_moment / (1.0 - 0.999 ** epoch)
        parameters -= learning_rate * corrected_first / (
            np.sqrt(corrected_second) + 1e-8
        )
        if nonnegative:
            parameters = np.maximum(parameters, 0.0)
        if semantic_sign_constraints:
            positive = {
                "readabilityClassWeight",
                "readabilityOkMaybe",
                "zeroTextRepeatedSiblingLog",
                "repeatedContentMass",
                "repeatedNonAnchorMass",
                "repeatedHeadingScope",
                "repeatedProseScope",
            }
            negative = {
                "readabilityUnlikely",
                "readabilityRoleRejected",
                "readabilityExtraneous",
                "readabilityShare",
            }
            for offset, name in enumerate(feature_names):
                if name in positive:
                    parameters[offset] = max(0.0, parameters[offset])
                elif name in negative:
                    parameters[offset] = min(0.0, parameters[offset])
            # Boundary features are emitted on zero-text wrappers and can
            # repeat down a deep DOM path.  Keep one semantic match a small,
            # bounded structural nudge instead of letting a class regex turn
            # into an unbounded hard prune.  FEATURE_SCALE maps this cap to
            # roughly one energy point per matching wrapper by default.
            parameters = np.clip(
                parameters,
                -semantic_parameter_cap,
                semantic_parameter_cap,
            )
        objective = hinge_sum + 0.5 * regularization * float(parameters @ parameters)
        history.append({
            "epoch": epoch,
            "objective": objective,
            "activePages": active,
            "parameterNorm": float(np.linalg.norm(parameters)),
            "parameters": parameters.tolist(),
        })
    return Model(parameters, history)


def page_row(item: BoundaryPage, model: Model, *, legal_roots: bool) -> dict:
    page = item.page
    baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
    candidate, _ = decode(item, model.parameters, legal_roots=legal_roots)
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--only-fold", type=int)
    parser.add_argument("--feature-set", choices=sorted(FEATURE_SETS), default="all")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--regularization", type=float, default=0.25)
    parser.add_argument("--false-positive-cost", type=float, default=1.25)
    parser.add_argument("--false-negative-cost", type=float, default=0.75)
    parser.add_argument("--nonnegative", action="store_true")
    parser.add_argument(
        "--semantic-sign-constraints",
        action="store_true",
        help=(
            "project Readability content evidence to nonnegative weights and "
            "chrome/noise evidence to nonpositive weights after every update"
        ),
    )
    parser.add_argument(
        "--semantic-parameter-cap",
        type=float,
        default=1.0 / FEATURE_SCALE,
        help="absolute coefficient cap for semantic boundary potentials",
    )
    parser.add_argument(
        "--legal-roots",
        action="store_true",
        help="remove parent-dependent HTML fragments from the DP root feasible set",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    study_pages = READABILITY.load_study_pages(args.zh_units, "zh")
    feature_indices = FEATURE_SETS[args.feature_set]
    feature_names = [ALL_FEATURE_NAMES[index] for index in feature_indices]
    pages = [
        BoundaryPage(item.page, boundary_features(item.page, args.feature_set))
        for item in study_pages
    ]
    # Zero structural parameters must be a byte-for-byte decision-equivalent
    # mirror of the shipped recurrence before any learned result is trusted.
    if not args.legal_roots:
        for item in pages:
            baseline = TRAINER.decode(item.page, TRAINER.CURRENT_THETA)
            zero, _ = decode(item, np.zeros(len(feature_names), dtype=np.float64))
            if (
                not np.array_equal(baseline.mask, zero.mask)
                or baseline.roots != zero.roots
                or abs(baseline.value - zero.value) > 1e-7
            ):
                raise ValueError(f"{item.page.id}: zero boundary energy breaks parity")

    groups = np.asarray([item.page.site_family for item in pages])
    indices = np.arange(len(pages))
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        if args.only_fold is not None and fold != args.only_fold:
            continue
        train_pages = [pages[int(index)] for index in train_indices]
        test_pages = [pages[int(index)] for index in test_indices]
        model = train(
            train_pages,
            feature_names=feature_names,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            regularization=args.regularization,
            false_positive_cost=args.false_positive_cost,
            false_negative_cost=args.false_negative_cost,
            nonnegative=args.nonnegative,
            semantic_sign_constraints=args.semantic_sign_constraints,
            semantic_parameter_cap=args.semantic_parameter_cap,
            legal_roots=args.legal_roots,
        )
        fold_rows = [
            page_row(item, model, legal_roots=args.legal_roots)
            for item in test_pages
        ]
        summary = READABILITY.summarize(fold_rows)
        rows.extend(fold_rows)
        folds.append({
            "fold": fold,
            "parameters": model.parameters.tolist(),
            "history": model.history,
            "summary": summary,
        })
        print(json.dumps({"fold": fold, "summary": summary}, ensure_ascii=False), flush=True)

    report = {
        "schema": "qingzhou.tree-dp-readability-boundary-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily GroupKFold",
            "featureNames": feature_names,
            "goldBoundary": "latent-zero-token-structure",
            "semanticSignConstraints": args.semantic_sign_constraints,
            "rootFeasibleSet": (
                "exclude-dependent-html-fragments-inside-dp"
                if args.legal_roots else "shipped-then-materialization-guard"
            ),
            "readabilityCandidateAtInference": False,
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "inferenceComplexity": f"O(nodes * {len(feature_names)})",
        },
        "hyperparameters": vars(args) | {"zh_units": str(args.zh_units), "output": str(args.output)},
        "siteFamilyOof": {
            "summary": READABILITY.summarize(rows),
            "rows": rows,
            "folds": folds,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps(report["siteFamilyOof"]["summary"], ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
