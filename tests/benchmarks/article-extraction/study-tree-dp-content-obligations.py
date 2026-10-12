#!/usr/bin/env python3
"""Test a finite-state content obligation inside the exact Tree-DP.

Readability does not score text blocks independently: paragraph evidence and
the surrounding heading/content scope reinforce one another.  The shipped
Tree-DP is purely additive, so it can prefer a high-scoring body while carving
away a short title, or retain a title-like fragment without prose.

This benchmark-only model augments keep/carve/descend with two presence bits:
heading and prose.  The DP keeps the best structure for all four states and a
three-parameter global potential rewards heading, prose, and their conjunction.
It is still one exact O(4^2 * N) dynamic program, with no Readability candidate
and no site, URL, page type, or gold input at inference.
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
    "qingzhou_content_obligation_base", READABILITY_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {READABILITY_PATH}")
READABILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READABILITY
SPEC.loader.exec_module(READABILITY)
TRAINER = READABILITY.TRAINER


STATE_COUNT = 4
NEGATIVE_INFINITY = -1e100
OBLIGATION_SCALE = TRAINER.ROOT_PENALTY
FEATURE_NAMES = ["hasHeading", "hasProse", "hasHeadingAndProse"]


@dataclass
class Option:
    state: int
    energy: float
    mask: np.ndarray
    roots: list[int]
    available: bool
    retained_tokens: int
    quality: float


@dataclass
class ObligationPage:
    page: object
    options: list[Option]


@dataclass
class Model:
    parameters: np.ndarray
    history: list[dict]


def combine_state(left: int, right: int) -> int:
    return left | right


def state_features(state: int) -> np.ndarray:
    heading = 1.0 if state & 1 else 0.0
    prose = 1.0 if state & 2 else 0.0
    return OBLIGATION_SCALE * np.asarray([
        heading,
        prose,
        heading * prose,
    ], dtype=np.float64)


def own_states(page) -> np.ndarray:
    tags = np.asarray(page.tags)
    total = len(tags)
    block_tags = {"blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul"}
    block_descendant = np.zeros(total, dtype=bool)
    for index in range(total - 1, -1, -1):
        block_descendant[index] = any(
            page.tags[child] in block_tags or block_descendant[child]
            for child in page.children[index]
        )
    heading = np.isin(tags, ["h1", "h2", "h3", "h4", "h5", "h6"])
    prose = np.isin(tags, ["p", "pre", "blockquote", "td", "th", "table", "dl"])
    prose |= (tags == "div") & ~block_descendant & (page.subtree_tokens >= 10)
    return heading.astype(np.int8) | (prose.astype(np.int8) << 1)


def exclusion_energy(page, child: int) -> float:
    return -TRAINER.EXCLUDE_PENALTY * min(
        1.0,
        page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
    )


def build_options(page) -> list[Option]:
    """Compute and materialize the best base-energy forest for every state."""
    total = len(page.tokens)
    own = own_states(page)
    local = page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
    )
    keep = np.full((total, STATE_COUNT), NEGATIVE_INFINITY, dtype=np.float64)
    keep_tokens = np.zeros((total, STATE_COUNT), dtype=np.float64)
    keep_steps: list[list[tuple[np.ndarray, np.ndarray]]] = [
        [] for _ in range(total)
    ]
    free = np.full((total, STATE_COUNT), NEGATIVE_INFINITY, dtype=np.float64)
    free_steps: list[list[tuple[np.ndarray, np.ndarray]]] = [
        [] for _ in range(total)
    ]
    free_root = np.zeros((total, STATE_COUNT), dtype=bool)

    for index in range(total - 1, -1, -1):
        values = np.full(STATE_COUNT, NEGATIVE_INFINITY, dtype=np.float64)
        tokens = np.zeros(STATE_COUNT, dtype=np.float64)
        values[int(own[index])] = float(local[index])
        tokens[int(own[index])] = float(page.tokens[index])
        for child in page.children[index]:
            next_values = np.full(STATE_COUNT, NEGATIVE_INFINITY, dtype=np.float64)
            next_tokens = np.zeros(STATE_COUNT, dtype=np.float64)
            previous_for = np.full(STATE_COUNT, -1, dtype=np.int8)
            child_for = np.full(STATE_COUNT, -2, dtype=np.int8)
            excluded = exclusion_energy(page, child)
            for previous in range(STATE_COUNT):
                if values[previous] <= NEGATIVE_INFINITY / 2:
                    continue
                excluded_value = values[previous] + excluded
                if excluded_value > next_values[previous]:
                    next_values[previous] = excluded_value
                    next_tokens[previous] = tokens[previous]
                    previous_for[previous] = previous
                    child_for[previous] = -1
                for child_state in range(STATE_COUNT):
                    if keep[child, child_state] <= NEGATIVE_INFINITY / 2:
                        continue
                    combined = combine_state(previous, child_state)
                    retained_value = values[previous] + keep[child, child_state]
                    # Production keeps a child on an exact retain/exclude tie.
                    if retained_value >= next_values[combined]:
                        next_values[combined] = retained_value
                        next_tokens[combined] = tokens[previous] + keep_tokens[child, child_state]
                        previous_for[combined] = previous
                        child_for[combined] = child_state
            keep_steps[index].append((previous_for, child_for))
            values = next_values
            tokens = next_tokens
        keep[index] = values
        keep_tokens[index] = tokens

        descend = np.full(STATE_COUNT, NEGATIVE_INFINITY, dtype=np.float64)
        descend[0] = 0.0
        for child in page.children[index]:
            next_values = np.full(STATE_COUNT, NEGATIVE_INFINITY, dtype=np.float64)
            previous_for = np.full(STATE_COUNT, -1, dtype=np.int8)
            child_for = np.full(STATE_COUNT, -1, dtype=np.int8)
            for previous in range(STATE_COUNT):
                if descend[previous] <= NEGATIVE_INFINITY / 2:
                    continue
                for child_state in range(STATE_COUNT):
                    if free[child, child_state] <= NEGATIVE_INFINITY / 2:
                        continue
                    combined = combine_state(previous, child_state)
                    value = descend[previous] + free[child, child_state]
                    if value > next_values[combined]:
                        next_values[combined] = value
                        previous_for[combined] = previous
                        child_for[combined] = child_state
            free_steps[index].append((previous_for, child_for))
            descend = next_values

        for state in range(STATE_COUNT):
            best = descend[state]
            if state == 0:
                best = max(0.0, best)
            as_root = keep[index, state] - TRAINER.ROOT_PENALTY
            if (
                keep_tokens[index, state] >= TRAINER.MIN_RETAINED_TOKENS
                and as_root >= best
                and as_root > 0
            ):
                free[index, state] = as_root
                free_root[index, state] = True
            else:
                free[index, state] = best

    def child_assignments(
        steps: list[tuple[np.ndarray, np.ndarray]], state: int
    ) -> list[int]:
        result = [-1] * len(steps)
        current = state
        for offset in range(len(steps) - 1, -1, -1):
            previous_for, child_for = steps[offset]
            previous = int(previous_for[current])
            if previous < 0:
                raise ValueError(f"{page.id}: invalid obligation backpointer")
            result[offset] = int(child_for[current])
            current = previous
        return result

    def reconstruct_keep(index: int, state: int, mask: np.ndarray) -> None:
        mask[index] = True
        assignments = child_assignments(keep_steps[index], state)
        for child, child_state in zip(page.children[index], assignments, strict=True):
            if child_state >= 0:
                reconstruct_keep(child, child_state, mask)

    def reconstruct_free(
        index: int,
        state: int,
        mask: np.ndarray,
        roots: list[int],
    ) -> None:
        if free_root[index, state]:
            roots.append(index)
            reconstruct_keep(index, state, mask)
            return
        assignments = child_assignments(free_steps[index], state)
        for child, child_state in zip(page.children[index], assignments, strict=True):
            reconstruct_free(child, child_state, mask, roots)

    options = []
    for state in range(STATE_COUNT):
        if free[0, state] <= NEGATIVE_INFINITY / 2:
            continue
        mask = np.zeros(total, dtype=bool)
        roots: list[int] = []
        reconstruct_free(0, state, mask, roots)
        retained_tokens = int(page.tokens[mask].sum())
        available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS and not any(
            page.tags[root] in TRAINER.DEPENDENT_ROOT_TAGS for root in roots
        )
        text = TRAINER.materialized_text(page, mask) if available else ""
        quality = TRAINER.trigram_f1(text, page.reference)
        options.append(Option(
            state,
            float(free[0, state]),
            mask,
            roots,
            available,
            retained_tokens,
            quality,
        ))
    return options


def train(
    pages: list[ObligationPage],
    *,
    epochs: int,
    learning_rate: float,
    regularization: float,
    loss_margin: float,
    tail_loss_margin: float,
    tail_delta: float,
    gold_tolerance: float,
) -> Model:
    parameters = np.zeros(len(FEATURE_NAMES), dtype=np.float64)
    first_moment = np.zeros_like(parameters)
    second_moment = np.zeros_like(parameters)
    history = []
    page_weight = 1.0 / max(1, len(pages))
    for epoch in range(1, epochs + 1):
        gradient = np.zeros_like(parameters)
        hinge_sum = 0.0
        active = 0
        for item in pages:
            page_tokens = max(1.0, float(item.page.tokens.sum()))
            energies = np.asarray([option.energy for option in item.options])
            qualities = np.asarray([option.quality for option in item.options])
            features = np.asarray([state_features(option.state) for option in item.options])
            scores = energies + features @ parameters
            best_quality = float(qualities.max())
            gap = best_quality - qualities
            loss = loss_margin * gap + tail_loss_margin * np.maximum(0.0, gap - tail_delta)
            predicted = int(np.argmax(scores + loss))
            compatible = np.flatnonzero(qualities >= best_quality - gold_tolerance)
            gold = int(compatible[np.argmax(scores[compatible])])
            violation = (scores[predicted] + loss[predicted] - scores[gold]) / page_tokens
            if violation <= 1e-12:
                continue
            gradient += page_weight * (features[predicted] - features[gold]) / page_tokens
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
        history.append({
            "epoch": epoch,
            "objective": hinge_sum + 0.5 * regularization * float(parameters @ parameters),
            "activePages": active,
            "parameters": parameters.tolist(),
        })
    return Model(parameters, history)


def selected_option(item: ObligationPage, parameters: np.ndarray) -> Option:
    scores = np.asarray([
        option.energy + state_features(option.state) @ parameters
        for option in item.options
    ])
    return item.options[int(np.argmax(scores))]


def verify_zero_parameter_parity(pages: list[ObligationPage]) -> dict:
    """Prove that adding the state dimension does not change shipped output.

    Different zero-token wrapper masks are allowed because they contribute no
    score or text.  Availability, materialized text, and every positive-token
    keep/drop decision must remain identical to the shipped scalar recurrence.
    """
    availability_mismatches = []
    text_mismatches = []
    positive_token_mask_mismatches = []
    equivalent_zero_token_mask_pages = []
    parameters = np.zeros(len(FEATURE_NAMES), dtype=np.float64)
    for item in pages:
        page = item.page
        baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
        candidate = selected_option(item, parameters)
        baseline_text = (
            TRAINER.materialized_text(page, baseline.mask)
            if baseline.available else ""
        )
        candidate_text = (
            TRAINER.materialized_text(page, candidate.mask)
            if candidate.available else ""
        )
        if baseline.available != candidate.available:
            availability_mismatches.append(page.id)
        if baseline_text != candidate_text:
            text_mismatches.append(page.id)
        differing = baseline.mask != candidate.mask
        if np.any(differing & (page.tokens > 0)):
            positive_token_mask_mismatches.append(page.id)
        elif np.any(differing):
            equivalent_zero_token_mask_pages.append(page.id)
    if availability_mismatches or text_mismatches or positive_token_mask_mismatches:
        raise ValueError(json.dumps({
            "error": "zero_parameter_parity_failed",
            "availabilityMismatches": availability_mismatches,
            "textMismatches": text_mismatches,
            "positiveTokenMaskMismatches": positive_token_mask_mismatches,
        }))
    return {
        "pages": len(pages),
        "availabilityMismatches": 0,
        "textMismatches": 0,
        "positiveTokenMaskMismatches": 0,
        "equivalentZeroTokenMaskPages": equivalent_zero_token_mask_pages,
    }


def page_row(item: ObligationPage, model: Model) -> dict:
    page = item.page
    baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
    candidate = selected_option(item, model.parameters)
    baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, page.reference)
    return {
        "id": page.id,
        "siteFamily": page.site_family,
        "split": page.split,
        "status": page.status,
        "baseline": baseline_f1,
        "candidate": candidate.quality,
        "delta": candidate.quality - baseline_f1,
        "baselineAvailable": baseline.available,
        "candidateAvailable": candidate.available,
        "baselineRoots": baseline.roots,
        "candidateRoots": candidate.roots,
        "candidateState": candidate.state,
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": candidate.retained_tokens,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--only-fold", type=int)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--learning-rate", type=float, default=0.02)
    parser.add_argument("--regularization", type=float, default=1.0)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--tail-loss-margin", type=float, default=8.0)
    parser.add_argument("--tail-delta", type=float, default=0.1)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    study_pages = READABILITY.load_study_pages(args.zh_units, "zh")
    pages = []
    for offset, study in enumerate(study_pages, 1):
        options = build_options(study.page)
        pages.append(ObligationPage(study.page, options))
        if offset % 100 == 0:
            print(json.dumps({"prepared": offset}), flush=True)

    zero_parameter_parity = verify_zero_parameter_parity(pages)
    print(json.dumps({"zeroParameterParity": zero_parameter_parity}), flush=True)

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
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            regularization=args.regularization,
            loss_margin=args.loss_margin,
            tail_loss_margin=args.tail_loss_margin,
            tail_delta=args.tail_delta,
            gold_tolerance=args.gold_tolerance,
        )
        fold_rows = [page_row(item, model) for item in test_pages]
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
        "schema": "qingzhou.tree-dp-content-obligation-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily GroupKFold",
            "states": ["none", "heading", "prose", "heading+prose"],
            "featureNames": FEATURE_NAMES,
            "readabilityCandidateAtInference": False,
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "inferenceComplexity": "O(nodes * 4^2)",
        },
        "zeroParameterParity": zero_parameter_parity,
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
