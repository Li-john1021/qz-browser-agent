#!/usr/bin/env python3
"""Benchmark-only two-mode Tree-DP with a small generalized EM loop.

The production rich Tree-DP local scorer is a fixed offset.  Two bounded
linear residual heads specialize it without page-type, site, URL, timing, or
gold features at inference:

* focused: exactly one legal root, intended for one heterogeneous primary
  scope (article, entity, product, video, or a single table);
* collection: the ordinary legal forest, intended for repeated cards, lists,
  feeds, rankings, and multi-section aggregate pages.

Gold is used only while fitting.  Each EM round decodes both exact structures,
forms a soft responsibility from their token-mask F1, and refits the two local
residuals.  A small page-level ridge head then chooses between the two modes
from candidate-intrinsic summaries.  Site-family GroupKFold is the only
reported development result; validation/test are rejected by the loader.

This is deliberately a feasibility study, not a production model exporter.
Its materialized text is reconstructed from the frozen source coordinate and
therefore must pass a later browser/materialization parity stage before any
serving conclusion.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tree_dp_training_core as CORE  # noqa: E402


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DISTILL = load_module(
    "qingzhou_focused_collection_distill",
    HERE / "study-tree-dp-candidate-distillation.py",
)
SINGLE = load_module(
    "qingzhou_focused_collection_readability_proposal",
    HERE / "study-tree-dp-single-root-structured.py",
)


MODE_FEATURE_NAMES = [
    *[f"rich{index}" for index in range(11)],
    "paragraph",
    "heading",
    "listItem",
    "tableCell",
    "media",
    "control",
    "logRepeated",
    "subtreeTokenShare",
]
PAGE_FEATURE_NAMES = [
    "available",
    "energyPerPageToken",
    "retainedShare",
    "rootCoverageShare",
    "logRootCount",
    "anchorTokenShare",
    "boilerTokenShare",
    "contentTokenShare",
    "paragraphTokenShare",
    "headingTokenShare",
    "listTokenShare",
    "tableTokenShare",
    "repeatTokenMean",
]
ROOT_FEATURE_NAMES = [
    "currentEnergyPerToken",
    "logKeptTokens",
    "keptPageShare",
    "subtreePageShare",
    "keptSubtreeShare",
    "readabilityEvidence",
    "readabilityTag",
    "readabilityClass",
    "readabilityLinkFactor",
    "readabilityRaw",
    "readabilityFull",
    "body",
    "mainOrArticle",
    "section",
    "div",
    "paragraphOrTable",
    "position",
    "centrality",
    "logChildren",
    *[f"base{index}" for index in range(16)],
    *[f"rich{index}" for index in range(11)],
]
DEPENDENT_ROOT_TAGS = CORE.DEPENDENT_ROOT_TAGS
TEMPERATURE = 0.05
RESPONSIBILITY_FLOOR = 0.05
FOCUSED_ROOT_PRIOR_WEIGHT = 0.25


@dataclass
class ModePage:
    page: CORE.Page
    context: np.ndarray
    source_path: str


@dataclass
class ModeDecode:
    mask: np.ndarray
    roots: list[int]
    energy: float
    retained_tokens: int
    available: bool
    text: str
    quality: float
    summary: np.ndarray


def read_record(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf8") as handle:
        return json.load(handle)


def artifact_local_beta(extractor: Path) -> tuple[np.ndarray, str]:
    source = extractor.read_text(encoding="utf8")
    match = re.search(r"packedBase64:\s*\[(.*?)\]\.join\(\"\"\)", source, re.S)
    if not match:
        raise ValueError("cannot locate Tree-DP packed model artifact")
    chunks = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', match.group(1))
    packed = base64.b64decode("".join(chunks))
    beta = np.frombuffer(packed[: 11 * 8], dtype="<f8").astype(np.float64)
    if beta.shape != (11,) or not np.all(np.isfinite(beta)):
        raise ValueError("invalid packed Tree-DP local beta")
    return beta, hashlib.sha256(extractor.read_bytes()).hexdigest()


def mode_context(item: ModePage) -> np.ndarray:
    page = item.page
    tags = np.asarray(page.tags)
    total_tokens = max(1.0, float(page.tokens.sum()))
    subtree_share = np.clip(page.subtree_tokens / total_tokens, 0.0, 1.0)
    return np.column_stack([
        item.context,
        tags == "p",
        np.char.startswith(tags.astype(str), "h")
        & np.asarray([len(tag) == 2 and tag[1:].isdigit() for tag in tags]),
        np.isin(tags, ["li", "dt", "dd"]),
        np.isin(tags, ["table", "tr", "td", "th"]),
        np.isin(tags, ["img", "picture", "figure", "video", "audio"]),
        np.isin(tags, ["button", "form", "input", "select", "textarea"]),
        np.log1p(np.maximum(1, page.sibling_group)) / 4.0,
        subtree_share,
    ]).astype(np.float64)


def load_pages(directory: Path) -> list[ModePage]:
    report_path = directory / "export-report.json"
    if not report_path.exists():
        raise ValueError(f"missing export report: {report_path}")
    report = json.loads(report_path.read_text(encoding="utf8"))
    if report.get("schema") != "qingzhou.article-extraction-tree-dp-training-export.v2":
        raise ValueError(f"unsupported export schema: {report.get('schema')}")
    if set(report.get("requestedSplits", [])) - {"base", "train"}:
        raise ValueError("refusing an export that opened validation/test")
    paths = sorted(directory.glob("*.json.gz"))
    if len(paths) != report.get("exported"):
        raise ValueError("training export count mismatch")
    result = []
    for path in paths:
        record = read_record(path)
        if record.get("split") not in {"base", "train"}:
            raise ValueError(f"{record.get('id')}: refusing split {record.get('split')}")
        if record.get("sourceSha256") != report.get("sourceSha256"):
            raise ValueError(f"{record.get('id')}: source provenance mismatch")
        page = CORE.page_from_record(
            record,
            {record["split"]},
            verify_shipped_base_model=False,
        )
        context = DISTILL.rich_context(record["tree"]["treeElements"], page)
        if context.shape != (len(page.tokens), 11):
            raise ValueError(f"{page.id}: expected exact 11-D rich context")
        result.append(ModePage(page, context, str(path)))
    return result


def baseline_logits(item: ModePage, local_beta: np.ndarray) -> np.ndarray:
    page = item.page
    return (
        CORE.CURRENT_THETA[0]
        + page.features @ CORE.CURRENT_THETA[1:]
        + item.context @ local_beta
    )


def token_f1(page: CORE.Page, mask: np.ndarray) -> float:
    if page.status != "extract":
        return 1.0 if not np.any(mask & (page.tokens > 0)) else 0.0
    weights = page.tokens
    predicted = mask & (weights > 0)
    gold = page.gold_keep & (weights > 0)
    true_positive = float(weights[predicted & gold].sum())
    predicted_total = float(weights[predicted].sum())
    gold_total = float(weights[gold].sum())
    if not predicted_total or not gold_total:
        return 0.0
    precision = true_positive / predicted_total
    recall = true_positive / gold_total
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def repeated_child_groups(page: CORE.Page, index: int) -> list[list[int]]:
    """Return direct same-signature sibling groups with at least three peers."""
    grouped: dict[tuple[int, str], list[int]] = {}
    for child in page.children[index]:
        repeated = int(round(math.expm1(float(page.features[child, 12]))))
        if repeated < 3:
            continue
        grouped.setdefault((int(page.sibling_group[child]), page.tags[child]), []).append(child)
    return [
        siblings for siblings in grouped.values()
        if len(siblings) >= 3
        and sum(page.subtree_tokens[child] > 0 for child in siblings) >= 2
    ]


def keep_recurrence(page: CORE.Page, logits: np.ndarray, *, group_complete: bool = False):
    total = len(page.tokens)
    local = page.tokens * logits
    keep = np.zeros(total, dtype=np.float64)
    kept_tokens = page.tokens.copy()
    kept_gold_tokens = page.tokens * page.gold_keep
    keep_choice: list[list[bool]] = [[] for _ in range(total)]
    for index in range(total - 1, -1, -1):
        value = float(local[index])
        selected_tokens = float(page.tokens[index])
        selected_gold_tokens = float(page.tokens[index] if page.gold_keep[index] else 0.0)
        children = page.children[index]
        choices = [False] * len(children)
        child_offsets = {child: offset for offset, child in enumerate(children)}
        grouped_children = set()
        groups = repeated_child_groups(page, index) if group_complete else []
        for siblings in groups:
            grouped_children.update(siblings)
            retained_value = sum(float(keep[child]) for child in siblings)
            excluded_value = sum(
                -CORE.EXCLUDE_PENALTY * min(
                    1.0, page.subtree_tokens[child] / CORE.MIN_EXCLUDE_TOKENS,
                )
                for child in siblings
            )
            retain_group = retained_value >= excluded_value
            value += retained_value if retain_group else excluded_value
            if retain_group:
                for child in siblings:
                    choices[child_offsets[child]] = True
                    selected_tokens += kept_tokens[child]
                    selected_gold_tokens += kept_gold_tokens[child]
        for offset, child in enumerate(children):
            if child in grouped_children:
                continue
            excluded = -CORE.EXCLUDE_PENALTY * min(
                1.0, page.subtree_tokens[child] / CORE.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            choices[offset] = bool(retain)
            value += keep[child] if retain else excluded
            if retain:
                selected_tokens += kept_tokens[child]
                selected_gold_tokens += kept_gold_tokens[child]
        keep[index] = value
        kept_tokens[index] = selected_tokens
        kept_gold_tokens[index] = selected_gold_tokens
        keep_choice[index] = choices
    return keep, kept_tokens, kept_gold_tokens, keep_choice


def reconstruct_root(page: CORE.Page, root: int, choices) -> np.ndarray:
    mask = np.zeros(len(page.tokens), dtype=bool)
    stack = [root]
    while stack:
        index = stack.pop()
        mask[index] = True
        for offset, child in enumerate(page.children[index]):
            if choices[index][offset]:
                stack.append(child)
    return mask


def candidate_summary(page: CORE.Page, mask: np.ndarray, roots: list[int], energy: float) -> np.ndarray:
    tokens = page.tokens
    retained = float(tokens[mask].sum())
    page_total = max(1.0, float(tokens.sum()))
    root_coverage = min(page_total, sum(float(page.subtree_tokens[root]) for root in roots))
    def share(predicate: np.ndarray) -> float:
        return float(tokens[mask & predicate].sum()) / max(1.0, retained)
    tags = np.asarray(page.tags)
    repeat = np.log1p(np.maximum(1, page.sibling_group))
    repeat_mean = float((tokens[mask] * repeat[mask]).sum()) / max(1.0, retained)
    return np.asarray([
        float(bool(retained >= CORE.MIN_RETAINED_TOKENS)),
        energy / page_total,
        retained / page_total,
        root_coverage / page_total,
        math.log1p(len(roots)),
        share(page.features[:, 6] > 0),
        share(page.features[:, 10] > 0),
        share(page.features[:, 11] > 0),
        share(tags == "p"),
        share(np.asarray([bool(re.fullmatch(r"h[1-6]", tag)) for tag in tags])),
        share(np.isin(tags, ["li", "dt", "dd"])),
        share(np.isin(tags, ["table", "tr", "td", "th"])),
        repeat_mean,
    ], dtype=np.float64)


def finalize_decode(
    page: CORE.Page,
    mask: np.ndarray,
    roots: list[int],
    energy: float,
    *,
    transform_dependent_roots: bool = False,
) -> ModeDecode:
    retained = int(page.tokens[mask].sum())
    available = retained >= CORE.MIN_RETAINED_TOKENS and bool(roots) and (
        transform_dependent_roots
        or not any(page.tags[root] in DEPENDENT_ROOT_TAGS for root in roots)
    )
    if not available:
        mask = np.zeros(len(page.tokens), dtype=bool)
        roots = []
        retained = 0
    text = CORE.materialized_text(page, mask) if available else ""
    quality = CORE.trigram_f1(text, page.reference) if page.status == "extract" else float(not text)
    summary = candidate_summary(page, mask, roots, energy)
    return ModeDecode(mask, roots, energy, retained, available, text, quality, summary)


def root_feature_matrix(
    item: ModePage,
    keep: np.ndarray,
    kept_tokens: np.ndarray,
) -> np.ndarray:
    page = item.page
    count = len(page.tokens)
    total_tokens = max(1.0, float(page.tokens.sum()))
    tags = np.asarray(page.tags)
    position = np.arange(count, dtype=np.float64) / max(1, count - 1)
    components = page.readability_root_scores
    return np.column_stack([
        (keep - CORE.ROOT_PENALTY) / np.maximum(CORE.MIN_RETAINED_TOKENS, kept_tokens),
        np.log1p(kept_tokens),
        np.clip(kept_tokens / total_tokens, 0.0, 1.0),
        np.clip(page.subtree_tokens / total_tokens, 0.0, 1.0),
        np.clip(kept_tokens / np.maximum(1.0, page.subtree_tokens), 0.0, 1.0),
        np.log1p(np.maximum(0.0, components["evidence"])),
        components["tag"] / 5.0,
        components["class"] / 25.0,
        components["link-factor"],
        np.clip(components["evidence-tag-class"] / 25.0, -4.0, 4.0),
        np.clip(components["full"] / 25.0, -4.0, 4.0),
        tags == "body",
        np.isin(tags, ["main", "article"]),
        tags == "section",
        tags == "div",
        np.isin(tags, ["p", "table"]),
        position,
        1.0 - np.abs(2.0 * position - 1.0),
        np.log1p(np.asarray([len(children) for children in page.children])) / 8.0,
        page.features,
        item.context,
    ]).astype(np.float64)


def decode_readability_proposal_focused(item: ModePage, logits: np.ndarray) -> ModeDecode:
    """Decode one connected Focused action from Readability-style proposals.

    Each proposal fixes the parent scope and its qualifying direct siblings.
    The ordinary Tree-DP keep/carve recurrence remains free inside every
    included sibling.  Readability's retry order is retained: accept the first
    candidate with at least 500 materialized characters, otherwise keep the
    longest attempt.
    """
    page = item.page
    keep, _kept_tokens, _kept_gold, choices = keep_recurrence(page, logits)
    proposals = SINGLE.readability_root_proposals(page)
    candidates: list[tuple[int, ModeDecode]] = []
    for proposal in proposals:
        if proposal.scope == proposal.primary:
            roots = [int(proposal.primary)]
            mask = reconstruct_root(page, roots[0], choices)
        else:
            mask = np.zeros(len(page.tokens), dtype=bool)
            roots = [int(sibling) for sibling in proposal.included_siblings]
            direct = set(page.children[proposal.scope])
            for sibling in proposal.included_siblings:
                if sibling not in direct:
                    raise ValueError(f"{page.id}: proposal sibling is outside its scope")
                mask |= reconstruct_root(page, int(sibling), choices)
        candidate = finalize_decode(
            page,
            mask,
            roots,
            float(sum(keep[root] - CORE.ROOT_PENALTY for root in roots)),
            transform_dependent_roots=True,
        )
        if not candidate.available:
            continue
        characters = len(CORE.normalize_text(candidate.text))
        candidates.append((characters, candidate))
        if characters >= 500:
            return candidate
    if not candidates:
        return finalize_decode(page, np.zeros(len(page.tokens), dtype=bool), [], 0.0)
    return max(candidates, key=lambda item: item[0])[1]


def decode_focused(
    item: ModePage,
    logits: np.ndarray,
    root_model=None,
    *,
    mechanism: str = "learned",
) -> ModeDecode:
    if mechanism == "readability-proposal":
        return decode_readability_proposal_focused(item, logits)
    page = item.page
    keep, kept_tokens, _kept_gold, choices = keep_recurrence(page, logits)
    prior = page.readability_root_scores["full"]
    root_features = root_feature_matrix(item, keep, kept_tokens)
    predicted = root_model.predict(root_features) if root_model is not None else None
    best_root = -1
    best = 0.0
    for index, tag in enumerate(page.tags):
        if tag in DEPENDENT_ROOT_TAGS or kept_tokens[index] < CORE.MIN_RETAINED_TOKENS:
            continue
        value = (
            float(predicted[index])
            if predicted is not None
            else keep[index] - CORE.ROOT_PENALTY + FOCUSED_ROOT_PRIOR_WEIGHT * prior[index]
        )
        if value > best:
            best = float(value)
            best_root = index
    if best_root < 0:
        return finalize_decode(page, np.zeros(len(page.tokens), dtype=bool), [], 0.0)
    return finalize_decode(page, reconstruct_root(page, best_root, choices), [best_root], best)


def decode_collection(item: ModePage, logits: np.ndarray) -> ModeDecode:
    page = item.page
    keep, kept_tokens, _kept_gold, choices = keep_recurrence(page, logits, group_complete=True)
    total = len(page.tokens)
    free = np.zeros(total, dtype=np.float64)
    free_root = np.zeros(total, dtype=bool)
    for index in range(total - 1, -1, -1):
        descend = sum(free[child] for child in page.children[index])
        legal = page.tags[index] not in DEPENDENT_ROOT_TAGS
        as_root = keep[index] - CORE.ROOT_PENALTY if legal else -math.inf
        if kept_tokens[index] >= CORE.MIN_RETAINED_TOKENS and as_root >= descend and as_root > 0:
            free[index] = as_root
            free_root[index] = True
        else:
            free[index] = max(0.0, descend)
    roots = []
    stack = [0]
    while stack:
        index = stack.pop()
        if free_root[index]:
            roots.append(index)
        else:
            stack.extend(page.children[index])
    mask = np.zeros(total, dtype=bool)
    for root in roots:
        mask |= reconstruct_root(page, root, choices)
    return finalize_decode(page, mask, sorted(roots), float(free[0]))


def page_balanced_node_rows(
    pages: list[ModePage], responsibilities: np.ndarray, contexts: list[np.ndarray], local_beta: np.ndarray,
):
    site_counts: dict[str, int] = {}
    for item in pages:
        site_counts[item.page.site_family] = site_counts.get(item.page.site_family, 0) + 1
    matrices = []
    offsets = []
    labels = []
    weights = []
    for page_index, item in enumerate(pages):
        page = item.page
        selected = page.tokens > 0
        if not np.any(selected):
            continue
        x = contexts[page_index][selected]
        y = page.gold_keep[selected].astype(np.float64)
        token_weights = page.tokens[selected].astype(np.float64)
        positive = y > 0.5
        negative = ~positive
        normalized = np.zeros_like(token_weights)
        if np.any(positive):
            normalized[positive] = 0.5 * token_weights[positive] / token_weights[positive].sum()
            if np.any(negative):
                normalized[negative] = 0.5 * token_weights[negative] / token_weights[negative].sum()
        elif np.any(negative):
            normalized[negative] = token_weights[negative] / token_weights[negative].sum()
        site_weight = 1.0 / site_counts[page.site_family]
        normalized *= responsibilities[page_index] * site_weight
        matrices.append(x)
        offsets.append(baseline_logits(item, local_beta)[selected])
        labels.append(y)
        weights.append(normalized)
    return (
        np.vstack(matrices), np.concatenate(offsets), np.concatenate(labels), np.concatenate(weights),
    )


def fit_residual(
    pages: list[ModePage], responsibilities: np.ndarray, contexts: list[np.ndarray],
    local_beta: np.ndarray, initial: np.ndarray, regularization: float,
) -> np.ndarray:
    x, offset, y, weight = page_balanced_node_rows(pages, responsibilities, contexts, local_beta)
    scale = max(1e-12, float(weight.sum()))
    weight = weight / scale
    def objective(beta):
        logits = offset + x @ beta
        losses = np.logaddexp(0.0, logits) - y * logits
        value = float(weight @ losses) + 0.5 * regularization * float(beta @ beta)
        probability = 1.0 / (1.0 + np.exp(-np.clip(logits, -40, 40)))
        gradient = x.T @ (weight * (probability - y)) + regularization * beta
        return value, gradient
    fitted = minimize(objective, initial, method="L-BFGS-B", jac=True, options={"maxiter": 80})
    if not fitted.success:
        raise RuntimeError(f"residual optimization failed: {fitted.message}")
    return np.asarray(fitted.x, dtype=np.float64)


def fit_focused_root_model(
    pages: list[ModePage], contexts: list[np.ndarray], residual: np.ndarray,
    responsibilities: np.ndarray, local_beta: np.ndarray,
):
    site_counts: dict[str, int] = {}
    for item in pages:
        site_counts[item.page.site_family] = site_counts.get(item.page.site_family, 0) + 1
    matrices = []
    targets = []
    weights = []
    for page_index, (item, context) in enumerate(zip(pages, contexts, strict=True)):
        page = item.page
        logits = baseline_logits(item, local_beta) + context @ residual
        keep, kept_tokens, kept_gold, _choices = keep_recurrence(page, logits)
        features = root_feature_matrix(item, keep, kept_tokens)
        feasible = np.asarray([
            page.tags[index] not in DEPENDENT_ROOT_TAGS
            and kept_tokens[index] >= CORE.MIN_RETAINED_TOKENS
            for index in range(len(page.tokens))
        ], dtype=bool)
        indices = np.flatnonzero(feasible)
        if not len(indices):
            continue
        gold_total = float(page.tokens[page.gold_keep].sum()) if page.status == "extract" else 0.0
        precision = np.divide(
            kept_gold, kept_tokens,
            out=np.zeros_like(kept_gold), where=kept_tokens > 0,
        )
        recall = kept_gold / gold_total if gold_total else np.zeros_like(kept_gold)
        quality = np.divide(
            2.0 * precision * recall,
            precision + recall,
            out=np.zeros_like(precision), where=(precision + recall) > 0,
        )
        # Fixed bounded training pool: roots favored by the current energy plus
        # a few gold-best roots so a missed focused scope remains learnable.
        energy = keep - CORE.ROOT_PENALTY
        energy_top = indices[np.argsort(energy[indices])[-48:]]
        quality_top = indices[np.argsort(quality[indices])[-16:]]
        selected = np.unique(np.concatenate([energy_top, quality_top]))
        matrices.append(features[selected])
        targets.append(quality[selected])
        page_weight = responsibilities[page_index] / site_counts[page.site_family]
        weights.append(np.full(len(selected), page_weight / max(1, len(selected))))
    model = make_pipeline(StandardScaler(), Ridge(alpha=10.0))
    model.fit(
        np.vstack(matrices),
        np.concatenate(targets),
        ridge__sample_weight=np.concatenate(weights),
    )
    return model


def serialize_root_model(model) -> dict:
    scaler = model.named_steps["standardscaler"]
    ridge = model.named_steps["ridge"]
    return {
        "features": ROOT_FEATURE_NAMES,
        "scalingMean": scaler.mean_.tolist(),
        "scalingScale": scaler.scale_.tolist(),
        "coefficient": ridge.coef_.tolist(),
        "intercept": float(ridge.intercept_),
    }


def soft_responsibility(focused: float, collection: float) -> float:
    delta = np.clip((focused - collection) / TEMPERATURE, -30.0, 30.0)
    value = 1.0 / (1.0 + math.exp(-float(delta)))
    return RESPONSIBILITY_FLOOR + (1.0 - 2 * RESPONSIBILITY_FLOOR) * value


def initial_responsibility(item: ModePage) -> float:
    """Gold-only warm start that breaks the otherwise symmetric two-head fit.

    This seed is never a serving feature.  A tight single gold scope favors the
    focused head; gold mass distributed over repeated sibling groups favors the
    collection head.  Later rounds replace it with candidate-utility
    responsibilities, so the seed cannot permanently label a page type.
    """
    page = item.page
    if page.status != "extract":
        return 0.5
    gold_tokens = page.tokens * page.gold_keep
    total_gold = float(gold_tokens.sum())
    if not total_gold:
        return 0.5
    subtree_gold = gold_tokens.copy()
    for index in range(len(page.tokens) - 1, 0, -1):
        subtree_gold[page.parent[index]] += subtree_gold[index]
    lca = 0
    for index in range(len(page.tokens)):
        if subtree_gold[index] >= total_gold - 1e-9:
            lca = index
    tightness = min(1.0, total_gold / max(1.0, float(page.subtree_tokens[lca])))

    repeated_gold_mask = np.zeros(len(page.tokens), dtype=bool)
    repeated_count = np.rint(np.expm1(page.features[:, 12])).astype(np.int64)
    for parent, children in enumerate(page.children):
        groups: dict[tuple[int, str], list[int]] = {}
        for child in children:
            count = int(repeated_count[child])
            if count < 3:
                continue
            groups.setdefault((int(page.sibling_group[child]), page.tags[child]), []).append(child)
        for siblings in groups.values():
            active = [child for child in siblings if subtree_gold[child] > 0]
            if len(siblings) < 3 or len(active) < 2:
                continue
            for child in active:
                start = child
                end = child + 1
                while end < len(page.parent) and page.parent[end] >= start:
                    end += 1
                repeated_gold_mask[start:end] = True
    repeated_share = float(gold_tokens[repeated_gold_mask].sum()) / total_gold
    focused_evidence = tightness * (1.0 - repeated_share)
    return float(np.clip(0.1 + 0.8 * focused_evidence, 0.1, 0.9))


def candidate_pair_features(focused: ModeDecode, collection: ModeDecode) -> np.ndarray:
    union = set(CORE.normalize_text(focused.text)) | set(CORE.normalize_text(collection.text))
    overlap = len(set(CORE.normalize_text(focused.text)) & set(CORE.normalize_text(collection.text))) / max(1, len(union))
    length_ratio = math.log((focused.retained_tokens + 1) / (collection.retained_tokens + 1))
    return np.concatenate([
        focused.summary,
        collection.summary,
        focused.summary - collection.summary,
        np.asarray([overlap, length_ratio], dtype=np.float64),
    ])


def fit_gate(
    pages: list[ModePage],
    pairs: list[tuple[ModeDecode, ModeDecode]],
    kind: str,
):
    x = np.vstack([candidate_pair_features(*pair) for pair in pairs])
    y = np.asarray([focused.quality - collection.quality for focused, collection in pairs])
    site_counts: dict[str, int] = {}
    for item in pages:
        site_counts[item.page.site_family] = site_counts.get(item.page.site_family, 0) + 1
    weights = np.asarray([1.0 / site_counts[item.page.site_family] for item in pages])
    if kind == "logistic":
        target = y >= 0
        # Pages where the modes are nearly equivalent should not dominate the
        # decision boundary. The floor preserves calibration on ties; the
        # magnitude term makes a catastrophic wrong expert expensive.
        weights = weights * (0.05 + np.abs(y))
        model = make_pipeline(
            StandardScaler(),
            LogisticRegression(C=0.1, max_iter=1000, tol=1e-10),
        )
        model.fit(x, target, logisticregression__sample_weight=weights)
    else:
        model = Ridge(alpha=10.0)
        model.fit(x, y, sample_weight=weights)
    return model


def gate_score(model, features: np.ndarray) -> float:
    if hasattr(model, "decision_function"):
        return float(np.asarray(model.decision_function(features)).reshape(-1)[0])
    return float(model.predict(features)[0])


def serialize_gate(model) -> dict:
    if isinstance(model, Ridge):
        return {
            "kind": "ridge",
            "coefficient": model.coef_.tolist(),
            "intercept": float(model.intercept_),
        }
    classifier = model.named_steps["logisticregression"]
    scaler = model.named_steps["standardscaler"]
    return {
        "kind": "logistic",
        "scalingMean": scaler.mean_.tolist(),
        "scalingScale": scaler.scale_.tolist(),
        "coefficient": classifier.coef_[0].tolist(),
        "intercept": float(classifier.intercept_[0]),
    }


def train_modes(
    pages: list[ModePage], local_beta: np.ndarray, rounds: int, regularization: float,
    focused_mechanism: str, gate_kind: str,
):
    contexts = [mode_context(item) for item in pages]
    focused_beta = np.zeros(len(MODE_FEATURE_NAMES), dtype=np.float64)
    collection_beta = np.zeros(len(MODE_FEATURE_NAMES), dtype=np.float64)
    responsibilities = np.asarray([initial_responsibility(item) for item in pages])
    focused_beta = fit_residual(
        pages, responsibilities, contexts, local_beta, focused_beta, regularization,
    )
    collection_beta = fit_residual(
        pages, 1.0 - responsibilities, contexts, local_beta, collection_beta, regularization,
    )
    focused_root_model = (
        fit_focused_root_model(
            pages, contexts, focused_beta, responsibilities, local_beta,
        )
        if focused_mechanism == "learned"
        else None
    )
    history = [{
        "round": 0,
        "phase": "gold-structural-warm-start",
        "focusedResponsibilityMean": float(responsibilities.mean()),
        "focusedHardPages": int((responsibilities > 0.5).sum()),
        "collectionHardPages": int((responsibilities < 0.5).sum()),
        "ambiguousPages": int((np.abs(responsibilities - 0.5) < 0.1).sum()),
        "focusedResidualNorm": float(np.linalg.norm(focused_beta)),
        "collectionResidualNorm": float(np.linalg.norm(collection_beta)),
    }]
    for iteration in range(rounds):
        pairs = []
        for item, context in zip(pages, contexts, strict=True):
            base = baseline_logits(item, local_beta)
            focused = decode_focused(
                item,
                base + context @ focused_beta,
                focused_root_model,
                mechanism=focused_mechanism,
            )
            collection = decode_collection(item, base + context @ collection_beta)
            pairs.append((focused, collection))
        responsibilities = np.asarray([
            soft_responsibility(focused.quality, collection.quality)
            if item.page.status == "extract" else 0.5
            for item, (focused, collection) in zip(pages, pairs, strict=True)
        ])
        focused_beta = fit_residual(
            pages, responsibilities, contexts, local_beta, focused_beta, regularization,
        )
        collection_beta = fit_residual(
            pages, 1.0 - responsibilities, contexts, local_beta, collection_beta, regularization,
        )
        focused_root_model = (
            fit_focused_root_model(
                pages, contexts, focused_beta, responsibilities, local_beta,
            )
            if focused_mechanism == "learned"
            else None
        )
        history.append({
            "round": iteration + 1,
            "focusedResponsibilityMean": float(responsibilities.mean()),
            "focusedHardPages": int((responsibilities > 0.5).sum()),
            "collectionHardPages": int((responsibilities < 0.5).sum()),
            "ambiguousPages": int((np.abs(responsibilities - 0.5) < 0.1).sum()),
            "focusedResidualNorm": float(np.linalg.norm(focused_beta)),
            "collectionResidualNorm": float(np.linalg.norm(collection_beta)),
        })
    final_pairs = []
    for item, context in zip(pages, contexts, strict=True):
        base = baseline_logits(item, local_beta)
        final_pairs.append((
            decode_focused(
                item,
                base + context @ focused_beta,
                focused_root_model,
                mechanism=focused_mechanism,
            ),
            decode_collection(item, base + context @ collection_beta),
        ))
    gate = fit_gate(pages, final_pairs, gate_kind)
    return focused_beta, collection_beta, focused_root_model, gate, history


def evaluate(
    pages: list[ModePage], focused_beta: np.ndarray, collection_beta: np.ndarray,
    focused_root_model, gate, local_beta: np.ndarray, focused_mechanism: str,
):
    rows = []
    for item in pages:
        context = mode_context(item)
        base = baseline_logits(item, local_beta)
        focused = decode_focused(
            item,
            base + context @ focused_beta,
            focused_root_model,
            mechanism=focused_mechanism,
        )
        collection = decode_collection(item, base + context @ collection_beta)
        features = candidate_pair_features(focused, collection).reshape(1, -1)
        predicted_delta = gate_score(gate, features)
        selected_mode = "focused" if predicted_delta >= 0 else "collection"
        selected = focused if selected_mode == "focused" else collection
        rows.append({
            "id": item.page.id,
            "siteFamily": item.page.site_family,
            "split": item.page.split,
            "status": item.page.status,
            "selectedMode": selected_mode,
            "predictedFocusedMinusCollection": predicted_delta,
            "focusedF1": focused.quality,
            "collectionF1": collection.quality,
            "selectedF1": selected.quality,
            "oracleF1": max(focused.quality, collection.quality),
            "focusedAvailable": focused.available,
            "collectionAvailable": collection.available,
            "selectedAvailable": selected.available,
            "focusedRoots": len(focused.roots),
            "collectionRoots": len(collection.roots),
            "selectedChars": len(selected.text),
        })
    return rows


def summarize(rows: list[dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    exclude = [row for row in rows if row["status"] == "exclude"]
    selected = np.asarray([row["selectedF1"] for row in extract], dtype=np.float64)
    oracle = np.asarray([row["oracleF1"] for row in extract], dtype=np.float64)
    mode_counts = {
        mode: sum(row["selectedMode"] == mode for row in rows)
        for mode in ("focused", "collection")
    }
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "excludePages": len(exclude),
        "selectedMeanF1": float(selected.mean()) if len(selected) else None,
        "modeOracleMeanF1": float(oracle.mean()) if len(oracle) else None,
        "p10F1": float(np.quantile(selected, 0.1)) if len(selected) else None,
        "belowPointFive": int((selected < 0.5).sum()),
        "selectedUnavailable": sum(not row["selectedAvailable"] for row in extract),
        "excludeFalsePositive": sum(row["selectedAvailable"] for row in exclude),
        "modeCounts": mode_counts,
    }


def load_current_metrics(path: Path) -> dict[str, dict]:
    result = {}
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            record = json.loads(line)
            candidates = {candidate.get("key"): candidate for candidate in record.get("candidates", [])}
            result[record["id"]] = {
                "status": record.get("goldStatus"),
                "tree": float((candidates.get("treedp", {}).get("metrics") or {}).get("mainNgramF1", 0.0))
                if candidates.get("treedp", {}).get("available") else 0.0,
                "readability": float((candidates.get("readability", {}).get("metrics") or {}).get("mainNgramF1", 0.0))
                if candidates.get("readability", {}).get("available") else 0.0,
            }
    return result


def metric_baselines(rows: list[dict], metrics: dict[str, dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    tree = np.asarray([metrics[row["id"]]["tree"] for row in extract])
    readability = np.asarray([metrics[row["id"]]["readability"] for row in extract])
    return {
        "forcedTreeMeanF1": float(tree.mean()),
        "readabilityMeanF1": float(readability.mean()),
        "twoCandidateOracleMeanF1": float(np.maximum(tree, readability).mean()),
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--units", type=Path, required=True)
    parser.add_argument("--extractor", type=Path, required=True)
    parser.add_argument("--current-candidates", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--regularization", type=float, default=0.2)
    parser.add_argument(
        "--focused-mechanism",
        choices=("learned", "readability-proposal"),
        default="learned",
    )
    parser.add_argument("--gate", choices=("ridge", "logistic"), default="ridge")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages = load_pages(args.units.resolve())
    local_beta, extractor_sha = artifact_local_beta(args.extractor.resolve())
    metrics = load_current_metrics(args.current_candidates.resolve())
    missing = sorted(item.page.id for item in pages if item.page.id not in metrics)
    if missing:
        raise ValueError(f"current-candidate metrics missing {len(missing)} pages")
    groups = np.asarray([item.page.site_family for item in pages])
    splitter = GroupKFold(n_splits=args.folds)
    oof_rows = []
    fold_reports = []
    for fold, (train_indices, heldout_indices) in enumerate(splitter.split(pages, groups=groups), 1):
        training = [pages[index] for index in train_indices]
        heldout = [pages[index] for index in heldout_indices]
        focused, collection, focused_root_model, gate, history = train_modes(
            training, local_beta, args.rounds, args.regularization,
            args.focused_mechanism, args.gate,
        )
        rows = evaluate(
            heldout, focused, collection, focused_root_model, gate, local_beta,
            args.focused_mechanism,
        )
        for row in rows:
            row["fold"] = fold
        oof_rows.extend(rows)
        fold_reports.append({
            "fold": fold,
            "trainingPages": len(training),
            "heldoutPages": len(heldout),
            "trainingFamilies": len({item.page.site_family for item in training}),
            "heldoutFamilies": len({item.page.site_family for item in heldout}),
            "focusedResidual": focused.tolist(),
            "collectionResidual": collection.tolist(),
            "focusedRootModel": (
                serialize_root_model(focused_root_model)
                if focused_root_model is not None else None
            ),
            "gate": serialize_gate(gate),
            "em": history,
            "summary": summarize(rows),
        })
        print(json.dumps({"fold": fold, **fold_reports[-1]["summary"]}, ensure_ascii=False), flush=True)
    final_focused, final_collection, final_root_model, final_gate, final_history = train_modes(
        pages, local_beta, args.rounds, args.regularization,
        args.focused_mechanism, args.gate,
    )
    report = {
        "schema": "qingzhou.tree-dp-focused-collection-em-study.v1",
        "protocol": {
            "splits": ["base", "train"],
            "validationOpened": False,
            "testOpened": False,
            "grouping": "siteFamily",
            "folds": args.folds,
            "rounds": args.rounds,
            "temperature": TEMPERATURE,
            "responsibilityFloor": RESPONSIBILITY_FLOOR,
            "regularization": args.regularization,
            "gate": args.gate,
            "focusedConstraint": (
                "readability-retry-scope-with-sibling-obligations"
                if args.focused_mechanism == "readability-proposal"
                else "single-legal-root"
            ),
            "collectionConstraint": "ordinary-legal-forest",
            "runtimeFeatures": MODE_FEATURE_NAMES,
            "pageFeatures": PAGE_FEATURE_NAMES,
            "servingUsesPageType": False,
        },
        "provenance": {
            "units": str(args.units.resolve()),
            "extractor": str(args.extractor.resolve()),
            "extractorSha256": extractor_sha,
            "currentCandidates": str(args.current_candidates.resolve()),
            "currentCandidatesSha256": CORE.sha256_file(args.current_candidates.resolve()),
            "scriptSha256": CORE.sha256_file(Path(__file__).resolve()),
            "pages": len(pages),
            "families": len(set(groups)),
        },
        "oof": {
            "summary": summarize(oof_rows),
            "baselines": metric_baselines(oof_rows, metrics),
            "rows": sorted(oof_rows, key=lambda row: row["id"]),
            "folds": fold_reports,
        },
        "finalModel": {
            "focusedResidual": final_focused.tolist(),
            "collectionResidual": final_collection.tolist(),
            "focusedRootModel": (
                serialize_root_model(final_root_model)
                if final_root_model is not None else None
            ),
            "gate": serialize_gate(final_gate),
            "em": final_history,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "oof": report["oof"]["summary"],
        "baselines": report["oof"]["baselines"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
