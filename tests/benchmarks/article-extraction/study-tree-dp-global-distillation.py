#!/usr/bin/env python3
"""Distill exact legacy answer masks into Tree-DP's page-global root loss.

The runtime model remains one local linear scorer plus one bounded root MLP and
one Tree-DP decode.  Legacy candidates are never generated at inference time.
Their exact source masks are used only as a low-weight auxiliary target during
site-family OOF training; human gold remains the primary loss.
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


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


DISTILL_PATH = HERE / "study-tree-dp-candidate-distillation.py"
MLP_PATH = HERE / "study-tree-dp-global-mlp.py"
DISTILL = load_module("qingzhou_global_distill_data", DISTILL_PATH)
MLP = load_module("qingzhou_global_distill_mlp", MLP_PATH)
TRAINER = DISTILL.TRAINER
GLOBAL = MLP.GLOBAL


@dataclass
class RootTeacherPage:
    source: object
    choice: object
    teacher_quality: np.ndarray | None
    teacher_source_quality: float
    teacher_key: str | None
    conditional_human: bool = False


def exact_teacher(item, kind: str):
    if kind == "human":
        return None
    if kind == "product":
        teacher = item.product_teacher
        return teacher if teacher is not None and teacher.exact else None
    exact = [teacher for teacher in item.ensemble_teachers if teacher.exact]
    return max(exact, key=lambda teacher: (teacher.quality, teacher.coverage, teacher.key)) if exact else None


def root_teacher_quality(choice, teacher) -> np.ndarray | None:
    if teacher is None:
        return None
    page = choice.root_page.item.page
    token_nodes = page.tokens > 0
    # An exact candidate can still miss a coordinate unit if materialization
    # transformed it.  Root supervision is fail-closed: partial masks remain
    # useful to the local positive-only study but never define global roots.
    if np.any(token_nodes & ~teacher.known):
        return None
    kept_teacher = page.tokens * teacher.keep
    retained_teacher = kept_teacher.copy()
    for index in range(len(page.tokens) - 1, -1, -1):
        for offset, child in enumerate(page.children[index]):
            if choice.root_page.keep_choice[index][offset]:
                retained_teacher[index] += retained_teacher[child]
    selected = choice.root_page.kept_tokens[choice.indices]
    matched = retained_teacher[choice.indices]
    total = float(kept_teacher.sum())
    if total <= 0:
        return None
    precision = np.divide(
        matched, selected, out=np.zeros_like(matched), where=selected > 0
    )
    recall = matched / total
    return np.divide(
        2 * precision * recall,
        precision + recall,
        out=np.zeros_like(precision),
        where=(precision + recall) > 0,
    )


def build_page(item, beta: np.ndarray, kind: str, args) -> RootTeacherPage:
    rich_item = DISTILL.READABILITY.StudyPage(
        page=item.item.page,
        context=item.rich_context,
        corpus="zh",
    )
    choice = GLOBAL.build_choice_page(rich_item, beta, args.scope_prior_weight)
    teacher = exact_teacher(item, kind)
    quality = root_teacher_quality(choice, teacher)
    return RootTeacherPage(
        source=item,
        choice=choice,
        teacher_quality=quality,
        teacher_source_quality=0.0 if quality is None else float(teacher.quality),
        teacher_key=None if quality is None else teacher.key,
    )


def build_wcxb_page(item, beta: np.ndarray, args) -> RootTeacherPage:
    choice = GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
    return RootTeacherPage(
        source=None,
        choice=choice,
        teacher_quality=None,
        teacher_source_quality=0.0,
        teacher_key=None,
    )


def quality_loss(model, choice, scaling, quality, args) -> torch.Tensor:
    if not len(choice.indices):
        return torch.zeros((), dtype=torch.float32)
    features, prior, _ = MLP.tensors(choice, scaling, args.current_energy_prior)
    scores = model(features, prior)
    best = torch.max(torch.as_tensor(quality, dtype=torch.float32))
    target = torch.as_tensor(quality, dtype=torch.float32)
    cost = args.loss_margin * (best - target)
    roots = torch.logsumexp(scores + cost, dim=0)
    empty = args.loss_margin * best
    denominator = torch.logaddexp(empty, roots)
    compatible = target >= best - args.gold_tolerance
    numerator = torch.logsumexp(scores[compatible], dim=0)
    return denominator - numerator


def page_loss(model, page: RootTeacherPage, scaling, kind: str, args):
    if page.conditional_human:
        # A corpus containing only positive pages can teach which root is
        # better, but must not calibrate the empty/non-empty decision.  The
        # conditional root softmax is invariant to a page-wide score shift.
        return quality_loss(
            model, page.choice, scaling, page.choice.quality, args
        )
    primary = MLP.page_loss(model, page.choice, scaling, args)
    if kind == "human" or page.teacher_quality is None:
        return primary
    auxiliary = quality_loss(
        model, page.choice, scaling, page.teacher_quality, args
    )
    return primary + (
        args.root_teacher_weight * page.teacher_source_quality * auxiliary
    )


def train_model(pages, wcxb_pages, kind: str, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    choices = [page.choice for page in [*pages, *wcxb_pages]]
    scaling = MLP.fit_scaling(choices, args.scaling_roots_per_page)
    model = MLP.RootEnergy(
        len(GLOBAL.CHOICE_FEATURE_NAMES), args.hidden_width, args.residual_bound
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    raw = np.asarray([
        args.exclude_weight if page.choice.root_page.item.page.status == "exclude" else 1.0
        for page in pages
    ])
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
            loss = weight * page_loss(model, page, scaling, kind, args)
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


def evaluate(page: RootTeacherPage, model, scaling, args) -> dict:
    result = MLP.page_row(page.choice, model, scaling, args)
    source = page.source
    product = source.product_f1 if source.item.page.status == "extract" else 0.0
    result.update({
        "product": product,
        "deltaVsProduct": result["candidate"] - product,
        "productAvailable": source.product_available,
        "teacherKey": page.teacher_key,
        "teacherSourceQuality": page.teacher_source_quality,
    })
    return result


def summary(rows: list[dict]) -> dict:
    base = MLP.ROOT_QUALITY.summarize(rows)
    extract = [row for row in rows if row["status"] == "extract"]
    deltas = [row["deltaVsProduct"] for row in extract]
    base.update({
        "meanDeltaVsProduct": float(np.mean(deltas)),
        "worstVsProduct": min(deltas, default=0.0),
        "regressionsVsProductBelowMinusPointOne": sum(value < -0.1 for value in deltas),
        "regressionsVsProductBelowMinusPointTwo": sum(value < -0.2 for value in deltas),
        "teacherPages": sum(row["teacherKey"] is not None for row in rows),
        "worstVsProductPages": sorted(
            extract, key=lambda row: row["deltaVsProduct"]
        )[:20],
    })
    return base


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=12)
    parser.add_argument("--residual-bound", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--current-energy-prior", type=float, default=4.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--local-teacher-weight", type=float, default=0.15)
    parser.add_argument("--root-teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--variants", default="human,product,ensemble")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    # DISTILL.fit_increment reads these names from its argparse namespace.
    args.teacher_weight = args.local_teacher_weight
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units) if args.wcxb_units else []
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    allowed_kinds = {"human", "product", "ensemble"}
    kinds = tuple(
        value.strip() for value in args.variants.split(",") if value.strip()
    )
    if not kinds or any(kind not in allowed_kinds for kind in kinds):
        raise ValueError(f"invalid variants: {args.variants}")
    rows = {kind: [] for kind in kinds}
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        local_beta = DISTILL.fit_increment(train, wcxb_train, "ensemble", args)
        fold_report = {"fold": fold, "localBeta": local_beta.tolist(), "variants": {}}
        for kind in kinds:
            train_pages = [build_page(item, local_beta, kind, args) for item in train]
            test_pages = [build_page(item, local_beta, kind, args) for item in test]
            wcxb_pages = [build_wcxb_page(item, local_beta, args) for item in wcxb_train]
            model, scaling, history = train_model(
                train_pages, wcxb_pages, kind, args, 7000 + 10 * fold
            )
            fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
            rows[kind].extend(fold_rows)
            fold_report["variants"][kind] = {
                "summary": summary(fold_rows),
                "history": history,
                "model": MLP.serialized_model(model),
                "scalingMean": scaling.mean.tolist(),
                "scalingScale": scaling.scale.tolist(),
            }
        folds.append(fold_report)
        print(json.dumps({
            "fold": fold,
            "summaries": {
                key: value["summary"] for key, value in fold_report["variants"].items()
            },
        }, ensure_ascii=False), flush=True)

    report = {
        "schema": "qingzhou.tree-dp-global-candidate-distillation.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-rich-linear-block-scorer-plus-bounded-root-mlp-plus-tree-dp",
            "humanGold": "primary-page-global-loss",
            "candidateMasks": "training-only-exact-global-auxiliary-loss",
            "positiveOnlyRootMasks": "rejected",
            "unknownEvidence": "rejected",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbTestOpened": False,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {
            "variants": {
                kind: {"summary": summary(values), "rows": values}
                for kind, values in rows.items()
            },
            "folds": folds,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "distillationStudySha256": TRAINER.sha256_file(DISTILL_PATH),
            "globalMlpStudySha256": TRAINER.sha256_file(MLP_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(args.output),
        "summaries": {key: summary(value) for key, value in rows.items()},
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
