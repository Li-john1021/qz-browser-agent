#!/usr/bin/env python3
"""Train a globally normalized single-root Tree-DP with structured loss.

Every human-gold extraction in the Chinese development/validation corpus is
representable by one materializable root plus Tree-DP carve decisions.  This
study therefore removes the unlimited disconnected-root forest and makes
``empty`` compete directly with every feasible single root.  Generic
Readability scoring signals are root features, not a runtime candidate.

Training uses a page-balanced latent structured hinge: loss-augmented keep/
carve determines the predicted root, while a constrained DP chooses the best
root compatible with every token-bearing gold decision.  Inference is O(N).
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
ROOT_QUALITY_PATH = HERE / "study-tree-dp-root-quality.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_single_root_quality", ROOT_QUALITY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {ROOT_QUALITY_PATH}")
ROOT_QUALITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ROOT_QUALITY
SPEC.loader.exec_module(ROOT_QUALITY)
READABILITY = ROOT_QUALITY.READABILITY
TRAINER = ROOT_QUALITY.TRAINER

ROOT_FEATURE_SCALE = TRAINER.ROOT_PENALTY
NEGATIVE_INFINITY = -1e100
GENERIC_ROOT_FEATURE_INDICES = [
    0,  # keepScorePerRetainedToken
    1,  # logRetainedTokens
    2,  # retainedPageShare
    11,  # treeBoilerplateHits
    12,  # treeContentHits
    13,  # treeRepeatedLog
    14,  # treeDepth
    15,  # tagBody
    16,  # tagMainOrArticle
    17,  # tagSection
    18,  # tagDiv
    19,  # tagParagraphOrTable
]
READABILITY_SCOPE_FEATURE_NAMES = [
    "readabilityPrimaryScope",
    "readabilityPrimaryScopeScore",
    "readabilityTopFiveMassCoverage",
    "readabilityTopFiveCountCoverage",
    "readabilityPositiveMassCoverage",
]
ROOT_FEATURE_NAMES = [
    *(ROOT_QUALITY.ROOT_FEATURE_NAMES[index] for index in GENERIC_ROOT_FEATURE_INDICES),
    *READABILITY_SCOPE_FEATURE_NAMES,
]
PARAMETER_NAMES = [*ROOT_FEATURE_NAMES, "nonempty"]


@dataclass
class Decode:
    mask: np.ndarray
    root: int | None
    value: float
    retained_tokens: int
    available: bool
    phi: np.ndarray


@dataclass
class Model:
    parameters: np.ndarray
    history: list[dict]


@dataclass(frozen=True)
class ReadabilityProposal:
    attempt: str
    primary: int
    scope: int
    included_siblings: tuple[int, ...]
    primary_score: float


def _readability_attempt_components(
    page,
    *,
    strip_unlikely: bool,
    weight_classes: bool,
) -> dict[str, np.ndarray]:
    """Reproduce Readability's root evidence on the immutable Tree-DP tree.

    Readability mutates a private document while proposing its root.  The
    equivalent immutable operation is to suppress the same unlikely subtrees,
    score the same paragraph-like evidence, and accumulate it into at most five
    ancestors.  Mixed DIV phrasing runs are represented as synthetic evidence
    on their owning DIV; no synthetic node is exposed to Tree-DP.
    """
    total = len(page.tokens)
    removed = np.zeros(total, dtype=bool)
    for index in range(total):
        parent = int(page.parent[index])
        inherited = parent >= 0 and removed[parent]
        removed[index] = inherited or (
            strip_unlikely
            and (page.readability_unlikely[index] or page.readability_role_rejected[index])
        )

    own_chars = np.where(removed, 0.0, page.own_chars)
    # ``ownChars`` uses JavaScript UTF-16 length exactly; commas and terminal
    # period evidence come from the exported direct text.
    comma_marks = [",", "،", "﹐", "︐", "︑", "⹁", "⸴", "⸲", "，"]
    own_commas = np.asarray([
        0.0 if removed[index] else float(sum(
            page.own_text[index].count(mark) for mark in comma_marks
        ))
        for index in range(total)
    ])
    own_anchor_chars = own_chars * page.readability_anchor_weight
    subtree_chars = own_chars.copy()
    subtree_commas = own_commas.copy()
    subtree_anchor_chars = own_anchor_chars.copy()
    sentence_period = np.asarray([
        (". " in text or text.endswith(".")) and not removed[index]
        for index, text in enumerate(page.own_text)
    ], dtype=bool)
    for index in range(total - 1, 0, -1):
        parent = int(page.parent[index])
        if not removed[index]:
            subtree_chars[parent] += subtree_chars[index]
            subtree_commas[parent] += subtree_commas[index]
            subtree_anchor_chars[parent] += subtree_anchor_chars[index]
            sentence_period[parent] |= sentence_period[index]

    block_tags = {"blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul"}
    block_descendant = np.zeros(total, dtype=bool)
    for index in range(total - 1, -1, -1):
        if removed[index]:
            continue
        block_descendant[index] = any(
            not removed[child]
            and (page.tags[child] in block_tags or block_descendant[child])
            for child in page.children[index]
        )

    evidence = np.zeros(total, dtype=np.float64)
    initialized = np.zeros(total, dtype=bool)

    def contribute(start: int, chars: float, commas: float) -> None:
        if chars < 25:
            return
        value = 1.0 + commas + min(math.floor(chars / 100.0), 3)
        ancestor = start
        for depth in range(5):
            if ancestor < 0 or removed[ancestor]:
                break
            divisor = 1 if depth == 0 else (2 if depth == 1 else 3 * depth)
            evidence[ancestor] += value / divisor
            initialized[ancestor] = True
            ancestor = int(page.parent[ancestor])

    score_tags = {"section", "h2", "h3", "h4", "h5", "h6", "p", "td", "pre"}
    for index, tag in enumerate(page.tags):
        if removed[index]:
            continue
        if tag in score_tags or (tag == "div" and not block_descendant[index]):
            contribute(int(page.parent[index]), subtree_chars[index], subtree_commas[index])
        elif tag == "div":
            # Readability wraps every maximal direct phrasing run in a
            # synthetic P.  Its parent is this DIV, so only the ancestor
            # evidence is observable on the immutable Tree-DP coordinate.
            for chars, commas in page.readability_phrasing_runs[index]:
                contribute(index, float(chars), float(commas))

    tag_prior = {
        "div": 5.0, "pre": 3.0, "td": 3.0, "blockquote": 3.0,
        "address": -3.0, "ol": -3.0, "ul": -3.0, "dl": -3.0,
        "dd": -3.0, "dt": -3.0, "li": -3.0, "form": -3.0,
        "h1": -5.0, "h2": -5.0, "h3": -5.0, "h4": -5.0,
        "h5": -5.0, "h6": -5.0, "th": -5.0,
    }
    tag_score = np.asarray([
        tag_prior.get(tag, 0.0) if initialized[index] else 0.0
        for index, tag in enumerate(page.tags)
    ])
    class_score = np.where(
        initialized,
        page.readability_root_scores["class"] if weight_classes else 0.0,
        0.0,
    )
    link_density = np.divide(
        subtree_anchor_chars,
        subtree_chars,
        out=np.zeros_like(subtree_chars),
        where=subtree_chars > 0,
    )
    full = (evidence + tag_score + class_score) * (1.0 - np.clip(link_density, 0.0, 1.0))
    return {
        "evidence": evidence,
        "initialized": initialized,
        "full": full,
        "subtree-chars": subtree_chars,
        "link-density": link_density,
        "sentence-period": sentence_period,
        "removed": removed,
    }


def _promote_readability_primary(page, components) -> int | None:
    scores = components["full"]
    candidates = [int(index) for index in np.flatnonzero(components["initialized"])]
    candidates.sort(key=lambda index: (-float(scores[index]), index))
    top = candidates[:5]
    if not top:
        return next(
            (index for index, tag in enumerate(page.tags) if tag == "body"),
            0 if len(page.tags) else None,
        )
    primary = top[0]
    if page.tags[primary] == "body":
        return primary

    corroborating = []
    if scores[primary] != 0:
        for candidate in top[1:]:
            if scores[candidate] / scores[primary] < 0.75:
                continue
            ancestors = set()
            ancestor = int(page.parent[candidate])
            while ancestor >= 0:
                ancestors.add(ancestor)
                ancestor = int(page.parent[ancestor])
            corroborating.append(ancestors)
    if len(corroborating) >= 3:
        ancestor = int(page.parent[primary])
        while ancestor >= 0 and page.tags[ancestor] != "body":
            if sum(ancestor in values for values in corroborating) >= 3:
                primary = ancestor
                break
            ancestor = int(page.parent[ancestor])

    last_score = float(scores[primary]) if components["initialized"][primary] else 0.0
    threshold = last_score / 3.0
    ancestor = int(page.parent[primary])
    while ancestor >= 0 and page.tags[ancestor] != "body":
        if components["initialized"][ancestor]:
            score = float(scores[ancestor])
            if score < threshold:
                break
            if score > last_score:
                primary = ancestor
                break
            last_score = score
        ancestor = int(page.parent[ancestor])

    ancestor = int(page.parent[primary])
    while ancestor >= 0 and page.tags[ancestor] != "body" and len(page.children[ancestor]) == 1:
        primary = ancestor
        ancestor = int(page.parent[primary])
    return primary


def readability_root_proposals(page) -> list[ReadabilityProposal]:
    """Return Readability's ordered retry proposals plus exact sibling duties.

    Conditional-clean retries do not change root proposal state, so the four
    upstream attempts collapse to three unique structural actions here.
    """
    attempts = (
        ("strict", True, True),
        ("keep-unlikely", False, True),
        ("no-class-weight", False, False),
    )
    proposals: list[ReadabilityProposal] = []
    for name, strip_unlikely, weight_classes in attempts:
        components = _readability_attempt_components(
            page,
            strip_unlikely=strip_unlikely,
            weight_classes=weight_classes,
        )
        primary = _promote_readability_primary(page, components)
        if primary is None:
            continue
        scope = int(page.parent[primary])
        if scope < 0 or page.tags[primary] == "body":
            scope = primary
        threshold = max(10.0, 0.2 * float(components["full"][primary]))
        siblings = []
        for sibling in page.children[scope] if scope != primary else [primary]:
            if components["removed"][sibling]:
                continue
            include = sibling == primary
            bonus = 0.0
            if (
                page.readability_has_class[primary]
                and page.readability_sibling_class_group[sibling]
                == page.readability_sibling_class_group[primary]
            ):
                bonus = 0.2 * float(components["full"][primary])
            if components["initialized"][sibling] and components["full"][sibling] + bonus >= threshold:
                include = True
            elif page.tags[sibling] == "p":
                chars = float(components["subtree-chars"][sibling])
                density = float(components["link-density"][sibling])
                include = (
                    (chars > 80 and density < 0.25)
                    or (0 < chars < 80 and density == 0 and components["sentence-period"][sibling])
                )
            if include:
                siblings.append(int(sibling))
        if not siblings:
            siblings = [primary]
        proposal = ReadabilityProposal(
            name,
            primary,
            scope,
            tuple(siblings),
            float(components["full"][primary]),
        )
        if not proposals or (
            proposal.scope,
            proposal.included_siblings,
        ) != (
            proposals[-1].scope,
            proposals[-1].included_siblings,
        ):
            proposals.append(proposal)
    return proposals


def readability_primary_scope(page) -> tuple[int | None, int | None, np.ndarray]:
    """Mirror Readability's top-candidate promotion without creating a candidate.

    Readability's important root-selection trick is not its local class score by
    itself: a narrow, high-density top candidate is promoted through corroborating
    candidates/ancestors, then its parent becomes the scope whose qualifying
    siblings are collected.  A Tree-DP root can represent the same scope and carve
    unwanted siblings, so expose that decision as page-internal unary features.
    """
    scores = page.readability_root_scores["full"]
    evidence = page.readability_root_scores["evidence"]
    candidates = [
        int(index)
        for index in np.flatnonzero((evidence > 0) & (scores > 0))
    ]
    candidates.sort(key=lambda index: (-float(scores[index]), index))
    top = candidates[:5]
    if not top:
        return None, None, np.zeros(len(page.tokens), dtype=bool)

    primary = top[0]
    corroborating_ancestors: list[set[int]] = []
    if scores[primary] > 0:
        for candidate in top[1:]:
            if scores[candidate] / scores[primary] < 0.75:
                continue
            ancestors: set[int] = set()
            ancestor = int(page.parent[candidate])
            while ancestor >= 0:
                ancestors.add(ancestor)
                ancestor = int(page.parent[ancestor])
            corroborating_ancestors.append(ancestors)
    if len(corroborating_ancestors) >= 3:
        ancestor = int(page.parent[primary])
        while ancestor >= 0 and page.tags[ancestor] != "body":
            if sum(ancestor in values for values in corroborating_ancestors) >= 3:
                primary = ancestor
                break
            ancestor = int(page.parent[ancestor])

    last_score = float(scores[primary]) if evidence[primary] > 0 else 0.0
    score_threshold = last_score / 3.0
    ancestor = int(page.parent[primary])
    while ancestor >= 0 and page.tags[ancestor] != "body":
        if evidence[ancestor] > 0:
            score = float(scores[ancestor])
            if score < score_threshold:
                break
            if score > last_score:
                primary = ancestor
                break
            last_score = score
        ancestor = int(page.parent[ancestor])

    ancestor = int(page.parent[primary])
    while (
        ancestor >= 0
        and page.tags[ancestor] != "body"
        and len(page.children[ancestor]) == 1
    ):
        primary = ancestor
        ancestor = int(page.parent[primary])
    scope = int(page.parent[primary])
    if scope < 0:
        scope = primary

    top_mask = np.zeros(len(page.tokens), dtype=bool)
    top_mask[top] = True
    return primary, scope, top_mask


def add_readability_scope_features(root_page):
    page = root_page.item.page
    total = len(page.tokens)
    primary, scope, top_mask = readability_primary_scope(page)
    full = np.maximum(0.0, page.readability_root_scores["full"])
    top_mass = full * top_mask
    subtree_positive_mass = full.copy()
    subtree_top_mass = top_mass.copy()
    subtree_top_count = top_mask.astype(np.float64)
    subtree_best = full.copy()
    for index in range(total - 1, 0, -1):
        parent = int(page.parent[index])
        subtree_positive_mass[parent] += subtree_positive_mass[index]
        subtree_top_mass[parent] += subtree_top_mass[index]
        subtree_top_count[parent] += subtree_top_count[index]
        subtree_best[parent] = max(subtree_best[parent], subtree_best[index])

    primary_scope = np.zeros(total, dtype=np.float64)
    scope_score = np.zeros(total, dtype=np.float64)
    scope_prior = np.zeros(total, dtype=np.float64)
    if primary is not None and scope is not None:
        primary_scope[scope] = 1.0
        scope_score[scope] = min(4.0, float(full[primary]) / 25.0)
        # The high-density candidate locates an article neighbourhood.  It is
        # not itself the article boundary: Readability promotes it and gathers
        # siblings under the resulting scope.  Put the fixed evidence budget
        # on that scope only, instead of rewarding the narrow candidate.
        scope_prior[scope] = float(full[primary])

    total_top_mass = max(1e-12, float(top_mass.sum()))
    total_top_count = max(1.0, float(top_mask.sum()))
    total_positive_mass = max(1e-12, float(full.sum()))
    extra = np.column_stack([
        primary_scope,
        scope_score,
        np.clip(subtree_top_mass / total_top_mass, 0.0, 1.0),
        np.clip(subtree_top_count / total_top_count, 0.0, 1.0),
        np.clip(subtree_positive_mass / total_positive_mass, 0.0, 1.0),
    ]).astype(np.float64)
    root_page.features = np.column_stack([
        root_page.features[:, GENERIC_ROOT_FEATURE_INDICES],
        extra,
    ])
    root_page.readability_scope_prior = scope_prior
    return root_page


def build_root_page(item, beta: np.ndarray):
    return add_readability_scope_features(
        ROOT_QUALITY.build_root_page(item, beta)
    )


def base_local(root_page) -> np.ndarray:
    page = root_page.item.page
    # build_root_page already used these logits to construct its exact keep
    # recurrence.  Reconstruct only for loss-augmented decoding.
    return page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + root_page.item.context @ root_page.beta
    )


def root_phi(root_page, root: int) -> np.ndarray:
    return ROOT_FEATURE_SCALE * np.concatenate([
        root_page.features[root],
        np.ones(1, dtype=np.float64),
    ])


def build_keep(
    root_page,
    local: np.ndarray,
) -> tuple[np.ndarray, list[list[bool]], np.ndarray]:
    page = root_page.item.page
    count = len(page.tokens)
    keep = np.zeros(count, dtype=np.float64)
    choices: list[list[bool]] = [[] for _ in range(count)]
    kept_tokens = page.tokens.copy()
    for index in range(count - 1, -1, -1):
        score = float(local[index])
        selected_tokens = float(page.tokens[index])
        child_choices = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            child_choices.append(bool(retain))
            score += keep[child] if retain else excluded
            if retain:
                selected_tokens += kept_tokens[child]
        keep[index] = score
        choices[index] = child_choices
        kept_tokens[index] = selected_tokens
    return keep, choices, kept_tokens


def reconstruct(root_page, root: int, choices: list[list[bool]]) -> np.ndarray:
    page = root_page.item.page
    retained = np.zeros(len(page.tokens), dtype=bool)
    stack = [root]
    while stack:
        index = stack.pop()
        retained[index] = True
        for offset, child in enumerate(page.children[index]):
            if choices[index][offset]:
                stack.append(child)
    return retained


def decode(
    root_page,
    parameters: np.ndarray,
    *,
    loss_gold: np.ndarray | None = None,
    false_positive_cost: float = 1.25,
    false_negative_cost: float = 0.75,
) -> tuple[Decode, float]:
    page = root_page.item.page
    local = base_local(root_page)
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
            negative = ~loss_gold
            local[negative] += (
                false_positive_cost * page_tokens / negative_tokens
            ) * page.tokens[negative]

    keep, choices, kept_tokens = build_keep(root_page, local)
    raw_prior = 0.25 * root_page.readability_scope_prior
    best_root = None
    best_value = 0.0
    best_phi = np.zeros(len(PARAMETER_NAMES), dtype=np.float64)
    root_allowed = np.asarray([
        tag not in TRAINER.DEPENDENT_ROOT_TAGS for tag in page.tags
    ], dtype=bool)
    for root in np.flatnonzero(root_allowed & (kept_tokens >= TRAINER.MIN_RETAINED_TOKENS)):
        phi = root_phi(root_page, int(root))
        value = keep[root] - TRAINER.ROOT_PENALTY + raw_prior[root] + parameters @ phi
        if value > best_value + 1e-12:
            best_root = int(root)
            best_value = float(value)
            best_phi = phi
    if best_root is None:
        return Decode(
            np.zeros(len(page.tokens), dtype=bool),
            None,
            0.0,
            0,
            False,
            best_phi,
        ), loss_constant
    retained = reconstruct(root_page, best_root, choices)
    retained_tokens = int(page.tokens[retained].sum())
    if retained_tokens < TRAINER.MIN_RETAINED_TOKENS:
        raise AssertionError(f"{page.id}: feasible root materialized below token guard")
    return Decode(
        retained,
        best_root,
        best_value,
        retained_tokens,
        True,
        best_phi,
    ), loss_constant


def constrained_gold(root_page, parameters: np.ndarray) -> tuple[float, np.ndarray]:
    """Canonical single root compatible with all token-bearing decisions.

    Several zero-text ancestor wrappers can materialize the same human text.
    Treating that boundary as latent lets the model choose its own preferred
    gold root and then reinforce it.  The deepest common legal ancestor of all
    positive text nodes is instead a deterministic content scope: wrappers
    above it add no gold information, while descendants cannot cover the gold.
    """
    page = root_page.item.page
    if page.status == "exclude":
        return 0.0, np.zeros(len(PARAMETER_NAMES), dtype=np.float64)

    required = (page.tokens > 0) & page.gold_keep
    forbidden = (page.tokens > 0) & ~page.gold_keep
    required_subtree = required.astype(np.int64)
    for index in range(len(page.tokens) - 1, 0, -1):
        required_subtree[page.parent[index]] += required_subtree[index]
    total_required = int(required_subtree[0])
    if total_required <= 0:
        raise ValueError(f"{page.id}: extract gold has no token-bearing content")

    local = base_local(root_page)
    compatible_keep = np.full(len(page.tokens), NEGATIVE_INFINITY, dtype=np.float64)
    compatible_tokens = page.tokens.copy()
    for index in range(len(page.tokens) - 1, -1, -1):
        if forbidden[index]:
            continue
        score = float(local[index])
        selected_tokens = float(page.tokens[index])
        valid = True
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            if required_subtree[child] > 0:
                choice = compatible_keep[child]
                if choice <= NEGATIVE_INFINITY / 2:
                    valid = False
                    break
                selected_tokens += compatible_tokens[child]
            else:
                choice = max(compatible_keep[child], excluded)
                if compatible_keep[child] >= excluded:
                    selected_tokens += compatible_tokens[child]
            score += choice
        if valid:
            compatible_keep[index] = score
            compatible_tokens[index] = selected_tokens

    covering = np.flatnonzero(required_subtree == total_required)
    if not len(covering):
        raise ValueError(f"{page.id}: no common ancestor covers human gold")
    root = int(covering[-1])
    while root >= 0 and page.tags[root] in TRAINER.DEPENDENT_ROOT_TAGS:
        root = int(page.parent[root])
    if (
        root < 0
        or compatible_keep[root] <= NEGATIVE_INFINITY / 2
        or compatible_tokens[root] < TRAINER.MIN_RETAINED_TOKENS
    ):
        raise ValueError(f"{page.id}: human gold is outside the single-root state space")
    raw_prior = 0.25 * root_page.readability_scope_prior
    phi = root_phi(root_page, root)
    value = (
        compatible_keep[root]
        - TRAINER.ROOT_PENALTY
        + raw_prior[root]
        + parameters @ phi
    )
    return float(value), phi


def train(
    zh_roots: list,
    wcxb_roots: list,
    *,
    epochs: int,
    learning_rate: float,
    regularization: float,
    wcxb_corpus_weight: float,
    false_positive_cost: float,
    false_negative_cost: float,
) -> Model:
    parameters = np.zeros(len(PARAMETER_NAMES), dtype=np.float64)
    first_moment = np.zeros_like(parameters)
    second_moment = np.zeros_like(parameters)
    history = []
    corpora = [(zh_roots, 1.0)]
    if wcxb_roots and wcxb_corpus_weight > 0:
        corpora.append((wcxb_roots, wcxb_corpus_weight))
    total_corpus_weight = sum(weight for roots, weight in corpora if roots)
    for epoch in range(1, epochs + 1):
        gradient = np.zeros_like(parameters)
        hinge_sum = 0.0
        active = 0
        for roots, corpus_weight in corpora:
            if not roots:
                continue
            page_weight = corpus_weight / len(roots) / total_corpus_weight
            for root_page in roots:
                page = root_page.item.page
                page_tokens = max(1.0, float(page.tokens.sum()))
                gold_mask = (page.tokens > 0) & page.gold_keep
                predicted, loss_constant = decode(
                    root_page,
                    parameters,
                    loss_gold=gold_mask,
                    false_positive_cost=false_positive_cost,
                    false_negative_cost=false_negative_cost,
                )
                gold_value, gold_phi = constrained_gold(root_page, parameters)
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
        parameters -= learning_rate * corrected_first / (np.sqrt(corrected_second) + 1e-8)
        objective = hinge_sum + 0.5 * regularization * float(parameters @ parameters)
        history.append({
            "epoch": epoch,
            "objective": objective,
            "activePages": active,
            "parameterNorm": float(np.linalg.norm(parameters)),
            "nonemptyEnergy": float(ROOT_FEATURE_SCALE * parameters[-1]),
        })
    return Model(parameters, history)


def page_row(root_page, model: Model) -> dict:
    page = root_page.item.page
    # Established v7 Tree-DP is the comparison baseline; the candidate is the
    # unified single-root/empty structured model.
    baseline = ROOT_QUALITY.decode(
        root_page,
        np.zeros(len(page.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    candidate, _ = decode(root_page, model.parameters)
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
        "candidateRoots": [] if candidate.root is None else [candidate.root],
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": candidate.retained_tokens,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=0.02)
    parser.add_argument("--regularization", type=float, default=1.0)
    parser.add_argument("--false-positive-cost", type=float, default=1.25)
    parser.add_argument("--false-negative-cost", type=float, default=0.75)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-structured-weight", type=float, default=0.0)
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
    oof_rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups),
        1,
    ):
        train_pages = [pages[int(index)] for index in train_indices]
        test_pages = [pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train_pages,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        train_roots = [build_root_page(item, beta) for item in train_pages]
        test_roots = [build_root_page(item, beta) for item in test_pages]
        wcxb_roots = [build_root_page(item, beta) for item in wcxb_train]
        # Keep the exact local beta alongside each root page.  Root-quality's
        # original prototype did not need it after keep construction.
        for root_page in [*train_roots, *test_roots, *wcxb_roots]:
            root_page.beta = beta
        model = train(
            train_roots,
            wcxb_roots,
            epochs=args.epochs,
            learning_rate=args.learning_rate,
            regularization=args.regularization,
            wcxb_corpus_weight=args.wcxb_structured_weight,
            false_positive_cost=args.false_positive_cost,
            false_negative_cost=args.false_negative_cost,
        )
        rows = [page_row(root_page, model) for root_page in test_roots]
        oof_rows.extend(rows)
        summary = ROOT_QUALITY.summarize(rows)
        folds.append({
            "fold": fold,
            "parameters": model.parameters.tolist(),
            "history": model.history,
            "summary": summary,
        })
        print(json.dumps({"fold": fold, "summary": summary, "history": model.history}, ensure_ascii=False), flush=True)

    oof_summary = ROOT_QUALITY.summarize(oof_rows)
    accepted = (
        oof_summary["regressionsBelowMinusPointOne"] == 0
        and oof_summary["candidateExcludeFalsePositives"]
        <= oof_summary["baselineExcludeFalsePositives"]
        and oof_summary["meanDelta"] > 0
    )
    final_beta = READABILITY.fit_increment(
        pages,
        wcxb_train,
        regularization=args.readability_regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    final_roots = [build_root_page(item, final_beta) for item in pages]
    final_wcxb_roots = [build_root_page(item, final_beta) for item in wcxb_train]
    for root_page in [*final_roots, *final_wcxb_roots]:
        root_page.beta = final_beta
    final_model = train(
        final_roots,
        final_wcxb_roots,
        epochs=args.epochs,
        learning_rate=args.learning_rate,
        regularization=args.regularization,
        wcxb_corpus_weight=args.wcxb_structured_weight,
        false_positive_cost=args.false_positive_cost,
        false_negative_cost=args.false_negative_cost,
    )

    validation_report = None
    wcxb_report = None
    if accepted and validation:
        roots = [build_root_page(item, final_beta) for item in validation]
        for root_page in roots:
            root_page.beta = final_beta
        rows = [page_row(root_page, final_model) for root_page in roots]
        validation_report = {"summary": ROOT_QUALITY.summarize(rows), "rows": rows}
    if accepted and wcxb_holdout:
        roots = [build_root_page(item, final_beta) for item in wcxb_holdout]
        for root_page in roots:
            root_page.beta = final_beta
        rows = [page_row(root_page, final_model) for root_page in roots]
        wcxb_report = {"summary": ROOT_QUALITY.summarize(rows), "rows": rows}

    report = {
        "schema": "qingzhou.tree-dp-single-root-structured-study.v1",
        "protocol": {
            "model": "single-root-or-empty-latent-structured-tree-dp",
            "runtimeReadabilityCandidate": False,
            "rootFeatureNames": ROOT_FEATURE_NAMES,
            "parameterNames": PARAMETER_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "humanGoldRepresentableByOneRoot": True,
            "goldRootCanonicalization": "deepest-common-legal-ancestor",
            "selectionGate": "OOF positive, no delta<-0.1, exclude-FP non-increasing",
            "zhValidationOpened": bool(validation_report),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            "folds": args.folds,
            "epochs": args.epochs,
            "learningRate": args.learning_rate,
            "regularization": args.regularization,
            "falsePositiveCost": args.false_positive_cost,
            "falseNegativeCost": args.false_negative_cost,
            "readabilityRegularization": args.readability_regularization,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
            "wcxbStructuredWeight": args.wcxb_structured_weight,
        },
        "accepted": accepted,
        "siteFamilyOof": {"summary": oof_summary, "rows": oof_rows, "folds": folds},
        "finalModel": {
            "parameters": final_model.parameters.tolist(),
            "history": final_model.history,
        },
        "zhValidation": validation_report,
        "wcxbHoldout": wcxb_report,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "rootQualityStudySha256": TRAINER.sha256_file(ROOT_QUALITY_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "accepted": accepted,
        "oof": oof_summary,
        "validation": validation_report and validation_report["summary"],
        "wcxbHoldout": wcxb_report and wcxb_report["summary"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
