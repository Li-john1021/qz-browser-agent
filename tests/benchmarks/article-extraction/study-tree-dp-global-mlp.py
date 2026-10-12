#!/usr/bin/env python3
"""Page-normalized nonlinear root energy for a single Tree-DP model.

Unlike an independent root regressor, this model is trained on a whole page:
all legal roots and the empty answer share one partition function.  Near-equal
human-compatible roots form a latent gold set, so arbitrary zero-text wrapper
boundaries are not supervised.  A bounded nonlinear residual sits around the
shipped DP energy; inference is still a single model and O(N * hidden_width).

This is a benchmark capacity study.  It intentionally has no runtime
Readability candidate and no site, URL, page type, timing, or gold feature.
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
SPEC = importlib.util.spec_from_file_location("qingzhou_global_choice_mlp", GLOBAL_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {GLOBAL_PATH}")
GLOBAL = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GLOBAL
SPEC.loader.exec_module(GLOBAL)
READABILITY = GLOBAL.READABILITY
ROOT_QUALITY = GLOBAL.ROOT_QUALITY
TRAINER = GLOBAL.TRAINER


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


class RootEnergy(torch.nn.Module):
    def __init__(self, dimensions: int, width: int, residual_bound: float):
        super().__init__()
        self.residual_bound = residual_bound
        self.network = torch.nn.Sequential(
            torch.nn.Linear(dimensions, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        # Start as the exact fixed DP prior.  Training must earn every change.
        torch.nn.init.zeros_(self.network[-1].weight)
        torch.nn.init.zeros_(self.network[-1].bias)

    def forward(self, features: torch.Tensor, prior: torch.Tensor) -> torch.Tensor:
        raw = self.network(features).squeeze(-1)
        residual = self.residual_bound * torch.tanh(raw / self.residual_bound)
        return prior + residual


def sampled_features(pages, maximum: int) -> np.ndarray:
    rows = []
    for page in pages:
        count = len(page.indices)
        if not count:
            continue
        if count <= maximum:
            offsets = np.arange(count)
        else:
            offsets = np.unique(np.concatenate([
                np.argsort(page.current_energy[page.indices])[-maximum // 3 :],
                np.argsort(page.quality)[-maximum // 3 :],
                np.linspace(0, count - 1, maximum - 2 * (maximum // 3), dtype=int),
            ]))
        rows.append(page.features[offsets])
    if not rows:
        raise ValueError("no root features for scaling")
    return np.concatenate(rows)


def fit_scaling(pages, maximum: int) -> Scaling:
    matrix = sampled_features(pages, maximum)
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def tensors(page, scaling: Scaling, prior_scale: float):
    normalized = np.clip((page.features - scaling.mean) / scaling.scale, -8.0, 8.0)
    return (
        torch.as_tensor(normalized, dtype=torch.float32),
        torch.as_tensor(prior_scale * page.energy_offset, dtype=torch.float32),
        torch.as_tensor(page.quality, dtype=torch.float32),
    )


def page_loss(model, page, scaling, args) -> torch.Tensor:
    if not len(page.indices):
        # Empty is the only legal answer and therefore has zero NLL.
        return torch.zeros((), dtype=torch.float32)
    features, prior, quality = tensors(page, scaling, args.current_energy_prior)
    scores = model(features, prior)
    if page.target_offset is None:
        augmented = torch.logsumexp(scores + args.loss_margin, dim=0)
        return torch.logaddexp(torch.zeros_like(augmented), augmented)

    best = torch.max(quality)
    cost = args.loss_margin * (best - quality)
    roots = torch.logsumexp(scores + cost, dim=0)
    empty = args.loss_margin * best
    denominator = torch.logaddexp(empty, roots)
    compatible = quality >= best - args.gold_tolerance
    numerator = torch.logsumexp(scores[compatible], dim=0)
    return denominator - numerator


def train_model(zh_pages, wcxb_pages, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling([*zh_pages, *wcxb_pages], args.scaling_roots_per_page)
    model = RootEnergy(
        len(GLOBAL.CHOICE_FEATURE_NAMES),
        args.hidden_width,
        args.residual_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    zh_raw_weights = np.asarray([
        args.exclude_weight
        if page.root_page.item.page.status == "exclude"
        else 1.0
        for page in zh_pages
    ], dtype=np.float64)
    zh_denominator = max(1e-12, float(zh_raw_weights.sum()))
    weighted = [
        (page, float(weight) / zh_denominator)
        for page, weight in zip(zh_pages, zh_raw_weights, strict=True)
    ] + [
        (page, args.wcxb_corpus_weight / max(1, len(wcxb_pages)))
        for page in wcxb_pages
    ]
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch_loss = torch.zeros((), dtype=torch.float32)
        epoch_loss = 0.0
        batch_pages = 0
        for page, weight in weighted:
            loss = weight * page_loss(model, page, scaling, args)
            batch_loss = batch_loss + loss
            epoch_loss += float(loss.detach())
            batch_pages += 1
            if batch_pages == args.batch_pages:
                batch_loss.backward()
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                batch_loss = torch.zeros((), dtype=torch.float32)
                batch_pages = 0
        if batch_pages:
            batch_loss.backward()
            optimizer.step()
        history.append({"epoch": epoch, "loss": epoch_loss})
    return model, scaling, history


def page_row(page, model, scaling, args) -> dict:
    source = page.root_page.item.page
    baseline = ROOT_QUALITY.decode(
        page.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    if len(page.indices):
        features, prior, _ = tensors(page, scaling, args.current_energy_prior)
        with torch.no_grad():
            scores = model(features, prior).numpy()
        offset = int(np.argmax(scores)) if float(np.max(scores)) > 0 else None
    else:
        scores = np.zeros(0)
        offset = None
    root = int(page.indices[offset]) if offset is not None else None
    mask = (
        GLOBAL.reconstruct(page.root_page, root)
        if root is not None
        else np.zeros(len(source.tokens), dtype=bool)
    )
    retained_tokens = int(source.tokens[mask].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
    if not available:
        mask[:] = False
        root = None
        retained_tokens = 0
    baseline_text = TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(source, mask) if available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, source.reference)
    candidate_f1 = TRAINER.trigram_f1(candidate_text, source.reference)
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
        "choiceScore": float(scores[offset]) if offset is not None else 0.0,
        "candidateMaskQuality": (
            float(page.quality[offset]) if offset is not None else 0.0
        ),
        "bestMaskQuality": page.best_quality,
    }


def serialized_model(model: RootEnergy) -> dict:
    return {
        name: value.detach().numpy().tolist()
        for name, value in model.state_dict().items()
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=12)
    parser.add_argument("--residual-bound", type=float, default=2.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--current-energy-prior", type=float, default=4.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--readability-regularization", type=float, default=10.0)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
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
    indices = np.arange(len(pages))
    groups = np.asarray([item.page.site_family for item in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups),
        1,
    ):
        train_items = [pages[int(index)] for index in train_indices]
        test_items = [pages[int(index)] for index in test_indices]
        beta = READABILITY.fit_increment(
            train_items,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        train_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in train_items
        ]
        test_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in test_items
        ]
        wcxb_pages = [
            GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
            for item in wcxb_train
        ]
        model, scaling, history = train_model(train_pages, wcxb_pages, args, 1000 + fold)
        fold_rows = [page_row(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        summary = ROOT_QUALITY.summarize(fold_rows)
        folds.append({
            "fold": fold,
            "summary": summary,
            "readabilityBeta": beta.tolist(),
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "model": serialized_model(model),
            "history": history,
        })
        print(json.dumps({"fold": fold, "summary": summary, "history": history}, ensure_ascii=False), flush=True)

    summary = ROOT_QUALITY.summarize(rows)
    accepted = (
        summary["meanDelta"] > 0
        and summary["regressionsBelowMinusPointOne"] == 0
        and summary["candidateExcludeFalsePositives"]
        <= summary["baselineExcludeFalsePositives"]
    )
    final_model_report = None
    validation_report = None
    wcxb_report = None
    if accepted:
        final_beta = READABILITY.fit_increment(
            pages,
            wcxb_train,
            regularization=args.readability_regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        final_pages = [
            GLOBAL.build_choice_page(item, final_beta, args.scope_prior_weight)
            for item in pages
        ]
        final_wcxb = [
            GLOBAL.build_choice_page(item, final_beta, args.scope_prior_weight)
            for item in wcxb_train
        ]
        final_model, final_scaling, final_history = train_model(
            final_pages,
            final_wcxb,
            args,
            2000,
        )
        final_model_report = {
            "readabilityBeta": final_beta.tolist(),
            "scalingMean": final_scaling.mean.tolist(),
            "scalingScale": final_scaling.scale.tolist(),
            "model": serialized_model(final_model),
            "history": final_history,
        }
        if validation:
            validation_pages = [
                GLOBAL.build_choice_page(item, final_beta, args.scope_prior_weight)
                for item in validation
            ]
            validation_rows = [
                page_row(page, final_model, final_scaling, args)
                for page in validation_pages
            ]
            validation_report = {
                "summary": ROOT_QUALITY.summarize(validation_rows),
                "rows": validation_rows,
            }
        if wcxb_holdout:
            holdout_pages = [
                GLOBAL.build_choice_page(item, final_beta, args.scope_prior_weight)
                for item in wcxb_holdout
            ]
            holdout_rows = [
                page_row(page, final_model, final_scaling, args)
                for page in holdout_pages
            ]
            wcxb_report = {
                "summary": ROOT_QUALITY.summarize(holdout_rows),
                "rows": holdout_rows,
            }
    report = {
        "schema": "qingzhou.tree-dp-global-mlp-study.v1",
        "protocol": {
            "model": "page-normalized-bounded-nonlinear-residual-over-empty-and-legal-roots",
            "runtimeReadabilityCandidate": False,
            "featureNames": GLOBAL.CHOICE_FEATURE_NAMES,
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "goldRoot": "latent-set-within-mask-quality-tolerance",
            "pageWeighting": "one-page-unit-with-10x-human-exclude-cost",
            "inferenceComplexity": "O(N*hiddenWidth)",
            "zhValidationOpened": bool(validation_report),
            "zhValidationRole": "consumed-development-diagnostic",
            "zhTestOpened": False,
            "wcxbHoldoutOpened": bool(wcxb_report),
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "acceptedByOofGate": accepted,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "finalModel": final_model_report,
        "zhValidation": validation_report,
        "wcxbHoldout": wcxb_report,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "globalChoiceStudySha256": TRAINER.sha256_file(GLOBAL_PATH),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({
        "output": str(args.output),
        "acceptedByOofGate": accepted,
        "summary": summary,
        "validation": validation_report and validation_report["summary"],
        "wcxbHoldout": wcxb_report and wcxb_report["summary"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
