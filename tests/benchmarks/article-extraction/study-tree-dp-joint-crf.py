#!/usr/bin/env python3
"""Jointly train local carve decisions and the global Tree-DP root decision.

The production-shaped model has two small bounded residual networks:

* a local residual around the shipped 16-D + Readability-context block score;
* a page-normalized root/empty residual over generic structural evidence.

Training uses a latent Tree-CRF objective.  All zero-token wrapper and carve
choices compatible with the human text mask contribute to the gold partition,
so arbitrary DOM wrapper boundaries are never treated as labels.  Inference is
the ordinary max Tree-DP: one bottom-up keep/carve pass and one scan over legal
roots.  Readability contributes generic class/paragraph/link-density features,
but no Readability candidate is generated or compared at runtime.

This is a benchmark-only capacity study.  It refuses Chinese validation/test
and WCXB test by construction.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
GLOBAL_PATH = HERE / "study-tree-dp-global-choice.py"
SPEC = importlib.util.spec_from_file_location("qingzhou_joint_crf_global", GLOBAL_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {GLOBAL_PATH}")
GLOBAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GLOBAL
SPEC.loader.exec_module(GLOBAL)
SINGLE = GLOBAL.SINGLE
READABILITY = GLOBAL.READABILITY
ROOT_QUALITY = GLOBAL.ROOT_QUALITY
TRAINER = GLOBAL.TRAINER


LOCAL_FEATURE_NAMES = [
    *[f"shippedFeature{index}" for index in range(16)],
    *READABILITY.FEATURE_NAMES,
    "readabilityParagraphEvidenceLog",
    "readabilityTagPrior",
    "readabilityClassWeight",
    "readabilityLinkFactor",
    "readabilityRawScore",
    "readabilityLinkAdjustedScore",
    "readabilityUnlikelySelfOrAncestor",
    "readabilityRoleRejected",
    "readabilitySubtreeCharShare",
]

RAW_ROOT_AGGREGATE_FEATURE_NAMES = [
    "subtreeAnchorTokenShare",
    "subtreeBoilerplateTokenShare",
    "subtreeContentTokenShare",
    "subtreeParagraphTokenShare",
    "subtreeHeadingTokenShare",
    "subtreeListTokenShare",
    "subtreeTableTokenShare",
    "subtreePunctuationPerToken",
    "subtreeElementCountLog",
    "subtreeParagraphCountLog",
    "subtreeHeadingCountLog",
    "subtreeAnchorCountLog",
    "subtreeListCountLog",
    "subtreeTableCountLog",
    "subtreeControlCountLog",
    "subtreeRepeatedMeanLog",
    "subtreeRepeatedMaxLog",
    "subtreePageTokenShare",
    "documentPosition",
    "documentCentrality",
    "childCountLog",
]

# The first three RootQuality features depend on the old fixed keep mask.  They
# are deliberately omitted: the joint model must not need a shadow Tree-DP
# candidate to describe the page.
STATIC_ROOT_FEATURE_NAMES = [
    *ROOT_QUALITY.ROOT_FEATURE_NAMES[3:],
    *SINGLE.READABILITY_SCOPE_FEATURE_NAMES,
    *RAW_ROOT_AGGREGATE_FEATURE_NAMES,
]
@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


@dataclass
class JointPage:
    item: object
    baseline_root_page: object
    local_features: np.ndarray
    local_offset: np.ndarray
    root_features: np.ndarray
    root_prior: np.ndarray
    root_allowed: np.ndarray
    required_subtree: np.ndarray
    total_required: int


class JointEnergy(torch.nn.Module):
    def __init__(
        self,
        local_dimensions: int,
        root_dimensions: int,
        local_width: int,
        root_width: int,
        local_bound: float,
        root_bound: float,
    ):
        super().__init__()
        self.local_bound = local_bound
        self.root_bound = root_bound
        self.local = torch.nn.Sequential(
            torch.nn.Linear(local_dimensions, local_width),
            torch.nn.Tanh(),
            torch.nn.Linear(local_width, 1),
        )
        self.root = torch.nn.Sequential(
            torch.nn.Linear(root_dimensions, root_width),
            torch.nn.Tanh(),
            torch.nn.Linear(root_width, 1),
        )
        # Exact v7 local score and zero global residual are the starting model.
        torch.nn.init.zeros_(self.local[-1].weight)
        torch.nn.init.zeros_(self.local[-1].bias)
        torch.nn.init.zeros_(self.root[-1].weight)
        torch.nn.init.zeros_(self.root[-1].bias)

    @staticmethod
    def bounded(network, values: torch.Tensor, bound: float) -> torch.Tensor:
        raw = network(values).squeeze(-1)
        return bound * torch.tanh(raw / bound)

    def local_residual(self, values: torch.Tensor) -> torch.Tensor:
        return self.bounded(self.local, values, self.local_bound)

    def root_residual(self, values: torch.Tensor) -> torch.Tensor:
        return self.bounded(self.root, values, self.root_bound)


def bottom_up_sum(page, values: np.ndarray) -> np.ndarray:
    result = values.copy()
    for index in range(len(result) - 1, 0, -1):
        result[int(page.parent[index])] += result[index]
    return result


def local_features(item) -> np.ndarray:
    page = item.page
    components = page.readability_root_scores
    subtree_chars = components["subtree-chars"]
    page_chars = max(1.0, float(subtree_chars[0]))
    return np.column_stack([
        page.features,
        item.context,
        np.log1p(np.maximum(0.0, components["evidence"])),
        components["tag"] / 5.0,
        components["class"] / 25.0,
        components["link-factor"],
        np.clip(components["evidence-tag-class"] / 25.0, -4.0, 4.0),
        np.clip(components["full"] / 25.0, -4.0, 4.0),
        page.readability_unlikely.astype(np.float64),
        page.readability_role_rejected.astype(np.float64),
        np.clip(subtree_chars / page_chars, 0.0, 1.0),
    ]).astype(np.float64)


def raw_root_aggregate_features(page) -> np.ndarray:
    tags = np.asarray(page.tags)
    tokens = page.tokens
    total = len(tokens)
    additive = np.column_stack([
        tokens,
        tokens * page.features[:, 6],
        tokens * (page.features[:, 10] > 0),
        tokens * (page.features[:, 11] > 0),
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
        np.isin(tags, ["button", "form", "input", "select", "textarea"]).astype(np.float64),
        tokens * page.features[:, 12],
    ]).astype(np.float64)
    maximum_repeat = page.features[:, 12].copy()
    for index in range(total - 1, 0, -1):
        parent = int(page.parent[index])
        additive[parent] += additive[index]
        maximum_repeat[parent] = max(maximum_repeat[parent], maximum_repeat[index])
    retained = np.maximum(1.0, additive[:, 0])
    page_tokens = max(1.0, float(tokens.sum()))
    position = np.arange(total, dtype=np.float64) / max(1, total - 1)
    return np.column_stack([
        additive[:, 1] / retained,
        additive[:, 2] / retained,
        additive[:, 3] / retained,
        additive[:, 4] / retained,
        additive[:, 5] / retained,
        additive[:, 6] / retained,
        additive[:, 7] / retained,
        additive[:, 8] / retained,
        np.log1p(additive[:, 9]) / 10.0,
        np.log1p(additive[:, 10]) / 8.0,
        np.log1p(additive[:, 11]) / 8.0,
        np.log1p(additive[:, 12]) / 8.0,
        np.log1p(additive[:, 13]) / 8.0,
        np.log1p(additive[:, 14]) / 8.0,
        np.log1p(additive[:, 15]) / 8.0,
        additive[:, 16] / retained,
        maximum_repeat,
        np.clip(additive[:, 0] / page_tokens, 0.0, 1.0),
        position,
        1.0 - np.abs(2.0 * position - 1.0),
        np.log1p(np.asarray([len(children) for children in page.children])) / 8.0,
    ]).astype(np.float64)


def build_joint_page(item, beta: np.ndarray, scope_prior_weight: float) -> JointPage:
    page = item.page
    baseline_root_page = ROOT_QUALITY.build_root_page(item, beta)
    direct_root = baseline_root_page.features[:, 3:].copy()
    SINGLE.add_readability_scope_features(baseline_root_page)
    scope = baseline_root_page.features[:, -len(SINGLE.READABILITY_SCOPE_FEATURE_NAMES):]
    static_root = np.column_stack([
        direct_root,
        scope,
        raw_root_aggregate_features(page),
    ]).astype(np.float64)
    offset = (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + item.context @ beta
    )
    prior = (
        0.25 * page.readability_root_scores["evidence-tag-class"]
        + scope_prior_weight * baseline_root_page.readability_scope_prior
    )
    allowed = np.asarray([
        tag not in TRAINER.DEPENDENT_ROOT_TAGS
        and page.subtree_tokens[index] >= TRAINER.MIN_RETAINED_TOKENS
        for index, tag in enumerate(page.tags)
    ], dtype=bool)
    required = ((page.tokens > 0) & page.gold_keep).astype(np.int64)
    required_subtree = bottom_up_sum(page, required)
    total_required = int(required_subtree[0])
    if page.status == "extract" and total_required <= 0:
        raise ValueError(f"{page.id}: extract page has no token-bearing gold")
    return JointPage(
        item=item,
        baseline_root_page=baseline_root_page,
        local_features=local_features(item),
        local_offset=offset,
        root_features=static_root,
        root_prior=prior,
        root_allowed=allowed,
        required_subtree=required_subtree,
        total_required=total_required,
    )


def sampled_rows(pages, attribute: str, maximum: int) -> np.ndarray:
    rows = []
    for joint in pages:
        matrix = getattr(joint, attribute)
        if attribute == "local_features":
            eligible = np.flatnonzero(joint.item.page.tokens > 0)
        else:
            eligible = np.flatnonzero(joint.root_allowed)
        if not len(eligible):
            continue
        if len(eligible) > maximum:
            eligible = eligible[np.linspace(0, len(eligible) - 1, maximum, dtype=int)]
        rows.append(matrix[eligible])
    if not rows:
        raise ValueError(f"no rows available for {attribute} scaling")
    return np.concatenate(rows)


def fit_scaling(pages, attribute: str, maximum: int) -> Scaling:
    matrix = sampled_rows(pages, attribute, maximum)
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def normalized(values: np.ndarray, scaling: Scaling) -> torch.Tensor:
    return torch.as_tensor(
        np.clip((values - scaling.mean) / scaling.scale, -8.0, 8.0),
        dtype=torch.float32,
    )


def smooth_pair(left: torch.Tensor, right: torch.Tensor, temperature: float) -> torch.Tensor:
    return temperature * torch.logaddexp(left / temperature, right / temperature)


def root_scores(
    model: JointEnergy,
    joint: JointPage,
    root_scaling: Scaling,
    energies: torch.Tensor,
    indices: np.ndarray,
    normalization: torch.Tensor,
    args,
) -> torch.Tensor:
    offsets = (energies - normalization) / args.root_energy_scale
    # Root residuals must be structure-independent unary potentials.  The
    # compatible-gold forest is a true subset of the full partition only when
    # a given DOM root receives the same residual for every latent carve mask.
    # Candidate-energy inputs would violate that invariant by applying an MLP
    # to an already-marginalized log partition.
    static = normalized(joint.root_features[indices], root_scaling)
    return offsets + model.root_residual(static)


def single_root_page_loss(
    model, joint, local_scaling, root_scaling, args
) -> torch.Tensor:
    page = joint.item.page
    local_input = normalized(joint.local_features, local_scaling)
    residual = model.local_residual(local_input)
    tokens = torch.as_tensor(page.tokens, dtype=torch.float32)
    local = tokens * (
        torch.as_tensor(joint.local_offset, dtype=torch.float32) + residual
    )
    negative = torch.tensor(-1e7, dtype=torch.float32)
    keep: list[torch.Tensor] = [negative] * len(page.tokens)
    gold_keep: list[torch.Tensor] = [negative] * len(page.tokens)
    forbidden = (page.tokens > 0) & ~page.gold_keep
    for index in range(len(page.tokens) - 1, -1, -1):
        full_value = local[index]
        gold_value = negative if forbidden[index] else local[index]
        for child in page.children[index]:
            carve = torch.tensor(
                -TRAINER.EXCLUDE_PENALTY * min(
                    1.0,
                    page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
                ),
                dtype=torch.float32,
            )
            full_value = full_value + smooth_pair(
                keep[child], carve, args.local_temperature
            )
            if not forbidden[index]:
                if joint.required_subtree[child] > 0:
                    gold_value = gold_value + gold_keep[child]
                else:
                    gold_value = gold_value + smooth_pair(
                        gold_keep[child], carve, args.local_temperature
                    )
        keep[index] = full_value
        gold_keep[index] = gold_value

    indices = np.flatnonzero(joint.root_allowed)
    if not len(indices):
        if page.status == "exclude":
            return torch.zeros((), dtype=torch.float32)
        raise ValueError(f"{page.id}: no legal Tree-DP root")
    prior = torch.as_tensor(joint.root_prior[indices], dtype=torch.float32)
    full_energy = torch.stack([keep[int(index)] for index in indices])
    full_energy = full_energy - TRAINER.ROOT_PENALTY + prior
    normalization = torch.clamp(torch.max(full_energy), min=0.0).detach()
    full_scores = root_scores(
        model, joint, root_scaling, full_energy, indices, normalization, args
    )
    denominator = torch.logaddexp(
        torch.zeros((), dtype=torch.float32),
        torch.logsumexp(full_scores, dim=0),
    )
    if page.status == "exclude":
        return denominator

    compatible = indices[joint.required_subtree[indices] == joint.total_required]
    if not len(compatible):
        raise ValueError(f"{page.id}: gold cannot be covered by one legal root")
    compatible_values = []
    compatible_indices = []
    for index in compatible:
        value = gold_keep[int(index)]
        if float(value.detach()) <= -1e6:
            continue
        compatible_indices.append(int(index))
        compatible_values.append(value)
    if not compatible_values:
        raise ValueError(f"{page.id}: gold mask is outside the keep/carve state space")
    compatible_indices_array = np.asarray(compatible_indices, dtype=np.int64)
    gold_energy = torch.stack(compatible_values)
    gold_energy = gold_energy - TRAINER.ROOT_PENALTY + torch.as_tensor(
        joint.root_prior[compatible_indices_array], dtype=torch.float32
    )
    gold_scores = root_scores(
        model,
        joint,
        root_scaling,
        gold_energy,
        compatible_indices_array,
        normalization,
        args,
    )
    numerator = torch.logsumexp(gold_scores, dim=0)
    loss = denominator - numerator
    if float(loss.detach()) < -1e-4:
        raise RuntimeError(
            f"{page.id}: compatible partition exceeds the full partition"
        )
    return torch.clamp(loss, min=0.0)


def forest_page_loss(
    model, joint, local_scaling, root_scaling, args
) -> torch.Tensor:
    """Latent CRF over every legal non-overlapping Tree-DP root forest."""
    page = joint.item.page
    local_input = normalized(joint.local_features, local_scaling)
    residual = model.local_residual(local_input)
    tokens = torch.as_tensor(page.tokens, dtype=torch.float32)
    local = tokens * (
        torch.as_tensor(joint.local_offset, dtype=torch.float32) + residual
    )
    page_tokens = max(1.0, float(page.tokens.sum()))
    raw_cost_per_token = (
        args.loss_augmentation * args.root_energy_scale / page_tokens
    )
    score_cost_per_token = args.loss_augmentation / page_tokens
    negative = torch.tensor(-1e7, dtype=torch.float32)
    base_keep: list[torch.Tensor] = [negative] * len(page.tokens)
    keep: list[torch.Tensor] = [negative] * len(page.tokens)
    gold_keep: list[torch.Tensor] = [negative] * len(page.tokens)
    forbidden = (page.tokens > 0) & ~page.gold_keep
    required_own = (page.tokens > 0) & page.gold_keep
    required_token_subtree = bottom_up_sum(
        page, page.tokens * page.gold_keep
    )
    for index in range(len(page.tokens) - 1, -1, -1):
        base_value = local[index]
        full_value = local[index] + (
            raw_cost_per_token * float(page.tokens[index])
            if forbidden[index] else 0.0
        )
        gold_value = negative if forbidden[index] else local[index]
        for child in page.children[index]:
            base_carve = torch.tensor(
                -TRAINER.EXCLUDE_PENALTY * min(
                    1.0,
                    page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
                ),
                dtype=torch.float32,
            )
            carve = base_carve + (
                raw_cost_per_token * float(required_token_subtree[child])
            )
            base_value = base_value + smooth_pair(
                base_keep[child], base_carve, args.local_temperature
            )
            full_value = full_value + smooth_pair(
                keep[child], carve, args.local_temperature
            )
            if not forbidden[index]:
                if joint.required_subtree[child] > 0:
                    gold_value = gold_value + gold_keep[child]
                else:
                    gold_value = gold_value + smooth_pair(
                        gold_keep[child], base_carve, args.local_temperature
                    )
        base_keep[index] = base_value
        keep[index] = full_value
        gold_keep[index] = gold_value

    indices = np.flatnonzero(joint.root_allowed)
    if not len(indices):
        if page.status == "exclude":
            return torch.zeros((), dtype=torch.float32)
        raise ValueError(f"{page.id}: no legal Tree-DP root")
    prior = torch.as_tensor(joint.root_prior[indices], dtype=torch.float32)
    base_energy = torch.stack([base_keep[int(index)] for index in indices])
    base_energy = base_energy - TRAINER.ROOT_PENALTY + prior
    full_energy = torch.stack([keep[int(index)] for index in indices])
    full_energy = full_energy - TRAINER.ROOT_PENALTY + prior
    normalization = torch.clamp(torch.max(base_energy), min=0.0).detach()
    full_root_scores = root_scores(
        model, joint, root_scaling, full_energy, indices, normalization, args
    )
    full_root_by_node: list[torch.Tensor] = [negative] * len(page.tokens)
    for offset, index in enumerate(indices):
        full_root_by_node[int(index)] = full_root_scores[offset]

    compatible = np.asarray([
        index for index in indices
        if float(gold_keep[int(index)].detach()) > -1e6
    ], dtype=np.int64)
    gold_root_by_node: list[torch.Tensor] = [negative] * len(page.tokens)
    if len(compatible):
        gold_energy = torch.stack([
            gold_keep[int(index)] for index in compatible
        ])
        gold_energy = gold_energy - TRAINER.ROOT_PENALTY + torch.as_tensor(
            joint.root_prior[compatible], dtype=torch.float32
        )
        gold_root_scores = root_scores(
            model,
            joint,
            root_scaling,
            gold_energy,
            compatible,
            normalization,
            args,
        )
        for offset, index in enumerate(compatible):
            gold_root_by_node[int(index)] = gold_root_scores[offset]

    # F(v) includes the empty forest exactly once through the all-empty child
    # decomposition.  Selecting v and descending into its children are the
    # only two structural alternatives, so every non-overlapping root forest
    # has one derivation.
    full_free: list[torch.Tensor] = [negative] * len(page.tokens)
    gold_free: list[torch.Tensor] = [negative] * len(page.tokens)
    zero = torch.zeros((), dtype=torch.float32)
    for index in range(len(page.tokens) - 1, -1, -1):
        descend = sum((full_free[child] for child in page.children[index]), zero)
        if required_own[index]:
            descend = descend + score_cost_per_token * float(page.tokens[index])
        full_free[index] = torch.logaddexp(full_root_by_node[index], descend)
        gold_descend = (
            negative
            if required_own[index]
            else sum((gold_free[child] for child in page.children[index]), zero)
        )
        gold_free[index] = torch.logaddexp(
            gold_root_by_node[index], gold_descend
        )
    loss = full_free[0] - gold_free[0]
    if float(loss.detach()) < -1e-4:
        raise RuntimeError(
            f"{page.id}: compatible forest partition exceeds full partition"
        )
    return torch.clamp(loss, min=0.0)


def page_loss(model, joint, local_scaling, root_scaling, args) -> torch.Tensor:
    if args.forest:
        return forest_page_loss(model, joint, local_scaling, root_scaling, args)
    return single_root_page_loss(model, joint, local_scaling, root_scaling, args)


def train_model(zh_pages, wcxb_pages, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling_pages = [*zh_pages, *wcxb_pages]
    local_scaling = fit_scaling(
        scaling_pages, "local_features", args.scaling_nodes_per_page
    )
    root_scaling = fit_scaling(
        scaling_pages, "root_features", args.scaling_roots_per_page
    )
    model = JointEnergy(
        len(LOCAL_FEATURE_NAMES),
        len(STATIC_ROOT_FEATURE_NAMES),
        args.local_width,
        args.root_width,
        args.local_residual_bound,
        args.root_residual_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    zh_raw = np.asarray([
        args.exclude_weight if page.item.page.status == "exclude" else 1.0
        for page in zh_pages
    ], dtype=np.float64)
    weighted = [
        (page, float(weight) / max(1e-12, float(zh_raw.sum())))
        for page, weight in zip(zh_pages, zh_raw, strict=True)
    ] + [
        (page, args.wcxb_corpus_weight / max(1, len(wcxb_pages)))
        for page in wcxb_pages
    ]
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        batch_count = 0
        epoch_loss = 0.0
        for page, weight in weighted:
            loss = weight * page_loss(
                model, page, local_scaling, root_scaling, args
            )
            batch = batch + loss
            epoch_loss += float(loss.detach())
            batch_count += 1
            if batch_count == args.batch_pages:
                batch.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                batch = torch.zeros((), dtype=torch.float32)
                batch_count = 0
        if batch_count:
            batch.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.gradient_clip)
            optimizer.step()
        row = {"epoch": epoch, "loss": epoch_loss}
        history.append(row)
        print(json.dumps({"trainEpoch": row}), flush=True)
    return model, local_scaling, root_scaling, history


def single_root_hard_decode(model, joint, local_scaling, root_scaling, args):
    page = joint.item.page
    with torch.no_grad():
        local_input = normalized(joint.local_features, local_scaling)
        residual = model.local_residual(local_input).numpy()
    local = page.tokens * (joint.local_offset + residual)
    keep = np.zeros(len(page.tokens), dtype=np.float64)
    choices: list[list[bool]] = [[] for _ in page.tokens]
    retained_tokens = page.tokens.copy()
    for index in range(len(page.tokens) - 1, -1, -1):
        value = float(local[index])
        selected = float(page.tokens[index])
        child_choices = []
        for child in page.children[index]:
            carve = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= carve
            child_choices.append(bool(retain))
            value += keep[child] if retain else carve
            if retain:
                selected += retained_tokens[child]
        keep[index] = value
        choices[index] = child_choices
        retained_tokens[index] = selected
    indices = np.flatnonzero(
        joint.root_allowed & (retained_tokens >= TRAINER.MIN_RETAINED_TOKENS)
    )
    if not len(indices):
        return np.zeros(len(page.tokens), dtype=bool), None, 0.0
    energy = keep[indices] - TRAINER.ROOT_PENALTY + joint.root_prior[indices]
    normalization_value = max(0.0, float(np.max(energy)))
    with torch.no_grad():
        scores = root_scores(
            model,
            joint,
            root_scaling,
            torch.as_tensor(energy, dtype=torch.float32),
            indices,
            torch.tensor(normalization_value, dtype=torch.float32),
            args,
        ).numpy()
    offset = int(np.argmax(scores))
    if float(scores[offset]) <= 0:
        return np.zeros(len(page.tokens), dtype=bool), None, float(scores[offset])
    root = int(indices[offset])
    mask = np.zeros(len(page.tokens), dtype=bool)
    stack = [root]
    while stack:
        index = stack.pop()
        mask[index] = True
        for child_offset, child in enumerate(page.children[index]):
            if choices[index][child_offset]:
                stack.append(child)
    if int(page.tokens[mask].sum()) < TRAINER.MIN_RETAINED_TOKENS:
        return np.zeros(len(page.tokens), dtype=bool), None, float(scores[offset])
    return mask, root, float(scores[offset])


def forest_hard_decode(model, joint, local_scaling, root_scaling, args):
    page = joint.item.page
    with torch.no_grad():
        local_input = normalized(joint.local_features, local_scaling)
        residual = model.local_residual(local_input).numpy()
    local = page.tokens * (joint.local_offset + residual)
    keep = np.zeros(len(page.tokens), dtype=np.float64)
    choices: list[list[bool]] = [[] for _ in page.tokens]
    retained_tokens = page.tokens.copy()
    for index in range(len(page.tokens) - 1, -1, -1):
        value = float(local[index])
        selected = float(page.tokens[index])
        child_choices = []
        for child in page.children[index]:
            carve = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= carve
            child_choices.append(bool(retain))
            value += keep[child] if retain else carve
            if retain:
                selected += retained_tokens[child]
        keep[index] = value
        choices[index] = child_choices
        retained_tokens[index] = selected

    indices = np.flatnonzero(
        joint.root_allowed & (retained_tokens >= TRAINER.MIN_RETAINED_TOKENS)
    )
    if not len(indices):
        return np.zeros(len(page.tokens), dtype=bool), [], 0.0
    energy = keep[indices] - TRAINER.ROOT_PENALTY + joint.root_prior[indices]
    normalization_value = max(0.0, float(np.max(energy)))
    with torch.no_grad():
        scores = root_scores(
            model,
            joint,
            root_scaling,
            torch.as_tensor(energy, dtype=torch.float32),
            indices,
            torch.tensor(normalization_value, dtype=torch.float32),
            args,
        ).numpy()
    root_score = np.full(len(page.tokens), -np.inf, dtype=np.float64)
    root_score[indices] = scores
    free = np.zeros(len(page.tokens), dtype=np.float64)
    choose_root = np.zeros(len(page.tokens), dtype=bool)
    for index in range(len(page.tokens) - 1, -1, -1):
        descend = sum(free[child] for child in page.children[index])
        if root_score[index] >= descend and root_score[index] > 0.0:
            free[index] = root_score[index]
            choose_root[index] = True
        else:
            free[index] = descend

    roots = []
    pending = [0]
    while pending:
        index = pending.pop()
        if choose_root[index]:
            roots.append(index)
        else:
            pending.extend(reversed(page.children[index]))
    if not roots:
        return np.zeros(len(page.tokens), dtype=bool), [], float(free[0])
    mask = np.zeros(len(page.tokens), dtype=bool)
    for root in roots:
        pending = [root]
        while pending:
            index = pending.pop()
            mask[index] = True
            for child_offset, child in enumerate(page.children[index]):
                if choices[index][child_offset]:
                    pending.append(child)
    if int(page.tokens[mask].sum()) < TRAINER.MIN_RETAINED_TOKENS:
        return np.zeros(len(page.tokens), dtype=bool), [], float(free[0])
    return mask, roots, float(free[0])


def hard_decode(model, joint, local_scaling, root_scaling, args):
    if args.forest:
        return forest_hard_decode(model, joint, local_scaling, root_scaling, args)
    mask, root, score = single_root_hard_decode(
        model, joint, local_scaling, root_scaling, args
    )
    return mask, ([] if root is None else [root]), score


def page_row(model, joint, local_scaling, root_scaling, args) -> dict:
    page = joint.item.page
    baseline = ROOT_QUALITY.decode(
        joint.baseline_root_page,
        np.zeros(len(page.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    mask, roots, score = hard_decode(
        model, joint, local_scaling, root_scaling, args
    )
    available = bool(roots)
    baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(page, mask) if available else ""
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
        "candidateAvailable": available,
        "baselineRoots": baseline.roots,
        "candidateRoots": roots,
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": int(page.tokens[mask].sum()),
        "rootScore": score,
    }


def serialize_model(model: JointEnergy) -> dict:
    return {
        name: value.detach().numpy().tolist()
        for name, value in model.state_dict().items()
    }


def load_product(path: Path | None) -> tuple[dict[str, dict], str | None]:
    if path is None:
        return {}, None
    result = {}
    with path.open(encoding="utf8") as handle:
        for line in handle:
            record = json.loads(line)
            result[record["id"]] = record
    return result, TRAINER.sha256_file(path)


def product_summary(rows: list[dict], product: dict[str, dict]) -> dict | None:
    if not product:
        return None
    compared = []
    for row in rows:
        record = product.get(row["id"])
        if record is None:
            raise ValueError(f"missing current product record for {row['id']}")
        if row["status"] == "extract":
            incumbent = (
                float(record["productCurrent"]["metrics"]["mainNgramF1"])
                if record["productCurrent"]["available"]
                else 0.0
            )
            candidate = row["candidate"]
        else:
            incumbent = 0.0 if record["productCurrent"]["available"] else 1.0
            candidate = 0.0 if row["candidateAvailable"] else 1.0
        compared.append({
            "id": row["id"],
            "status": row["status"],
            "incumbent": incumbent,
            "candidate": candidate,
            "delta": candidate - incumbent,
        })
    extract = [row for row in compared if row["status"] == "extract"]
    deltas = [row["delta"] for row in extract]
    return {
        "extractPages": len(extract),
        "incumbentMeanF1": float(np.mean([row["incumbent"] for row in extract])),
        "candidateMeanF1": float(np.mean([row["candidate"] for row in extract])),
        "meanDelta": float(np.mean(deltas)),
        "wins": sum(value > 1e-9 for value in deltas),
        "ties": sum(abs(value) <= 1e-9 for value in deltas),
        "losses": sum(value < -1e-9 for value in deltas),
        "worst": min(deltas, default=0.0),
        "regressionsBelowMinusPointOne": sum(value < -0.1 for value in deltas),
        "regressionsBelowMinusPointTwo": sum(value < -0.2 for value in deltas),
        "incumbentExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["incumbent"] == 0.0
            for row in compared
        ),
        "candidateExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["candidate"] == 0.0
            for row in compared
        ),
        "worstPages": sorted(extract, key=lambda row: row["delta"])[:20],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--product-candidates", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch-pages", type=int, default=4)
    parser.add_argument("--local-width", type=int, default=12)
    parser.add_argument("--root-width", type=int, default=12)
    parser.add_argument("--local-residual-bound", type=float, default=1.5)
    parser.add_argument("--root-residual-bound", type=float, default=3.0)
    parser.add_argument("--root-energy-scale", type=float, default=20.0)
    parser.add_argument("--local-temperature", type=float, default=0.25)
    parser.add_argument("--learning-rate", type=float, default=0.0015)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--gradient-clip", type=float, default=5.0)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--scaling-nodes-per-page", type=int, default=128)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument(
        "--loss-augmentation",
        type=float,
        default=0.0,
        help="page-normalized token FP/FN cost used only in the training partition",
    )
    parser.add_argument(
        "--forest",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="decode an arbitrary non-overlapping root forest instead of one root",
    )
    parser.add_argument("--only-fold", type=int)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages = READABILITY.load_study_pages(args.zh_units, "zh")
    wcxb = READABILITY.load_study_pages(args.wcxb_units, "wcxb") if args.wcxb_units else []
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    product, product_sha = load_product(args.product_candidates)
    indices = np.arange(len(pages))
    groups = np.asarray([item.page.site_family for item in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        if args.only_fold is not None and fold != args.only_fold:
            continue
        train_items = [pages[int(index)] for index in train_indices]
        test_items = [pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train_items,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        train_pages = [
            build_joint_page(item, beta, args.scope_prior_weight)
            for item in train_items
        ]
        test_pages = [
            build_joint_page(item, beta, args.scope_prior_weight)
            for item in test_items
        ]
        wcxb_pages = [
            build_joint_page(item, beta, args.scope_prior_weight)
            for item in wcxb_train
        ]
        model, local_scaling, root_scaling, history = train_model(
            train_pages, wcxb_pages, args, 3000 + fold
        )
        fold_rows = [
            page_row(model, page, local_scaling, root_scaling, args)
            for page in test_pages
        ]
        rows.extend(fold_rows)
        summary = ROOT_QUALITY.summarize(fold_rows)
        fold_report = {
            "fold": fold,
            "summary": summary,
            "productComparison": product_summary(fold_rows, product),
            "readabilityBeta": beta.tolist(),
            "localScalingMean": local_scaling.mean.tolist(),
            "localScalingScale": local_scaling.scale.tolist(),
            "rootScalingMean": root_scaling.mean.tolist(),
            "rootScalingScale": root_scaling.scale.tolist(),
            "model": serialize_model(model),
            "history": history,
        }
        folds.append(fold_report)
        print(json.dumps({
            "fold": fold,
            "summary": summary,
            "productComparison": fold_report["productComparison"],
        }, ensure_ascii=False), flush=True)

    summary = ROOT_QUALITY.summarize(rows)
    report = {
        "schema": "qingzhou.tree-dp-joint-crf-study.v1",
        "protocol": {
            "model": (
                "multi-root-forest-dp-joint-local-carve-and-root-empty"
                if args.forest else
                "single-tree-dp-joint-local-carve-and-global-root-empty"
            ),
            "trainingObjective": (
                "latent-forest-crf-page-normalized-nll"
                if args.forest else "latent-tree-crf-page-normalized-nll"
            ),
            "runtimeReadabilityCandidate": False,
            "inference": (
                "one-max-keep-carve-pass-plus-one-max-forest-pass"
                if args.forest else
                "one-max-keep-carve-pass-plus-one-root-scan"
            ),
            "inferenceComplexity": "O(N*(localWidth+rootWidth))",
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "localFeatureNames": LOCAL_FEATURE_NAMES,
            "staticRootFeatureNames": STATIC_ROOT_FEATURE_NAMES,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "siteFamilyOof": {
            "summary": summary,
            "productComparison": product_summary(rows, product),
            "rows": rows,
            "folds": folds,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "globalChoiceStudySha256": TRAINER.sha256_file(GLOBAL_PATH),
            "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
            "productCandidatesSha256": product_sha,
            "sourceFingerprints": READABILITY.source_fingerprints(pages),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(args.output),
        "summary": summary,
        "productComparison": report["siteFamilyOof"]["productComparison"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
