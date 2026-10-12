#!/usr/bin/env python3
"""Risk-aware relative actions for one self-contained Tree-DP extractor.

The ordinary shipped Tree-DP forest is the zero-utility reference action.  A
single compact model scores every legal alternative root as one of four
observable DOM transitions: rescue an empty forest, expand it, carve it, or
replace it.  Readability contributes only generic training features (class/id,
paragraph evidence, link density, scope and candidate shape); no Readability
candidate is constructed at inference time.

For Chinese training pages, the loss uses the current product's human-gold F1
as a training-only floor.  This is legacy distillation, not a serving feature:
an alternative root receives positive target gain only when it beats both the
ordinary Tree-DP forest and the incumbent product.  Chinese validation/test and
multilingual holdouts are refused by construction.
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
ACTION_PATH = HERE / "study-tree-dp-action-ranker.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_relative_action_base", ACTION_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {ACTION_PATH}")
ACTION = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ACTION
SPEC.loader.exec_module(ACTION)
RELATIVE = ACTION.RELATIVE
CALIBRATED = RELATIVE.CALIBRATED
GLOBAL_DISTILL = ACTION.GLOBAL_DISTILL
DISTILL = ACTION.DISTILL
GLOBAL = ACTION.GLOBAL
MLP = RELATIVE.MLP
TRAINER = ACTION.TRAINER


DIFFERENCE_FEATURES = [
    "readabilityParagraphEvidenceLog",
    "readabilityClassWeight",
    "readabilityLinkFactor",
    "readabilityRawScore",
    "readabilityLinkAdjustedScore",
    "readabilityPrimaryScope",
    "readabilityPrimaryScopeScore",
    "readabilityPositiveMassCoverage",
    "retainedAnchorShare",
    "retainedBoilerplateShare",
    "retainedContentShare",
    "rootReadabilityPositiveHits",
    "rootReadabilityNegativeHits",
    "rootReadabilityOkMaybe",
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
    "retainedRepeatedMeanLog",
    "keptSubtreeTokenShare",
    "documentPosition",
    "documentCentrality",
    "rootDecisionMarginPerToken",
]
DIFFERENCE_INDICES = [
    ACTION.ACTION_FEATURE_NAMES.index(name) for name in DIFFERENCE_FEATURES
]
RELATION_FEATURE_NAMES = [
    *ACTION.ACTION_FEATURE_NAMES,
    *(f"delta.{name}" for name in DIFFERENCE_FEATURES),
    "relationRescue",
    "relationExpand",
    "relationCarve",
    "relationReplace",
    "relationSame",
    "addedPageTokenShare",
    "droppedOrdinaryTokenShare",
    "changedTokenJaccard",
]


@dataclass
class RelativePage:
    source: object
    action: object
    root_offsets: np.ndarray
    features: np.ndarray
    targets: np.ndarray
    kinds: list[str]
    teacher_floor: float
    conditional_human: bool


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


class RelativeActionUtility(torch.nn.Module):
    def __init__(self, dimensions: int, width: int):
        super().__init__()
        self.root = torch.nn.Sequential(
            torch.nn.Linear(dimensions, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        self.empty = torch.nn.Sequential(
            torch.nn.Linear(dimensions * 2, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )

    def forward(self, values: torch.Tensor):
        root = self.root(values).squeeze(1)
        if len(values):
            pooled = torch.cat((values.mean(dim=0), values.max(dim=0).values))
        else:
            pooled = torch.zeros(
                self.empty[0].in_features, dtype=torch.float32
            )
        return root, self.empty(pooled).squeeze()


def relation_kind(recall: float, precision: float, baseline_available: bool) -> str:
    if not baseline_available:
        return "rescue"
    full_recall = recall >= 1.0 - 1e-12
    full_precision = precision >= 1.0 - 1e-12
    if full_recall and full_precision:
        return "same"
    if full_recall:
        return "expand"
    if full_precision:
        return "carve"
    return "replace"


def build_relative_page(root_teacher_page, *, use_product_floor: bool) -> RelativePage:
    source = root_teacher_page.source
    action = ACTION.build_action_page(root_teacher_page)
    root_offsets = np.flatnonzero(np.asarray(action.kinds) == "root")
    baseline_available = bool(action.baseline.available)
    ordinary_feature = ACTION.synthetic_action_feature(
        action.choice, action.baseline, "ordinary"
    )
    baseline_quality = ACTION.ordinary_quality(action.choice, action.baseline)
    product_f1 = (
        float(source.product_f1)
        if source is not None
        and source.item.page.status == "extract"
        and source.product_available
        else 0.0
    )
    teacher_floor = max(
        baseline_quality,
        product_f1 if use_product_floor else 0.0,
    )

    page_tokens = max(1.0, float(action.source.tokens.sum()))
    ordinary_tokens = max(1.0, float(action.baseline.retained_tokens))
    rows = []
    targets = []
    kinds = []
    for offset in root_offsets:
        row = action.features[offset].copy()
        recall = float(row[len(GLOBAL.CHOICE_FEATURE_NAMES) + 6])
        precision = float(row[len(GLOBAL.CHOICE_FEATURE_NAMES) + 7])
        candidate_tokens = max(1.0, float(action.choice.root_page.kept_tokens[
            int(action.roots[offset])
        ]))
        intersection = recall * ordinary_tokens if baseline_available else 0.0
        added = max(0.0, candidate_tokens - intersection)
        dropped = max(0.0, ordinary_tokens - intersection) if baseline_available else 0.0
        union = max(1.0, candidate_tokens + ordinary_tokens - intersection)
        kind = relation_kind(recall, precision, baseline_available)
        one_hot = [float(kind == value) for value in (
            "rescue", "expand", "carve", "replace", "same"
        )]
        rows.append(np.concatenate((
            row,
            row[DIFFERENCE_INDICES] - ordinary_feature[DIFFERENCE_INDICES],
            np.asarray(one_hot, dtype=np.float64),
            np.asarray([
                added / page_tokens,
                dropped / ordinary_tokens if baseline_available else 0.0,
                1.0 - intersection / union,
            ], dtype=np.float64),
        )))
        if action.source.status == "exclude":
            targets.append(-1.0)
        else:
            targets.append(float(action.quality[offset]) - teacher_floor)
        kinds.append(kind)
    return RelativePage(
        source=source,
        action=action,
        root_offsets=root_offsets,
        features=np.asarray(rows, dtype=np.float64).reshape(
            (-1, len(RELATION_FEATURE_NAMES))
        ),
        targets=np.asarray(targets, dtype=np.float64),
        kinds=kinds,
        teacher_floor=teacher_floor,
        conditional_human=bool(root_teacher_page.conditional_human),
    )


def sampled_offsets(page: RelativePage, maximum: int) -> np.ndarray:
    if len(page.targets) <= maximum:
        return np.arange(len(page.targets), dtype=np.int64)
    energy = page.features[:, ACTION.ACTION_FEATURE_NAMES.index(
        "currentEnergyBelowPageBest"
    )]
    candidate_tokens = page.action.choice.root_page.kept_tokens[
        np.asarray([page.action.roots[offset] for offset in page.root_offsets])
    ]
    per_bucket = max(1, maximum // 4)
    selected = np.unique(np.concatenate((
        np.argsort(page.targets)[-per_bucket:],
        np.argsort(energy)[-per_bucket:],
        np.argsort(candidate_tokens)[-per_bucket:],
        np.linspace(0, len(page.targets) - 1, per_bucket, dtype=np.int64),
    )))
    if len(selected) < maximum:
        missing = np.setdiff1d(np.arange(len(page.targets)), selected)
        selected = np.concatenate((selected, missing[:maximum - len(selected)]))
    return np.sort(selected[:maximum])


def fit_scaling(pages, maximum: int) -> Scaling:
    values = [page.features[sampled_offsets(page, maximum)] for page in pages if len(page.features)]
    matrix = np.concatenate(values) if values else np.zeros((1, len(RELATION_FEATURE_NAMES)))
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def tensors(page: RelativePage, scaling: Scaling) -> torch.Tensor:
    return torch.as_tensor(
        (page.features - scaling.mean) / scaling.scale,
        dtype=torch.float32,
    )


def page_loss(model, page: RelativePage, scaling: Scaling, args):
    if not len(page.targets):
        return torch.zeros((), dtype=torch.float32)
    indices = sampled_offsets(page, args.maximum_roots_per_page)
    values = tensors(page, scaling)[indices]
    predicted, empty_logit = model(values)
    predicted = torch.tanh(predicted)
    target = torch.as_tensor(page.targets[indices], dtype=torch.float32)
    error = target - predicted
    point = torch.maximum(
        args.gain_quantile * error,
        (args.gain_quantile - 1.0) * error,
    )
    weights = args.root_floor_weight + torch.abs(target) + torch.clamp(target, min=0)
    root_loss = torch.sum(point * weights) / torch.sum(weights)
    if page.conditional_human:
        empty_loss = torch.zeros((), dtype=torch.float32)
    else:
        empty_target = torch.as_tensor(
            float(page.action.source.status == "exclude"), dtype=torch.float32
        )
        empty_loss = functional.binary_cross_entropy_with_logits(
            empty_logit, empty_target
        )
    return root_loss + args.empty_loss_weight * empty_loss


def train_model(zh, wcxb, wmb, args, seed):
    torch.manual_seed(seed)
    random.seed(seed)
    all_pages = [*zh, *wcxb, *wmb]
    scaling = fit_scaling(all_pages, args.scaling_roots_per_page)
    model = RelativeActionUtility(len(RELATION_FEATURE_NAMES), args.hidden_width)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    raw = np.asarray([
        args.exclude_weight if page.action.source.status == "exclude" else 1.0
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


def evaluate(page: RelativePage, model, scaling):
    action = page.action
    baseline = action.baseline
    source = action.source
    selected = None
    predicted_gain = 0.0
    predicted_empty = 1.0
    if len(page.features):
        with torch.no_grad():
            gains, empty_logit = model(tensors(page, scaling))
            gains = torch.tanh(gains).numpy()
            predicted_empty = float(torch.sigmoid(empty_logit))
        offset = int(np.argmax(gains))
        if gains[offset] > 0 and (baseline.available or predicted_empty < 0.5):
            selected = offset
            predicted_gain = float(gains[offset])
    if selected is None:
        mask = baseline.mask.copy()
        roots = baseline.roots
        available = baseline.available
        kind = "ordinary" if available else "empty"
    else:
        action_offset = int(page.root_offsets[selected])
        root = int(action.roots[action_offset])
        mask = GLOBAL.reconstruct(action.choice.root_page, root)
        roots = [root]
        available = int(source.tokens[mask].sum()) >= TRAINER.MIN_RETAINED_TOKENS
        kind = page.kinds[selected]
        if not available:
            mask = baseline.mask.copy()
            roots = baseline.roots
            available = baseline.available
            kind = "ordinary" if available else "empty"
            selected = None
            predicted_gain = 0.0
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
        "predictedGainLowerBound": predicted_gain,
        "predictedEmptyProbability": predicted_empty,
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
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--empty-loss-weight", type=float, default=1.0)
    parser.add_argument("--root-floor-weight", type=float, default=0.10)
    parser.add_argument("--gain-quantile", type=float, default=0.10)
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
        train_pages = [build_relative_page(
            GLOBAL_DISTILL.build_page(item, beta, "human", args),
            use_product_floor=True,
        ) for item in train]
        test_pages = [build_relative_page(
            GLOBAL_DISTILL.build_page(item, beta, "human", args),
            use_product_floor=True,
        ) for item in test]
        wcxb_pages = [build_relative_page(
            GLOBAL_DISTILL.build_wcxb_page(item, beta, args),
            use_product_floor=False,
        ) for item in wcxb_train]
        wmb_pages = [build_relative_page(
            RELATIVE.build_wmb_page(item, beta, args),
            use_product_floor=False,
        ) for item in wmb_train]
        model, scaling, history = train_model(
            train_pages, wcxb_pages, wmb_pages, args, 15000 + fold
        )
        fold_rows = [evaluate(page, model, scaling) for page in test_pages]
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
        "schema": "qingzhou.tree-dp-relative-action-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeActions": ["ordinary", "rescue", "expand", "carve", "replace"],
            "trainingOnlyLegacyFloor": True,
            "readabilityUsage": "generic DOM features only; no runtime candidate",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "inferenceComplexity": "O(N*hiddenWidth)",
            "featureNames": RELATION_FEATURE_NAMES,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "actionStudySha256": TRAINER.sha256_file(ACTION_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
