#!/usr/bin/env python3
"""Contextual bounded action energy for a Readability-free Tree-DP.

The ordinary Tree-DP forest is the fixed zero-energy reference.  Every legal
single-root reconstruction receives its existing page-normalized DP energy
plus a small bounded nonlinear residual; empty can either be learned or share
the fixed zero-energy reference.  A
loss-augmented page partition trains the actions jointly, avoiding the
winner's-curse failure of independently regressed root utilities.

Human region labels are primary.  Exact candidate provenance supplies full
mask supervision and positive-only provenance supplies keep evidence without
turning unknown nodes into negatives.  Both are low-weight training-only
losses.  Serving runs one model over one DOM tree and never constructs a
Readability or legacy candidate.
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
UTILITY_PATH = HERE / "study-tree-dp-utility-model.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_bounded_action_base", UTILITY_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {UTILITY_PATH}")
UTILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = UTILITY
SPEC.loader.exec_module(UTILITY)
RELATION = UTILITY.RELATION
ACTION = UTILITY.ACTION
RELATIVE = UTILITY.RELATIVE
GLOBAL_DISTILL = UTILITY.GLOBAL_DISTILL
DISTILL = UTILITY.DISTILL
GLOBAL = UTILITY.GLOBAL
TRAINER = UTILITY.TRAINER


@dataclass
class StructuredPage:
    utility: object
    features: np.ndarray
    prior: np.ndarray
    ordinary: np.ndarray
    teacher_targets: list[tuple[str, np.ndarray, float]]


READABILITY_RETAINED_FEATURE_NAMES = [
    "retainedReadabilityPositiveClassMean",
    "retainedReadabilityNegativeClassMean",
    "retainedReadabilityUnlikelyShare",
    "retainedReadabilityRoleRejectedShare",
    "retainedReadabilityParagraphEvidenceMean",
    "retainedReadabilityPositiveScoreMean",
    "retainedReadabilityNegativeScoreMean",
]
FEATURE_NAMES = [
    *RELATION.RELATION_FEATURE_NAMES,
    *READABILITY_RETAINED_FEATURE_NAMES,
]


class BoundedActionEnergy(torch.nn.Module):
    def __init__(
        self,
        dimensions: int,
        width: int,
        residual_bound: float,
        page_context: bool,
        fixed_empty_reference: bool,
        action_validity: bool,
        adaptive_override: bool,
        override_bound: float,
    ):
        super().__init__()
        self.residual_bound = residual_bound
        self.page_context = page_context
        self.fixed_empty_reference = fixed_empty_reference
        self.action_validity = action_validity
        self.adaptive_override = adaptive_override
        self.override_bound = override_bound
        self.network = torch.nn.Sequential(
            # Readability's candidate selection is page-relative: a candidate
            # is meaningful because it dominates its peers, not because one
            # absolute score crosses a universal threshold.  Mean/max context
            # gives the Tree-DP the same useful invariant while retaining a
            # single O(N * width) scoring pass.
            torch.nn.Linear(dimensions * (3 if page_context else 1), width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        self.empty = torch.nn.Sequential(
            torch.nn.Linear(dimensions * 2, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        self.validity = torch.nn.Sequential(
            torch.nn.Linear(dimensions * (3 if page_context else 1), width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        if adaptive_override:
            self.override = torch.nn.Sequential(
                torch.nn.Linear(dimensions * (3 if page_context else 1), width),
                torch.nn.Tanh(),
                torch.nn.Linear(width, 1),
            )
            self.override_gate = torch.nn.Sequential(
                torch.nn.Linear(dimensions * (3 if page_context else 1), width),
                torch.nn.Tanh(),
                torch.nn.Linear(width, 1),
            )
        # Exact ordinary-DP behavior is the initialization, not something the
        # optimizer has to rediscover.
        torch.nn.init.zeros_(self.network[-1].weight)
        torch.nn.init.zeros_(self.network[-1].bias)
        torch.nn.init.zeros_(self.empty[-1].weight)
        torch.nn.init.zeros_(self.empty[-1].bias)
        torch.nn.init.zeros_(self.validity[-1].weight)
        torch.nn.init.zeros_(self.validity[-1].bias)
        if adaptive_override:
            torch.nn.init.zeros_(self.override[-1].weight)
            torch.nn.init.zeros_(self.override[-1].bias)
            torch.nn.init.zeros_(self.override_gate[-1].weight)
            torch.nn.init.constant_(self.override_gate[-1].bias, -2.0)

    def forward(
        self,
        values: torch.Tensor,
        prior: torch.Tensor,
        ordinary: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        if self.page_context:
            mean = values.mean(dim=0, keepdim=True)
            maximum = values.max(dim=0, keepdim=True).values
            contextual = torch.cat((values, values - mean, values - maximum), dim=1)
        else:
            contextual = values
        raw = self.network(contextual).squeeze(1)
        residual = self.residual_bound * torch.tanh(raw / self.residual_bound)
        if self.adaptive_override:
            override_raw = self.override(contextual).squeeze(1)
            override_value = self.override_bound * torch.tanh(
                override_raw / self.override_bound
            )
            override = torch.sigmoid(
                self.override_gate(contextual).squeeze(1)
            ) * override_value
            residual = residual + override
        else:
            override = torch.zeros_like(residual)
        scores = prior + residual
        scores = torch.where(ordinary, torch.zeros_like(scores), scores)
        validity = (
            self.validity(contextual).squeeze(1)
            if self.action_validity else torch.zeros_like(scores)
        )
        if self.fixed_empty_reference:
            # A root must earn positive energy to beat abstention.  This
            # calibrates root validity on every labelled page instead of
            # asking a separate page head to infer the rare exclude class.
            empty = prior.new_zeros(())
        else:
            pooled = torch.cat((values.mean(dim=0), values.max(dim=0).values))
            empty = self.residual_bound * torch.tanh(
                self.empty(pooled).squeeze() / self.residual_bound
            )
        return scores, empty, validity, override


def mask_quality(mask: np.ndarray, keep: np.ndarray, tokens: np.ndarray) -> float:
    selected = float(tokens[mask].sum())
    target = float(tokens[keep].sum())
    matched = float(tokens[mask & keep].sum())
    precision = matched / selected if selected else 0.0
    recall = matched / target if target else 0.0
    return (
        2.0 * precision * recall / (precision + recall)
        if precision + recall else 0.0
    )


def retained_readability_features(root_teacher_page, utility) -> np.ndarray:
    """Aggregate Readability evidence over the exact keep/carve action mask."""
    action = utility.relative.action
    page = action.source
    context = np.asarray(
        root_teacher_page.choice.root_page.item.context, dtype=np.float64
    )
    if context.shape != (len(page.tokens), len(DISTILL.RICH_FEATURE_NAMES)):
        raise ValueError(
            f"{page.id}: rich Readability context has shape {context.shape}"
        )
    token_values = np.column_stack((
        np.maximum(0.0, context[:, 2]),
        np.maximum(0.0, -context[:, 2]),
        np.clip(context[:, 1], 0.0, 1.0),
        np.clip(context[:, 4], 0.0, 1.0),
        np.maximum(0.0, context[:, 5]),
        np.maximum(0.0, context[:, 9]),
        np.maximum(0.0, -context[:, 9]),
    )) * page.tokens[:, None]
    root_page = action.choice.root_page
    retained = np.column_stack([
        ACTION.kept_weight(root_page, token_values[:, column])
        for column in range(token_values.shape[1])
    ])
    rows = []
    for roots, kind in zip(utility.roots, utility.kinds, strict=True):
        if kind == "ordinary":
            mask = action.baseline.mask
            total = max(1.0, float(page.tokens[mask].sum()))
            rows.append(token_values[mask].sum(axis=0) / total)
        else:
            root = int(roots[0])
            total = max(1.0, float(root_page.kept_tokens[root]))
            rows.append(retained[root] / total)
    return np.asarray(rows, dtype=np.float64).reshape(
        (-1, len(READABILITY_RETAINED_FEATURE_NAMES))
    )


def teacher_action_quality(utility, teacher) -> tuple[str, np.ndarray, float] | None:
    action = utility.relative.action
    page = action.source
    positive_tokens = page.tokens * teacher.keep
    positive_total = float(positive_tokens.sum())
    if positive_total <= 0:
        return None
    complete_exact = bool(
        teacher.exact and np.all(teacher.known[page.tokens > 0])
    )
    retained_positive = ACTION.kept_weight(
        action.choice.root_page, positive_tokens
    )
    values = []
    for roots, kind in zip(utility.roots, utility.kinds, strict=True):
        if kind == "ordinary":
            mask = action.baseline.mask
            matched = float(positive_tokens[mask].sum())
            if complete_exact:
                values.append(mask_quality(mask, teacher.keep, page.tokens))
            else:
                values.append(matched / positive_total)
            continue
        root = int(roots[0])
        matched = float(retained_positive[root])
        if complete_exact:
            selected = float(action.choice.root_page.kept_tokens[root])
            precision = matched / selected if selected else 0.0
            recall = matched / positive_total
            values.append(
                2.0 * precision * recall / (precision + recall)
                if precision + recall else 0.0
            )
        else:
            # Positive-only provenance can reward retained evidence but cannot
            # call an unmatched source node noise.
            values.append(matched / positive_total)
    strength = float(teacher.quality) * float(teacher.coverage)
    if strength <= 0:
        return None
    return (
        f"{teacher.key}:{'exact' if complete_exact else 'positive'}",
        np.asarray(values, dtype=np.float64),
        strength,
    )


def build_structured_page(root_teacher_page, args) -> StructuredPage:
    utility = UTILITY.build_utility_page(
        root_teacher_page, use_legacy_teacher=False
    )
    action = utility.relative.action
    prefix = 1 if action.baseline.available else 0
    prior = np.concatenate((
        np.zeros(prefix, dtype=np.float64),
        action.choice.energy_offset.copy(),
    ))
    ordinary = np.zeros(len(prior), dtype=bool)
    if prefix:
        ordinary[0] = True
    if len(prior) != len(utility.features):
        raise ValueError("action prior and feature coordinates differ")

    # A single root with the same token mask as the ordinary forest is not a
    # distinct content answer.  Canonicalizing it to ordinary removes a large
    # set of zero-value structural aliases and makes every learned switch
    # observable in the extracted text.
    selected = np.asarray([
        not args.canonicalize_same or kind != "same"
        for kind in utility.kinds
    ], dtype=bool)
    if not np.all(selected):
        utility.features = utility.features[selected]
        utility.roots = [value for value, keep in zip(utility.roots, selected) if keep]
        utility.kinds = [value for value, keep in zip(utility.kinds, selected) if keep]
        utility.precision = utility.precision[selected]
        utility.recall = utility.recall[selected]
        utility.f1 = utility.f1[selected]
        prior = prior[selected]
        ordinary = ordinary[selected]

    features = utility.features
    if args.readability_aggregates:
        readability = retained_readability_features(root_teacher_page, utility)
        features = np.column_stack((features, readability))
    teacher_targets = []
    source = root_teacher_page.source
    if source is not None:
        teachers = [*source.ensemble_teachers]
        if (
            args.teacher_mode not in ("single-exact", "single-plus-product-exact")
            and source.product_teacher is not None
        ):
            teachers.append(source.product_teacher)
        if args.teacher_mode in ("single-exact", "single-plus-product-exact"):
            teachers = [teacher for teacher in teachers if teacher.exact]
            teachers = [max(
                teachers,
                key=lambda teacher: (teacher.quality, teacher.coverage, teacher.key),
            )] if teachers else []
            if (
                args.teacher_mode == "single-plus-product-exact"
                and source.product_teacher is not None
                and source.product_teacher.exact
            ):
                teachers.append(source.product_teacher)
        elif args.teacher_mode == "all-exact":
            teachers = [teacher for teacher in teachers if teacher.exact]
        unique = {}
        for teacher in teachers:
            identity = (
                bool(teacher.exact), teacher.known.tobytes(), teacher.keep.tobytes()
            )
            incumbent = unique.get(identity)
            if incumbent is None or (
                teacher.quality, teacher.coverage, teacher.key
            ) > (incumbent.quality, incumbent.coverage, incumbent.key):
                unique[identity] = teacher
        for teacher in unique.values():
            target = teacher_action_quality(utility, teacher)
            if target is not None:
                teacher_targets.append(target)
    return StructuredPage(
        utility=utility,
        features=features,
        prior=prior,
        ordinary=ordinary,
        teacher_targets=teacher_targets,
    )


def sampled_offsets(page: StructuredPage, maximum: int) -> np.ndarray:
    count = len(page.prior)
    if count <= maximum:
        return np.arange(count, dtype=np.int64)
    per_bucket = max(1, maximum // 4)
    buckets = [
        np.argsort(page.prior)[-per_bucket:],
        np.argsort(page.utility.f1)[-per_bucket:],
        np.linspace(0, count - 1, per_bucket, dtype=np.int64),
    ]
    if page.teacher_targets:
        teacher_best = np.max(np.column_stack([
            value for _, value, _ in page.teacher_targets
        ]), axis=1)
        buckets.append(np.argsort(teacher_best)[-per_bucket:])
    else:
        buckets.append(np.argsort(page.utility.precision)[-per_bucket:])
    selected = np.unique(np.concatenate(buckets))
    if np.any(page.ordinary):
        selected = np.unique(np.concatenate((selected, np.flatnonzero(page.ordinary))))
    if len(selected) < maximum:
        missing = np.setdiff1d(np.arange(count), selected)
        selected = np.concatenate((selected, missing[:maximum - len(selected)]))
    return np.sort(selected[:maximum])


def fit_scaling(pages, maximum: int):
    matrices = [
        page.features[sampled_offsets(page, maximum)]
        for page in pages if len(page.features)
    ]
    matrix = np.concatenate(matrices) if matrices else np.zeros((1, len(FEATURE_NAMES)))
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return RELATION.Scaling(mean, scale)


def page_tensors(page: StructuredPage, scaling, args, offsets=None):
    if offsets is None:
        offsets = np.arange(len(page.prior), dtype=np.int64)
    features = np.clip(
        (page.features[offsets] - scaling.mean) / scaling.scale,
        -8.0,
        8.0,
    )
    return (
        torch.as_tensor(features, dtype=torch.float32),
        torch.as_tensor(args.current_energy_prior * page.prior[offsets], dtype=torch.float32),
        torch.as_tensor(page.ordinary[offsets], dtype=torch.bool),
    )


def structured_loss(
    scores: torch.Tensor,
    empty_score: torch.Tensor,
    quality: torch.Tensor,
    empty_quality: float,
    args,
    product_floor: float | None = None,
) -> torch.Tensor:
    empty_target = torch.as_tensor(empty_quality, dtype=torch.float32)
    best = torch.maximum(torch.max(quality), empty_target)
    action_gap = best - quality
    empty_gap = best - empty_target
    action_cost = (
        args.loss_margin * action_gap
        + args.tail_loss_margin * torch.relu(action_gap - args.tail_delta)
    )
    empty_cost = (
        args.loss_margin * empty_gap
        + args.tail_loss_margin * torch.relu(empty_gap - args.tail_delta)
    )
    if product_floor is not None:
        # Distil only the incumbent's observed safety floor, never its output
        # or identity.  The quadratic term concentrates capacity on actions
        # that would be material regressions while leaving near-ties alone.
        floor = torch.as_tensor(product_floor, dtype=torch.float32)
        action_regression = torch.relu(floor - quality - args.tail_delta)
        empty_regression = torch.relu(floor - empty_target - args.tail_delta)
        action_cost = action_cost + args.tail_loss_margin * action_regression.square()
        empty_cost = empty_cost + args.tail_loss_margin * empty_regression.square()
    denominator = torch.logsumexp(torch.cat((
        scores + action_cost,
        (empty_score + empty_cost).reshape(1),
    )), dim=0)
    compatible = quality >= best - args.gold_tolerance
    numerator_values = scores[compatible]
    if empty_quality >= float(best) - args.gold_tolerance:
        numerator_values = torch.cat((numerator_values, empty_score.reshape(1)))
    return denominator - torch.logsumexp(numerator_values, dim=0)


def incumbent_safety_ranking_loss(
    scores: torch.Tensor,
    empty_score: torch.Tensor,
    quality: torch.Tensor,
    empty_quality: float,
    product_floor: float | None,
    args,
) -> torch.Tensor:
    """Separate every materially unsafe action from the best safe action.

    This is a training-only constraint on the same global action energy used
    at inference.  It is deliberately not a validity classifier or selector:
    serving still takes one argmax over empty, ordinary, and legal root
    actions.  Pages whose legal action space cannot match the incumbent within
    the tolerated loss provide no impossible constraint.
    """
    if product_floor is None:
        return scores.new_zeros(())
    floor = float(product_floor) - args.tail_delta
    all_scores = torch.cat((scores, empty_score.reshape(1)))
    all_quality = torch.cat((
        quality,
        torch.as_tensor([empty_quality], dtype=quality.dtype),
    ))
    safe = all_quality >= floor
    unsafe = ~safe
    if not torch.any(safe) or not torch.any(unsafe):
        return scores.new_zeros(())
    best_safe = torch.max(all_scores[safe])
    worst_unsafe = torch.max(all_scores[unsafe])
    return torch.nn.functional.softplus(
        worst_unsafe + args.incumbent_ranking_margin - best_safe
    )


def conditional_action_loss(
    scores: torch.Tensor,
    quality: torch.Tensor,
    args,
) -> torch.Tensor:
    """Rank DOM actions given that the page has extractable content."""
    best = torch.max(quality)
    action_gap = best - quality
    action_cost = (
        args.loss_margin * action_gap
        + args.tail_loss_margin * torch.relu(action_gap - args.tail_delta)
    )
    denominator = torch.logsumexp(scores + action_cost, dim=0)
    compatible = quality >= best - args.gold_tolerance
    return denominator - torch.logsumexp(scores[compatible], dim=0)


def balanced_validity_loss(
    logits: torch.Tensor,
    quality: torch.Tensor,
    tolerance: float,
) -> torch.Tensor:
    """Calibrate whether an action lies inside the page's safe quality band.

    Each page contributes at most one positive and one negative class mean, so
    a wide DOM cannot dominate training merely by producing more root actions.
    """
    best = torch.max(quality)
    positive = (best > 0) & (quality >= best - tolerance)
    values = []
    if torch.any(positive):
        values.append(torch.nn.functional.softplus(-logits[positive]).mean())
    if torch.any(~positive):
        values.append(torch.nn.functional.softplus(logits[~positive]).mean())
    return torch.stack(values).mean() if values else logits.new_zeros(())


def page_loss(model, page: StructuredPage, scaling, args):
    if not len(page.prior):
        return torch.zeros((), dtype=torch.float32)
    offsets = sampled_offsets(page, args.maximum_roots_per_page)
    scores, empty, validity, override = model(
        *page_tensors(page, scaling, args, offsets)
    )
    source = page.utility.relative.action.source
    quality = torch.as_tensor(page.utility.f1[offsets], dtype=torch.float32)
    empty_quality = 1.0 if source.status == "exclude" else 0.0
    product_floor = (
        float(page.utility.source.product_f1)
        if args.product_floor_loss
        and source.status == "extract"
        and page.utility.source is not None
        and page.utility.source.product_available
        else None
    )
    if args.action_validity:
        # Keep the already tail-safe structured rank objective intact.  The
        # auxiliary head only learns whether an action is eligible to compete.
        loss = structured_loss(
            scores, empty, quality, empty_quality, args, product_floor
        )
        loss = loss + args.validity_loss_weight * balanced_validity_loss(
            validity, quality, args.tail_delta
        )
    else:
        loss = structured_loss(
            scores, empty, quality, empty_quality, args, product_floor
        )
    if args.incumbent_ranking_loss:
        loss = loss + args.incumbent_ranking_weight * incumbent_safety_ranking_loss(
            scores,
            empty,
            quality,
            empty_quality,
            (
                float(page.utility.source.product_f1)
                if source.status == "extract"
                and page.utility.source is not None
                and page.utility.source.product_available
                else None
            ),
            args,
        )
    if args.adaptive_override:
        loss = loss + args.override_penalty * torch.mean(torch.abs(override))
    if page.teacher_targets:
        teacher_losses = []
        teacher_weights = []
        for _, target, strength in page.teacher_targets:
            teacher_quality = torch.as_tensor(
                target[offsets], dtype=torch.float32
            )
            teacher_losses.append(
                structured_loss(scores, empty, teacher_quality, 0.0, args)
            )
            teacher_weights.append(strength)
        total = max(1e-12, float(sum(teacher_weights)))
        auxiliary = sum(
            weight * value
            for weight, value in zip(teacher_weights, teacher_losses, strict=True)
        ) / total
        loss = loss + args.teacher_loss_weight * auxiliary
    return loss


def train_model(zh, wcxb, wmb, args, seed):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling([*zh, *wcxb, *wmb], args.scaling_roots_per_page)
    model = BoundedActionEnergy(
        zh[0].features.shape[1] if zh else wcxb[0].features.shape[1],
        args.hidden_width,
        args.residual_bound,
        args.page_context,
        args.fixed_empty_reference,
        args.action_validity,
        args.adaptive_override,
        args.override_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    site_counts = {}
    if args.site_balanced_training:
        for page in zh:
            family = page.utility.relative.action.source.site_family
            site_counts[family] = site_counts.get(family, 0) + 1
    raw = np.asarray([
        (
            args.exclude_weight
            if page.utility.relative.action.source.status == "exclude" else 1.0
        ) / (
            site_counts.get(page.utility.relative.action.source.site_family, 1)
        )
        for page in zh
    ])
    weighted = [
        (page, float(weight) / max(1.0, float(raw.sum())))
        for page, weight in zip(zh, raw, strict=True)
    ] + [
        (page, args.wcxb_corpus_weight / max(1, len(wcxb))) for page in wcxb
    ] + [
        (page, args.wmb_corpus_weight / max(1, len(wmb))) for page in wmb
    ]
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        count = 0
        epoch_loss = 0.0
        for page, weight in weighted:
            loss = weight * page_loss(model, page, scaling, args)
            batch = batch + loss
            epoch_loss += float(loss.detach())
            count += 1
            if count == args.batch_pages:
                batch.backward()
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                batch = torch.zeros((), dtype=torch.float32)
                count = 0
        if count:
            batch.backward()
            optimizer.step()
        history.append({"epoch": epoch, "loss": epoch_loss})
    return model, scaling, history


def evaluate(page: StructuredPage, model, scaling, args):
    action = page.utility.relative.action
    source = action.source
    if len(page.prior):
        with torch.no_grad():
            scores, empty_score, validity, _ = model(
                *page_tensors(page, scaling, args)
            )
        scores = scores.numpy()
        empty_score = float(empty_score)
        validity = validity.numpy()
        action_eligible = np.ones(len(scores), dtype=bool)
        if not action.baseline.available and args.minimum_rescue_tokens > 0:
            retained_tokens = np.asarray([
                (
                    action.baseline.retained_tokens
                    if kind == "ordinary"
                    else action.choice.root_page.kept_tokens[int(roots[0])]
                )
                for roots, kind in zip(
                    page.utility.roots, page.utility.kinds, strict=True
                )
            ])
            # Moving from an empty answer to a non-empty answer is a distinct
            # content obligation.  A small fragment may compete only when its
            # learned action energy is exceptionally strong; otherwise it
            # needs enough retained text to constitute a useful answer.  This
            # is part of the single model's feasible action set, not a legacy
            # candidate or a site-specific selector.
            action_eligible = (
                (retained_tokens >= args.minimum_rescue_tokens)
                | (scores >= args.short_rescue_score)
            )
        if args.action_validity:
            feasible = (validity > 0.0) & action_eligible
            if np.any(feasible):
                selected = int(np.flatnonzero(feasible)[np.argmax(scores[feasible])])
                choose_empty = False
            else:
                selected = int(np.argmax(scores))
                choose_empty = True
        else:
            if np.any(action_eligible):
                eligible_offsets = np.flatnonzero(action_eligible)
                selected = int(eligible_offsets[np.argmax(scores[action_eligible])])
            else:
                selected = int(np.argmax(scores))
            # The ordinary forest is the incumbent zero-energy action.  When
            # fixed empty ties it at zero, preserve the ordinary answer; a
            # rescue root without an ordinary answer must strictly beat zero.
            if not action_eligible[selected]:
                choose_empty = True
            elif args.fixed_empty_reference:
                choose_empty = not (
                    float(scores[selected]) > empty_score
                    or bool(page.ordinary[selected])
                )
            else:
                choose_empty = empty_score >= float(scores[selected])
    else:
        scores = np.zeros(0)
        validity = np.zeros(0)
        empty_score = 0.0
        selected = -1
        choose_empty = True
    if choose_empty:
        mask = np.zeros(len(source.tokens), dtype=bool)
        roots = []
        kind = "empty"
        available = False
        selected_score = empty_score
        selected_validity = None
    else:
        roots = page.utility.roots[selected]
        kind = page.utility.kinds[selected]
        mask = (
            action.baseline.mask.copy()
            if kind == "ordinary"
            else GLOBAL.reconstruct(action.choice.root_page, int(roots[0]))
        )
        available = int(source.tokens[mask].sum()) >= TRAINER.MIN_RETAINED_TOKENS
        selected_score = float(scores[selected])
        selected_validity = float(validity[selected]) if args.action_validity else None
    baseline = action.baseline
    baseline_text = TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.utility.source.product_f1 if source.status == "extract" else 0.0
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
        "candidateRoots": roots,
        "baselineRetainedTokens": baseline.retained_tokens,
        "candidateRetainedTokens": int(source.tokens[mask].sum()) if available else 0,
        "selectedAction": kind,
        "selectedScore": selected_score,
        "emptyScore": empty_score,
        "selectedValidityLogit": selected_validity,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.utility.source.product_available,
        "teacherKey": ",".join(
            key for key, _, _ in page.teacher_targets
        ) or None,
        "teacherSourceQuality": max(
            (strength for _, _, strength in page.teacher_targets), default=0.0
        ),
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--residual-bound", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--tail-loss-margin", type=float, default=8.0)
    parser.add_argument("--tail-delta", type=float, default=0.10)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--teacher-loss-weight", type=float, default=0.15)
    parser.add_argument("--current-energy-prior", type=float, default=4.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--maximum-roots-per-page", type=int, default=128)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    parser.add_argument(
        "--page-context", action=argparse.BooleanOptionalAction, default=True
    )
    parser.add_argument(
        "--canonicalize-same", action=argparse.BooleanOptionalAction, default=True
    )
    parser.add_argument(
        "--readability-aggregates",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument(
        "--teacher-mode",
        choices=("single-exact", "single-plus-product-exact", "all-exact", "all"),
        default="all",
    )
    parser.add_argument(
        "--fixed-empty-reference",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "use zero-energy abstention instead of a learned empty-page head; "
            "ordinary zero-energy ties retain the ordinary forest"
        ),
    )
    parser.add_argument(
        "--action-validity",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "rank actions conditional on content and learn a separate per-action "
            "nonempty feasibility logit; empty is chosen when no action is feasible"
        ),
    )
    parser.add_argument("--validity-loss-weight", type=float, default=1.0)
    parser.add_argument(
        "--minimum-rescue-tokens",
        type=int,
        default=0,
        help=(
            "minimum retained token mass when changing an empty ordinary "
            "answer to non-empty; zero disables the content obligation"
        ),
    )
    parser.add_argument(
        "--short-rescue-score",
        type=float,
        default=float("inf"),
        help=(
            "allow a shorter empty-to-nonempty rescue only when its learned "
            "action energy reaches this threshold"
        ),
    )
    parser.add_argument(
        "--product-floor-loss",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "add a training-only quadratic tail cost below the incumbent's "
            "human-gold F1; incumbent output is never a serving feature"
        ),
    )
    parser.add_argument(
        "--incumbent-ranking-loss",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "train the shared action energy to rank every action more than "
            "tail-delta below the incumbent behind the best legal safe action"
        ),
    )
    parser.add_argument("--incumbent-ranking-weight", type=float, default=1.0)
    parser.add_argument("--incumbent-ranking-margin", type=float, default=1.0)
    parser.add_argument(
        "--adaptive-override",
        action=argparse.BooleanOptionalAction,
        default=False,
        help=(
            "add a sparse learned gate for rare corrections beyond the base "
            "bounded residual; inference remains one shared action energy"
        ),
    )
    parser.add_argument("--override-bound", type=float, default=6.0)
    parser.add_argument("--override-penalty", type=float, default=0.05)
    parser.add_argument(
        "--site-balanced-training",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="give every Chinese siteFamily equal total loss mass per fold",
    )
    parser.add_argument("--only-fold", type=int)
    return parser.parse_args()


def main():
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = RELATIVE.load_wmb_pages(args.wmb_units)
    wmb_train = [item for item in wmb if item.page.split == "wmb-train"]
    wmb_holdout = [item for item in wmb if item.page.split == "wmb-holdout"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        if args.only_fold is not None and fold != args.only_fold:
            continue
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        train_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_page(item, beta, "ensemble", args), args
            )
            for item in train
        ]
        test_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_page(item, beta, "ensemble", args), args
            )
            for item in test
        ]
        wcxb_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_wcxb_page(item, beta, args), args
            )
            for item in wcxb_train
        ]
        wmb_pages = [
            build_structured_page(
                RELATIVE.build_wmb_page(item, beta, args), args
            )
            for item in wmb_train
        ]
        model, scaling, history = train_model(
            train_pages, wcxb_pages, wmb_pages, args, 19000 + fold
        )
        fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        summary = GLOBAL_DISTILL.summary(fold_rows)
        folds.append({
            "fold": fold,
            "summary": summary,
            "history": history,
            "model": {
                name: value.detach().numpy().tolist()
                for name, value in model.state_dict().items()
            },
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "localBeta": beta.tolist(),
        })
        print(json.dumps({"fold": fold, "summary": summary}, ensure_ascii=False), flush=True)
    summary = GLOBAL_DISTILL.summary(rows)
    validation_report = None
    if args.zh_validation_units is not None:
        validation, validation_audit = DISTILL.load_pages(
            args,
            directory=args.zh_validation_units,
            allowed_splits=frozenset({"validation"}),
        )
        final_beta = DISTILL.fit_increment(pages, wcxb_train, "ensemble", args)
        final_train_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_page(item, final_beta, "ensemble", args), args
            )
            for item in pages
        ]
        final_validation_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_page(item, final_beta, "ensemble", args), args
            )
            for item in validation
        ]
        final_wcxb_pages = [
            build_structured_page(
                GLOBAL_DISTILL.build_wcxb_page(item, final_beta, args), args
            )
            for item in wcxb_train
        ]
        final_wmb_pages = [
            build_structured_page(
                RELATIVE.build_wmb_page(item, final_beta, args), args
            )
            for item in wmb_train
        ]
        final_model, final_scaling, final_history = train_model(
            final_train_pages,
            final_wcxb_pages,
            final_wmb_pages,
            args,
            19999,
        )
        validation_rows = [
            evaluate(page, final_model, final_scaling, args)
            for page in final_validation_pages
        ]
        validation_report = {
            "summary": GLOBAL_DISTILL.summary(validation_rows),
            "rows": validation_rows,
            "audit": validation_audit,
            "history": final_history,
            "model": {
                name: value.detach().numpy().tolist()
                for name, value in final_model.state_dict().items()
            },
            "scalingMean": final_scaling.mean.tolist(),
            "scalingScale": final_scaling.scale.tolist(),
            "localBeta": final_beta.tolist(),
        }
    report = {
        "schema": "qingzhou.tree-dp-bounded-action-study.v2",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeActions": ["ordinary", "empty", "rescue", "expand", "carve", "replace"],
            "rootPrior": "page-normalized-current-tree-dp-energy",
            "ordinaryPrior": "fixed-zero-reference",
            "emptyPrior": (
                "per-action-validity-feasibility"
                if args.action_validity else (
                    "fixed-zero-reference"
                    if args.fixed_empty_reference else "learned-page-action"
                )
            ),
            "emptyToNonemptyObligation": {
                "minimumRetainedTokens": args.minimum_rescue_tokens,
                "shortRescueScore": args.short_rescue_score,
            },
            "candidateAnswers": (
                "exact-mask-or-positive-only-keep-evidence-training-loss-only"
            ),
            "incumbentUsage": (
                "training-only-human-gold-safety-ranking"
                if args.incumbent_ranking_loss else (
                    "training-only-human-gold-tail-floor"
                    if args.product_floor_loss else "evaluation-only"
                )
            ),
            "readabilityUsage": "generic DOM features only; no runtime candidate",
            "actionCanonicalization": "same-token root aliases collapse to ordinary",
            "rootContext": (
                "action features plus page mean/max differences"
                if args.page_context else "absolute action features"
            ),
            "zhValidationOpened": args.zh_validation_units is not None,
            "zhValidationRole": (
                "consumed-development-diagnostic"
                if args.zh_validation_units is not None else None
            ),
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "inferenceComplexity": "O(N*hiddenWidth)",
            "featureNames": [
                *RELATION.RELATION_FEATURE_NAMES,
                *(
                    READABILITY_RETAINED_FEATURE_NAMES
                    if args.readability_aggregates else []
                ),
            ],
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "zhValidation": validation_report,
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "utilityStudySha256": TRAINER.sha256_file(UTILITY_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
