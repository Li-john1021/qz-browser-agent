#!/usr/bin/env python3
"""Predict conservative extraction utility for every Tree-DP action.

This study is the direct replacement formulation: the ordinary Tree-DP forest
and every legal single-root reconstruction compete in one model.  The model
predicts lower-quantile precision and recall, plus an auxiliary probability
that the action matches or beats the best training-only legacy candidate.  At
runtime it sees only generic DOM/Readability-derived features and its own DP
state; no legacy candidate is generated.

Candidate answers affect the global loss, never the serving feature vector.
Chinese validation/test and multilingual holdouts are refused by construction.
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
import torch.nn.functional as functional
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
RELATION_PATH = HERE / "study-tree-dp-relative-actions.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_utility_relation_base", RELATION_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {RELATION_PATH}")
RELATION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RELATION
SPEC.loader.exec_module(RELATION)
ACTION = RELATION.ACTION
RELATIVE = RELATION.RELATIVE
GLOBAL_DISTILL = RELATION.GLOBAL_DISTILL
DISTILL = RELATION.DISTILL
GLOBAL = RELATION.GLOBAL
MLP = RELATION.MLP
TRAINER = RELATION.TRAINER


@dataclass
class UtilityPage:
    source: object
    relative: object
    features: np.ndarray
    roots: list[list[int]]
    kinds: list[str]
    precision: np.ndarray
    recall: np.ndarray
    f1: np.ndarray
    teacher_floor: float
    teacher_available: bool
    conditional_human: bool


class UtilityModel(torch.nn.Module):
    def __init__(self, dimensions: int, width: int):
        super().__init__()
        self.trunk = torch.nn.Sequential(
            torch.nn.Linear(dimensions, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, width),
            torch.nn.Tanh(),
        )
        self.precision = torch.nn.Linear(width, 1)
        self.recall = torch.nn.Linear(width, 1)
        self.beats_teacher = torch.nn.Linear(width, 1)
        self.empty = torch.nn.Sequential(
            torch.nn.Linear(dimensions * 2, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )

    def forward(self, values: torch.Tensor):
        state = self.trunk(values)
        precision = torch.sigmoid(self.precision(state).squeeze(1))
        recall = torch.sigmoid(self.recall(state).squeeze(1))
        teacher = self.beats_teacher(state).squeeze(1)
        if len(values):
            pooled = torch.cat((values.mean(dim=0), values.max(dim=0).values))
        else:
            pooled = torch.zeros(self.empty[0].in_features, dtype=torch.float32)
        return precision, recall, teacher, self.empty(pooled).squeeze()


def quality_from_totals(
    selected: float,
    matched: float,
    gold: float,
) -> tuple[float, float, float]:
    precision = matched / selected if selected else 0.0
    recall = matched / gold if gold else 0.0
    f1 = (
        2.0 * precision * recall / (precision + recall)
        if precision + recall else 0.0
    )
    return precision, recall, f1


def best_teacher_floor(source) -> tuple[float, bool]:
    if source is None or source.item.page.status != "extract":
        return 0.0, False
    values = []
    if source.product_available:
        values.append(float(source.product_f1))
    values.extend(float(teacher.quality) for teacher in source.ensemble_teachers)
    return (max(values), True) if values else (0.0, False)


def ordinary_relative_feature(relative) -> np.ndarray:
    row = ACTION.synthetic_action_feature(
        relative.action.choice, relative.action.baseline, "ordinary"
    )
    # Ordinary is exactly the reference state: all difference features and
    # changed-token measures are zero, and only relationSame is active.
    result = np.concatenate((
        row,
        np.zeros(len(RELATION.DIFFERENCE_FEATURES), dtype=np.float64),
        np.asarray([0.0, 0.0, 0.0, 0.0, 1.0], dtype=np.float64),
        np.zeros(3, dtype=np.float64),
    ))
    if len(result) != len(RELATION.RELATION_FEATURE_NAMES):
        raise ValueError("ordinary action feature width differs from root actions")
    return result


def build_utility_page(root_teacher_page, *, use_legacy_teacher: bool) -> UtilityPage:
    relative = RELATION.build_relative_page(
        root_teacher_page, use_product_floor=False
    )
    source = relative.action.source
    features = []
    roots = []
    kinds = []
    values = []
    gold_tokens = float(source.tokens[source.gold_keep].sum())
    if relative.action.baseline.available:
        features.append(ordinary_relative_feature(relative))
        roots.append(list(relative.action.baseline.roots))
        kinds.append("ordinary")
        baseline_mask = relative.action.baseline.mask
        values.append(quality_from_totals(
            float(source.tokens[baseline_mask].sum()),
            float(source.tokens[baseline_mask & source.gold_keep].sum()),
            gold_tokens,
        ))
    for offset, action_offset in enumerate(relative.root_offsets):
        root = int(relative.action.roots[int(action_offset)])
        features.append(relative.features[offset])
        roots.append([root])
        kinds.append(relative.kinds[offset])
        values.append(quality_from_totals(
            float(relative.action.choice.root_page.kept_tokens[root]),
            float(relative.action.choice.root_page.kept_gold_tokens[root]),
            gold_tokens,
        ))
    if source.status == "exclude":
        values = [(0.0, 0.0, 0.0) for _ in values]
    teacher_floor, teacher_available = best_teacher_floor(root_teacher_page.source)
    if not use_legacy_teacher:
        teacher_floor, teacher_available = 0.0, False
    return UtilityPage(
        source=root_teacher_page.source,
        relative=relative,
        features=np.asarray(features, dtype=np.float64).reshape(
            (-1, len(RELATION.RELATION_FEATURE_NAMES))
        ),
        roots=roots,
        kinds=kinds,
        precision=np.asarray([value[0] for value in values]),
        recall=np.asarray([value[1] for value in values]),
        f1=np.asarray([value[2] for value in values]),
        teacher_floor=teacher_floor,
        teacher_available=teacher_available,
        conditional_human=bool(root_teacher_page.conditional_human),
    )


def sampled_offsets(page: UtilityPage, maximum: int) -> np.ndarray:
    count = len(page.features)
    if count <= maximum:
        return np.arange(count, dtype=np.int64)
    energy_index = ACTION.ACTION_FEATURE_NAMES.index("currentEnergyBelowPageBest")
    energy = page.features[:, energy_index]
    per_bucket = max(1, maximum // 4)
    selected = np.unique(np.concatenate((
        np.argsort(page.f1)[-per_bucket:],
        np.argsort(energy)[-per_bucket:],
        np.argsort(page.precision)[-per_bucket:],
        np.linspace(0, count - 1, per_bucket, dtype=np.int64),
    )))
    if len(selected) < maximum:
        missing = np.setdiff1d(np.arange(count), selected)
        selected = np.concatenate((selected, missing[:maximum - len(selected)]))
    return np.sort(selected[:maximum])


def fit_scaling(pages, maximum: int):
    matrices = [
        page.features[sampled_offsets(page, maximum)]
        for page in pages if len(page.features)
    ]
    matrix = np.concatenate(matrices) if matrices else np.zeros((1, len(RELATION.RELATION_FEATURE_NAMES)))
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return RELATION.Scaling(mean, scale)


def tensors(page: UtilityPage, scaling) -> torch.Tensor:
    return torch.as_tensor(
        np.clip((page.features - scaling.mean) / scaling.scale, -8.0, 8.0),
        dtype=torch.float32,
    )


def quantile_loss(target, predicted, quantile):
    error = target - predicted
    return torch.maximum(quantile * error, (quantile - 1.0) * error)


def page_loss(model, page: UtilityPage, scaling, args):
    if not len(page.features):
        return torch.zeros((), dtype=torch.float32)
    offsets = sampled_offsets(page, args.maximum_roots_per_page)
    predicted_p, predicted_r, teacher_logit, empty_logit = model(
        tensors(page, scaling)[offsets]
    )
    target_p = torch.as_tensor(page.precision[offsets], dtype=torch.float32)
    target_r = torch.as_tensor(page.recall[offsets], dtype=torch.float32)
    target_f1 = torch.as_tensor(page.f1[offsets], dtype=torch.float32)
    weights = args.action_floor_weight + target_f1
    content = (
        quantile_loss(target_p, predicted_p, args.quality_quantile)
        + quantile_loss(target_r, predicted_r, args.quality_quantile)
    )
    loss = torch.sum(weights * content) / torch.sum(weights)
    if page.teacher_available:
        beats = (target_f1 >= page.teacher_floor - args.teacher_tolerance).float()
        teacher = functional.binary_cross_entropy_with_logits(
            teacher_logit, beats, reduction="none"
        )
        loss = loss + args.teacher_loss_weight * torch.sum(weights * teacher) / torch.sum(weights)
    if not page.conditional_human:
        empty_target = torch.as_tensor(
            float(page.relative.action.source.status == "exclude"), dtype=torch.float32
        )
        loss = loss + args.empty_loss_weight * functional.binary_cross_entropy_with_logits(
            empty_logit, empty_target
        )
    return loss


def train_model(zh, wcxb, wmb, args, seed):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling([*zh, *wcxb, *wmb], args.scaling_roots_per_page)
    model = UtilityModel(len(RELATION.RELATION_FEATURE_NAMES), args.hidden_width)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    raw = np.asarray([
        args.exclude_weight if page.relative.action.source.status == "exclude" else 1.0
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


def predicted_scores(model, page, scaling, args):
    with torch.no_grad():
        precision, recall, teacher_logit, empty_logit = model(tensors(page, scaling))
    precision = precision.numpy()
    recall = recall.numpy()
    conservative_f1 = np.divide(
        2.0 * precision * recall,
        precision + recall,
        out=np.zeros_like(precision),
        where=(precision + recall) > 0,
    )
    teacher_probability = torch.sigmoid(teacher_logit).numpy()
    score = conservative_f1 - args.teacher_risk_penalty * (1.0 - teacher_probability)
    return score, conservative_f1, teacher_probability, float(torch.sigmoid(empty_logit))


def evaluate(page: UtilityPage, model, scaling, args):
    source = page.relative.action.source
    if len(page.features):
        scores, lower_f1, teacher_probability, empty_probability = predicted_scores(
            model, page, scaling, args
        )
        action = int(np.argmax(scores))
        choose_empty = empty_probability >= max(0.5, float(lower_f1[action]))
    else:
        scores = lower_f1 = teacher_probability = np.zeros(0)
        empty_probability = 1.0
        action = -1
        choose_empty = True
    if choose_empty:
        mask = np.zeros(len(source.tokens), dtype=bool)
        roots = []
        kind = "empty"
        available = False
    else:
        roots = page.roots[action]
        kind = page.kinds[action]
        mask = (
            page.relative.action.baseline.mask.copy()
            if kind == "ordinary"
            else GLOBAL.reconstruct(
                page.relative.action.choice.root_page, int(roots[0])
            )
        )
        available = int(source.tokens[mask].sum()) >= TRAINER.MIN_RETAINED_TOKENS
    baseline = page.relative.action.baseline
    baseline_text = TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.source.product_f1 if source.status == "extract" else 0.0
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
        "predictedUtility": 1.0 if choose_empty else float(scores[action]),
        "predictedContentF1LowerBound": 0.0 if choose_empty else float(lower_f1[action]),
        "predictedTeacherProbability": 0.0 if choose_empty else float(teacher_probability[action]),
        "predictedEmptyProbability": empty_probability,
        "teacherFloor": page.teacher_floor,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.source.product_available,
        "teacherKey": None,
        "teacherSourceQuality": 0.0,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=24)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--empty-loss-weight", type=float, default=1.0)
    parser.add_argument("--action-floor-weight", type=float, default=0.10)
    parser.add_argument("--quality-quantile", type=float, default=0.10)
    parser.add_argument("--teacher-loss-weight", type=float, default=0.25)
    parser.add_argument("--teacher-risk-penalty", type=float, default=0.25)
    parser.add_argument("--teacher-tolerance", type=float, default=0.01)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--maximum-roots-per-page", type=int, default=128)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
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
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        train_pages = [build_utility_page(
            GLOBAL_DISTILL.build_page(item, beta, "human", args),
            use_legacy_teacher=True,
        ) for item in train]
        test_pages = [build_utility_page(
            GLOBAL_DISTILL.build_page(item, beta, "human", args),
            use_legacy_teacher=True,
        ) for item in test]
        wcxb_pages = [build_utility_page(
            GLOBAL_DISTILL.build_wcxb_page(item, beta, args),
            use_legacy_teacher=False,
        ) for item in wcxb_train]
        wmb_pages = [build_utility_page(
            RELATIVE.build_wmb_page(item, beta, args),
            use_legacy_teacher=False,
        ) for item in wmb_train]
        model, scaling, history = train_model(
            train_pages, wcxb_pages, wmb_pages, args, 17000 + fold
        )
        fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        summary = GLOBAL_DISTILL.summary(fold_rows)
        folds.append({
            "fold": fold,
            "summary": summary,
            "history": history,
            "model": MLP.serialized_model(model),
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "localBeta": beta.tolist(),
        })
        print(json.dumps({"fold": fold, "summary": summary}, ensure_ascii=False), flush=True)
    summary = GLOBAL_DISTILL.summary(rows)
    report = {
        "schema": "qingzhou.tree-dp-utility-model-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeActions": ["ordinary", "rescue", "expand", "carve", "replace", "empty"],
            "predictedUtility": "lower-quantile-precision-and-recall-with-training-only-legacy-risk-head",
            "legacyCandidateUsage": "training-loss-only",
            "readabilityUsage": "generic DOM features only; no runtime candidate",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "inferenceComplexity": "O(N*hiddenWidth)",
            "featureNames": RELATION.RELATION_FEATURE_NAMES,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "relativeActionStudySha256": TRAINER.sha256_file(RELATION_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
