"""Exact benchmark mirror of Qingzhou's shipped Tree-DP recurrence."""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np


CURRENT_COEFFICIENTS = np.asarray([
    0.233591, 0.276023, -0.119059, 0.290607, 0.163986, -0.368303,
    -3.254073, 0.210214, 0.462327, 0.152472, -0.996532, -0.064612,
    0.260533, 2.509179, -1.510555, 3.430879,
], dtype=np.float64)
CURRENT_INTERCEPT = 0.476964
CURRENT_THETA = np.concatenate(([CURRENT_INTERCEPT], CURRENT_COEFFICIENTS))
ROOT_PENALTY = 80.0
EXCLUDE_PENALTY = 20.0
MIN_EXCLUDE_TOKENS = 20.0
MIN_RETAINED_TOKENS = 20
DEPENDENT_ROOT_TAGS = {
    "caption", "col", "colgroup", "dd", "dt", "figcaption", "legend", "li",
    "optgroup", "option", "summary", "tbody", "td", "tfoot", "th", "thead", "tr",
}
ZERO_WIDTH_RE = re.compile("[\u200b-\u200f\ufeff]")
SPACE_RE = re.compile(r"\s+")


@dataclass
class Decode:
    mask: np.ndarray
    roots: list[int]
    value: float
    retained_tokens: int
    available: bool


@dataclass
class Page:
    id: str
    site_family: str
    split: str
    status: str
    reference: str
    parent: np.ndarray
    tags: list[str]
    tokens: np.ndarray
    features: np.ndarray
    gold_known: np.ndarray
    gold_keep: np.ndarray
    children: list[list[int]]
    subtree_tokens: np.ndarray
    readability_root_scores: dict[str, np.ndarray]
    readability_positive_hits: np.ndarray
    readability_negative_hits: np.ndarray
    readability_ok_maybe: np.ndarray
    readability_extraneous: np.ndarray
    readability_byline: np.ndarray
    readability_share: np.ndarray
    readability_unlikely: np.ndarray
    readability_role_rejected: np.ndarray
    sibling_group: np.ndarray
    readability_sibling_class_group: np.ndarray
    readability_has_class: np.ndarray
    readability_anchor_weight: np.ndarray
    readability_phrasing_runs: list[list[tuple[int, int]]]
    own_text: list[str]
    own_chars: np.ndarray
    segments: list[tuple[int, str, bool | None]]
    source_sha256: dict
    shipped: dict


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_text(value: str) -> str:
    return SPACE_RE.sub(
        " ",
        ZERO_WIDTH_RE.sub("", unicodedata.normalize("NFKC", value or "")),
    ).strip()


def trigram_f1(left: str, right: str) -> float:
    left = normalize_text(left)[:80_000]
    right = normalize_text(right)[:80_000]
    if left == right:
        return 1.0
    left_grams = Counter(left[index:index + 3] for index in range(max(0, len(left) - 2)))
    right_grams = Counter(right[index:index + 3] for index in range(max(0, len(right) - 2)))
    if not left_grams or not right_grams:
        return 0.0
    overlap = sum(min(count, right_grams.get(gram, 0)) for gram, count in left_grams.items())
    precision = overlap / sum(left_grams.values())
    recall = overlap / sum(right_grams.values())
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def readability_root_components(
    tree: list[dict],
    parent: np.ndarray,
    children: list[list[int]],
) -> dict[str, np.ndarray]:
    """Mirror Readability's paragraph evidence, tag/class priors, and link density."""
    total = len(tree)
    own_chars = np.asarray([item.get("ownChars", 0) for item in tree], dtype=np.float64)
    comma_marks = [",", "،", "﹐", "︐", "︑", "⹁", "⸴", "⸲", "，"]
    own_commas = np.asarray([
        sum(str(item.get("ownText", "")).count(mark) for mark in comma_marks)
        for item in tree
    ], dtype=np.float64)
    subtree_chars = own_chars.copy()
    subtree_commas = own_commas.copy()
    subtree_anchor_chars = np.asarray([
        item.get("ownChars", 0) * float(item.get(
            "readabilityAnchorWeight", 1.0 if item.get("anchor") else 0.0,
        ))
        for item in tree
    ], dtype=np.float64)
    for index in range(total - 1, 0, -1):
        subtree_chars[parent[index]] += subtree_chars[index]
        subtree_commas[parent[index]] += subtree_commas[index]
        subtree_anchor_chars[parent[index]] += subtree_anchor_chars[index]

    block_tags = {"blockquote", "dl", "div", "img", "ol", "p", "pre", "table", "ul"}
    block_descendant = np.zeros(total, dtype=bool)
    for index in range(total - 1, -1, -1):
        block_descendant[index] = any(
            tree[child].get("tag") in block_tags or block_descendant[child]
            for child in children[index]
        )

    evidence = np.zeros(total, dtype=np.float64)
    initialized = np.zeros(total, dtype=bool)
    score_tags = {"section", "h2", "h3", "h4", "h5", "h6", "p", "td", "pre"}
    for index, item in enumerate(tree):
        tag = str(item.get("tag", ""))
        pseudo_paragraph = tag == "div" and not block_descendant[index]
        if tag not in score_tags and not pseudo_paragraph:
            continue
        chars = subtree_chars[index]
        if chars < 25:
            continue
        contribution = 1.0 + subtree_commas[index] + min(math.floor(chars / 100.0), 3)
        ancestor = int(parent[index])
        for depth in range(5):
            if ancestor < 0:
                break
            divisor = 1 if depth == 0 else (2 if depth == 1 else 3 * depth)
            evidence[ancestor] += contribution / divisor
            initialized[ancestor] = True
            ancestor = int(parent[ancestor])

    tag_prior = {
        "div": 5.0,
        "pre": 3.0,
        "td": 3.0,
        "blockquote": 3.0,
        "address": -3.0,
        "ol": -3.0,
        "ul": -3.0,
        "dl": -3.0,
        "dd": -3.0,
        "dt": -3.0,
        "li": -3.0,
        "form": -3.0,
        "h1": -5.0,
        "h2": -5.0,
        "h3": -5.0,
        "h4": -5.0,
        "h5": -5.0,
        "h6": -5.0,
        "th": -5.0,
    }
    tag_score = np.zeros(total, dtype=np.float64)
    class_score = np.zeros(total, dtype=np.float64)
    link_factor = np.ones(total, dtype=np.float64)
    for index, item in enumerate(tree):
        if not initialized[index]:
            continue
        if "readabilityClassWeight" not in item:
            raise ValueError("training unit lacks exact Readability class/id features")
        tag_score[index] = tag_prior.get(str(item.get("tag", "")), 0.0)
        class_score[index] = float(item["readabilityClassWeight"])
        density = subtree_anchor_chars[index] / subtree_chars[index] if subtree_chars[index] else 0.0
        link_factor[index] = 1.0 - min(1.0, max(0.0, density))
    raw = evidence + tag_score + class_score
    return {
        "evidence": evidence,
        "class": class_score,
        "tag": tag_score,
        "link-factor": link_factor,
        "subtree-chars": subtree_chars,
        "subtree-anchor-chars": subtree_anchor_chars,
        "evidence-tag": evidence + tag_score,
        "evidence-tag-class": raw,
        "full": raw * link_factor,
        "initialized": initialized,
    }


def decode(
    page: Page,
    theta: np.ndarray,
    *,
    root_score: np.ndarray | None = None,
    root_weight: float = 0.0,
) -> Decode:
    total = len(page.tokens)
    local = page.tokens * (theta[0] + page.features @ theta[1:])
    keep = np.zeros(total, dtype=np.float64)
    free = np.zeros(total, dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(total)]
    free_root = np.zeros(total, dtype=bool)
    if root_score is None:
        root_score = np.zeros(total, dtype=np.float64)
    for index in range(total - 1, -1, -1):
        kept = float(local[index])
        choices = []
        for child in page.children[index]:
            excluded = -EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            kept += keep[child] if retain else excluded
            choices.append(bool(retain))
        keep[index] = kept
        keep_choice[index] = choices
        descend = sum(free[child] for child in page.children[index])
        as_root = kept - ROOT_PENALTY + root_weight * root_score[index]
        if as_root >= descend and as_root > 0:
            free[index] = as_root
            free_root[index] = True
        else:
            free[index] = max(0.0, descend)

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
    available = retained_tokens >= MIN_RETAINED_TOKENS and not any(
        page.tags[root] in DEPENDENT_ROOT_TAGS for root in roots
    )
    return Decode(retained, roots, float(free[0]), retained_tokens, available)


def materialized_text(page: Page, mask: np.ndarray) -> str:
    return normalize_text("".join(text for owner, text, _gold in page.segments if mask[owner]))


def page_from_record(
    record: dict,
    allowed_splits: set[str],
    *,
    verify_shipped_base_model: bool = True,
) -> Page:
    if record.get("schema") != "qingzhou.article-extraction-tree-dp-training-page.v2":
        raise ValueError(f"{record.get('id', 'unknown')}: unsupported training page schema")
    if record.get("split") not in allowed_splits:
        raise ValueError(f"{record.get('id')}: refusing split {record.get('split')}")
    replay = record.get("snapshotReplay")
    allowed_replays = ({
        "scripts": "blocked-by-csp",
        "motion": "disabled-by-injected-style",
    }, {
        "scripts": "blocked-by-csp",
        "motion": "disabled-by-injected-style",
        "metaRefresh": "removed-before-navigation",
    }, {
        "scripts": "blocked-by-csp",
        "network": "aborted",
        "motion": "disabled-by-injected-style",
        "metaRefresh": "removed-before-render",
    })
    if replay not in allowed_replays:
        raise ValueError(f"{record.get('id')}: non-deterministic snapshot replay")
    tree = record["tree"]["treeElements"]
    if not tree:
        raise ValueError(f"{record.get('id')}: empty Tree-DP coordinate")
    parent = np.asarray([item["parent"] for item in tree], dtype=np.int64)
    tokens = np.asarray([item["tokens"] for item in tree], dtype=np.float64)
    features = np.asarray([item["features"] for item in tree], dtype=np.float64)
    if features.shape != (len(tree), 16):
        raise ValueError(f"{record.get('id')}: expected exact 16-D features")
    gold_known = np.asarray([item.get("goldKnown") is True for item in tree], dtype=bool)
    gold_keep = np.asarray([item.get("goldKeep") is True for item in tree], dtype=bool)
    if np.any((tokens > 0) & ~gold_known):
        raise ValueError(f"{record.get('id')}: token-bearing node has unknown gold")
    children: list[list[int]] = [[] for _ in tree]
    for index in range(1, len(tree)):
        if parent[index] < 0 or parent[index] >= index:
            raise ValueError(f"{record.get('id')}: invalid parent preorder at {index}")
        children[parent[index]].append(index)
    subtree_tokens = tokens.copy()
    for index in range(len(tree) - 1, 0, -1):
        subtree_tokens[parent[index]] += subtree_tokens[index]
    segments = [
        (int(segment[0]), str(segment[1]), segment[2] if len(segment) > 2 else None)
        for segment in record["tree"].get("treeTextSegments", [])
    ]
    page = Page(
        id=record["id"],
        site_family=record["siteFamily"],
        split=record["split"],
        status=record["status"],
        reference=record.get("reference", {}).get("mainText", ""),
        parent=parent,
        tags=[str(item["tag"]) for item in tree],
        tokens=tokens,
        features=features,
        gold_known=gold_known,
        gold_keep=gold_keep,
        children=children,
        subtree_tokens=subtree_tokens,
        readability_root_scores=readability_root_components(tree, parent, children),
        readability_positive_hits=np.asarray([
            float(item.get("readabilityPositiveHits", 0.0)) for item in tree
        ], dtype=np.float64),
        readability_negative_hits=np.asarray([
            float(item.get("readabilityNegativeHits", 0.0)) for item in tree
        ], dtype=np.float64),
        readability_ok_maybe=np.asarray([
            bool(item.get("readabilityOkMaybe")) for item in tree
        ], dtype=bool),
        readability_extraneous=np.asarray([
            bool(item.get("readabilityExtraneous")) for item in tree
        ], dtype=bool),
        readability_byline=np.asarray([
            bool(item.get("readabilityByline")) for item in tree
        ], dtype=bool),
        readability_share=np.asarray([
            bool(item.get("readabilityShare")) for item in tree
        ], dtype=bool),
        readability_unlikely=np.asarray([
            bool(item.get("readabilityUnlikely")) for item in tree
        ], dtype=bool),
        readability_role_rejected=np.asarray([
            bool(item.get("readabilityRoleRejected")) for item in tree
        ], dtype=bool),
        sibling_group=np.asarray([
            int(item.get("siblingGroup", 0)) for item in tree
        ], dtype=np.int64),
        readability_sibling_class_group=np.asarray([
            int(item.get("readabilitySiblingClassGroup", item.get("siblingGroup", 0)))
            for item in tree
        ], dtype=np.int64),
        readability_has_class=np.asarray([
            bool(item.get("readabilityHasClass", False)) for item in tree
        ], dtype=bool),
        readability_anchor_weight=np.asarray([
            float(item.get(
                "readabilityAnchorWeight", 1.0 if item.get("anchor") else 0.0,
            ))
            for item in tree
        ], dtype=np.float64),
        readability_phrasing_runs=[[
            (int(run[0]), int(run[1]))
            for run in item.get("readabilityPhrasingRuns", [])
        ] for item in tree],
        own_text=[str(item.get("ownText", "")) for item in tree],
        own_chars=np.asarray([
            float(item.get("ownChars", 0)) for item in tree
        ], dtype=np.float64),
        segments=segments,
        source_sha256=record["sourceSha256"],
        shipped=record["shipped"],
    )
    if verify_shipped_base_model:
        current = decode(page, CURRENT_THETA)
        shipped = page.shipped
        if abs(current.value - float(shipped.get("bestDpScore", current.value))) > 1e-7:
            raise ValueError(f"{page.id}: offline DP score differs from shipped diagnostics")
        if len(current.roots) != int(shipped.get("includeRootCount", len(current.roots))):
            raise ValueError(f"{page.id}: offline roots differ from shipped diagnostics")
        if current.retained_tokens != int(shipped.get("retainedTokens", current.retained_tokens)):
            raise ValueError(f"{page.id}: offline retained tokens differ from shipped diagnostics")
    return page
