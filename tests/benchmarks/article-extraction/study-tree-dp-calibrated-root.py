#!/usr/bin/env python3
"""Calibrated expected-utility root competition for a single Tree-DP model.

The earlier root models learn only a ranking residual around the shipped root
energy.  That makes deep but correct roots unreachable, while weakening the
prior makes uncalibrated rankings unsafe.  Here every legal root predicts its
absolute expected text quality and a page head predicts the utility of the
empty answer.  ``empty ∪ roots`` then compete directly by predicted utility.

The model is page-conditioned and permutation-equivariant.  Inference remains
one block scorer, one O(N * hidden_width) root model and one Tree-DP decode;
Readability/legacy candidates are training-only exact teachers.
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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


GLOBAL_DISTILL_PATH = HERE / "study-tree-dp-global-distillation.py"
GLOBAL_DISTILL = load_module("qingzhou_calibrated_root_data", GLOBAL_DISTILL_PATH)
DISTILL = GLOBAL_DISTILL.DISTILL
MLP = GLOBAL_DISTILL.MLP
GLOBAL = MLP.GLOBAL
TRAINER = DISTILL.TRAINER


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


class CalibratedRootUtility(torch.nn.Module):
    def __init__(self, dimensions: int, width: int):
        super().__init__()
        self.root_encoder = torch.nn.Linear(dimensions, width)
        self.root_head = torch.nn.Sequential(
            torch.nn.Linear(3 * width, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        self.empty_head = torch.nn.Sequential(
            torch.nn.Linear(2 * width, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )

    def forward(self, features: torch.Tensor):
        hidden = torch.tanh(self.root_encoder(features))
        mean = torch.mean(hidden, dim=0, keepdim=True)
        maximum = torch.max(hidden, dim=0, keepdim=True).values
        root_context = torch.cat([
            hidden,
            hidden - mean,
            maximum - hidden,
        ], dim=1)
        root_logits = self.root_head(root_context).squeeze(-1)
        empty_logit = self.empty_head(torch.cat([mean, maximum], dim=1)).squeeze()
        return root_logits, empty_logit


def page_feature_matrix(choice) -> np.ndarray:
    # Unlike the old bounded prior, current energy is now ordinary evidence.
    # The model may use it, but it cannot make another root unreachable.
    return np.column_stack([choice.features, choice.energy_offset]).astype(np.float64)


def fit_scaling(pages, maximum: int) -> Scaling:
    rows = []
    for page in pages:
        choice = page.choice
        count = len(choice.indices)
        if not count:
            continue
        if count <= maximum:
            offsets = np.arange(count)
        else:
            third = maximum // 3
            offsets = np.unique(np.concatenate([
                np.argsort(choice.current_energy[choice.indices])[-third:],
                np.argsort(choice.quality)[-third:],
                np.linspace(0, count - 1, maximum - 2 * third, dtype=int),
            ]))
        rows.append(page_feature_matrix(choice)[offsets])
    if not rows:
        raise ValueError("no legal root features")
    matrix = np.concatenate(rows)
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def tensors(page, scaling: Scaling):
    matrix = page_feature_matrix(page.choice)
    normalized = np.clip((matrix - scaling.mean) / scaling.scale, -8.0, 8.0)
    return torch.as_tensor(normalized, dtype=torch.float32)


def calibrated_page_loss(model, page, scaling, kind: str, args):
    choice = page.choice
    if not len(choice.indices):
        # With no legal root the output is structurally forced to be empty.
        return torch.zeros((), dtype=torch.float32)
    root_logits, empty_logit = model(tensors(page, scaling))
    human = torch.as_tensor(choice.quality, dtype=torch.float32)
    weights = args.root_floor_weight + human
    if args.objective == "quantile":
        predicted = torch.sigmoid(root_logits)
        error = human - predicted
        point_loss = torch.maximum(
            args.root_quantile * error,
            (args.root_quantile - 1.0) * error,
        )
        root_loss = torch.sum(weights * point_loss) / torch.sum(weights)
    else:
        root_loss = torch.sum(
            weights * functional.binary_cross_entropy_with_logits(
                root_logits, human, reduction="none"
            )
        ) / torch.sum(weights)
    empty_target = torch.as_tensor(
        1.0 if choice.root_page.item.page.status == "exclude" else 0.0,
        dtype=torch.float32,
    )
    empty_loss = functional.binary_cross_entropy_with_logits(empty_logit, empty_target)
    # Extractability is a separate page-level question.  Even for a
    # conservative root quantile, a low absolute lower bound must not by
    # itself turn an otherwise extractable page into an empty answer.
    loss = root_loss + args.empty_loss_weight * empty_loss

    if kind != "human" and page.teacher_quality is not None:
        teacher = torch.as_tensor(page.teacher_quality, dtype=torch.float32)
        teacher_weights = args.root_floor_weight + teacher
        if args.objective == "quantile":
            predicted = torch.sigmoid(root_logits)
            error = teacher - predicted
            point_loss = torch.maximum(
                args.root_quantile * error,
                (args.root_quantile - 1.0) * error,
            )
            teacher_loss = torch.sum(teacher_weights * point_loss) / torch.sum(
                teacher_weights
            )
        else:
            teacher_loss = torch.sum(
                teacher_weights * functional.binary_cross_entropy_with_logits(
                    root_logits, teacher, reduction="none"
                )
            ) / torch.sum(teacher_weights)
        loss = loss + (
            args.root_teacher_weight
            * page.teacher_source_quality
            * teacher_loss
        )
    return loss


def train_model(pages, wcxb_pages, kind: str, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling([*pages, *wcxb_pages], args.scaling_roots_per_page)
    model = CalibratedRootUtility(
        len(GLOBAL.CHOICE_FEATURE_NAMES) + 1,
        args.hidden_width,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    raw = np.asarray([
        args.exclude_weight
        if page.choice.root_page.item.page.status == "exclude"
        else 1.0
        for page in pages
    ], dtype=np.float64)
    weighted = [
        (page, float(weight) / max(1e-12, float(raw.sum())))
        for page, weight in zip(pages, raw, strict=True)
    ] + [
        (page, args.wcxb_corpus_weight / max(1, len(wcxb_pages)))
        for page in wcxb_pages
    ]
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        count = 0
        epoch_loss = 0.0
        for page, weight in weighted:
            loss = weight * calibrated_page_loss(
                model, page, scaling, kind, args
            )
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


def evaluate(page, model, scaling, args):
    choice = page.choice
    source = choice.root_page.item.page
    baseline = GLOBAL.ROOT_QUALITY.decode(
        choice.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    if len(choice.indices):
        with torch.no_grad():
            root_logits, empty_logit = model(tensors(page, scaling))
            root_utilities = torch.sigmoid(root_logits).numpy()
            empty_utility = float(torch.sigmoid(empty_logit))
        offset = int(np.argmax(root_utilities))
        root = int(choice.indices[offset])
        if float(root_utilities[offset]) <= empty_utility:
            root = None
            offset = None
    else:
        root_utilities = np.zeros(0, dtype=np.float64)
        empty_utility = 1.0
        root = None
        offset = None
    mask = (
        GLOBAL.reconstruct(choice.root_page, root)
        if root is not None
        else np.zeros(len(source.tokens), dtype=bool)
    )
    retained_tokens = int(source.tokens[mask].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        mask[:] = False
        root = None
        offset = None
        retained_tokens = 0
    baseline_text = (
        TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    )
    candidate_text = (
        TRAINER.materialized_text(source, mask) if available else ""
    )
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
    product = page.source.product_f1 if page.source is not None and source.status == "extract" else 0.0
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
        "predictedRootUtility": (
            float(root_utilities[offset]) if offset is not None else 0.0
        ),
        "predictedEmptyUtility": empty_utility,
        "candidateMaskQuality": (
            float(choice.quality[offset]) if offset is not None else 0.0
        ),
        "bestMaskQuality": choice.best_quality,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.source.product_available if page.source is not None else False,
        "teacherKey": page.teacher_key,
        "teacherSourceQuality": page.teacher_source_quality,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
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
    parser.add_argument("--objective", choices=("mean", "quantile"), default="mean")
    parser.add_argument("--root-quantile", type=float, default=0.10)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--local-teacher-weight", type=float, default=0.15)
    parser.add_argument("--root-teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--variants", default="human,ensemble")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.teacher_weight = args.local_teacher_weight
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    kinds = tuple(x.strip() for x in args.variants.split(",") if x.strip())
    if not kinds or any(x not in {"human", "product", "ensemble"} for x in kinds):
        raise ValueError(f"invalid variants: {args.variants}")
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    rows = {kind: [] for kind in kinds}
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        fold_report = {"fold": fold, "localBeta": beta.tolist(), "variants": {}}
        for kind in kinds:
            train_pages = [
                GLOBAL_DISTILL.build_page(item, beta, kind, args) for item in train
            ]
            test_pages = [
                GLOBAL_DISTILL.build_page(item, beta, kind, args) for item in test
            ]
            wcxb_pages = [
                GLOBAL_DISTILL.build_wcxb_page(item, beta, args) for item in wcxb_train
            ]
            model, scaling, history = train_model(
                train_pages, wcxb_pages, kind, args, 11000 + 10 * fold
            )
            fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
            rows[kind].extend(fold_rows)
            fold_report["variants"][kind] = {
                "summary": GLOBAL_DISTILL.summary(fold_rows),
                "history": history,
                "model": MLP.serialized_model(model),
                "scalingMean": scaling.mean.tolist(),
                "scalingScale": scaling.scale.tolist(),
            }
        folds.append(fold_report)
        print(json.dumps({
            "fold": fold,
            "summaries": {
                kind: fold_report["variants"][kind]["summary"] for kind in kinds
            },
        }, ensure_ascii=False), flush=True)

    summaries = {kind: GLOBAL_DISTILL.summary(value) for kind, value in rows.items()}
    report = {
        "schema": "qingzhou.tree-dp-calibrated-root-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-rich-linear-block-scorer-plus-contextual-calibrated-root-utility-plus-tree-dp",
            "decision": (
                "argmax-over-learned-empty-and-root-quality-lower-quantiles"
                if args.objective == "quantile"
                else "argmax-over-learned-empty-and-root-expected-utilities"
            ),
            "currentRootEnergy": "ordinary-input-feature-not-privileged-prior",
            "candidateMasks": "training-only-exact-utility-auxiliary-loss",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "inferenceComplexity": "O(N*hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {
            "variants": {
                kind: {"summary": summaries[kind], "rows": rows[kind]}
                for kind in kinds
            },
            "folds": folds,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "globalDistillationStudySha256": TRAINER.sha256_file(GLOBAL_DISTILL_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(args.output), "summaries": summaries}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
