#!/usr/bin/env python3
"""Conservative relative root utility inside a single Tree-DP model.

The model predicts a lower quantile of every alternative root's quality gain
over the ordinary Tree-DP solution on the same page.  An alternative root is
used only when its predicted lower-bound gain is positive; otherwise the same
DP's ordinary forest is retained.  This is an internal DP state transition,
not a runtime Readability/legacy candidate selector.

The old root energy is an input rather than a reachability constraint, so deep
roots can still win.  Training is page-balanced and site-family OOF; candidate
answers influence only the already-fitted local block scorer in this first
capacity check.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import random
import sys
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


CALIBRATED_PATH = HERE / "study-tree-dp-calibrated-root.py"
CALIBRATED = load_module("qingzhou_relative_root_base", CALIBRATED_PATH)
GLOBAL_DISTILL = CALIBRATED.GLOBAL_DISTILL
DISTILL = CALIBRATED.DISTILL
MLP = CALIBRATED.MLP
GLOBAL = CALIBRATED.GLOBAL
TRAINER = CALIBRATED.TRAINER


def quantile_loss(model, page, scaling, args):
    choice = page.choice
    if not len(choice.indices):
        return torch.zeros((), dtype=torch.float32)
    logits, empty_logit = model(CALIBRATED.tensors(page, scaling))
    predicted_delta = torch.tanh(logits)
    target = torch.as_tensor(
        choice.quality - choice.baseline_quality,
        dtype=torch.float32,
    )
    error = target - predicted_delta
    point_loss = torch.maximum(
        args.gain_quantile * error,
        (args.gain_quantile - 1.0) * error,
    )
    weights = args.root_floor_weight + torch.abs(target) + torch.clamp(target, min=0)
    root_loss = torch.sum(weights * point_loss) / torch.sum(weights)
    if page.conditional_human:
        empty_loss = torch.zeros((), dtype=torch.float32)
    else:
        empty_target = torch.as_tensor(
            1.0 if choice.root_page.item.page.status == "exclude" else 0.0,
            dtype=torch.float32,
        )
        empty_loss = functional.binary_cross_entropy_with_logits(
            empty_logit, empty_target
        )
    return root_loss + args.empty_loss_weight * empty_loss


def train_model(pages, wcxb_pages, wmb_pages, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = CALIBRATED.fit_scaling(
        [*pages, *wcxb_pages, *wmb_pages], args.scaling_roots_per_page
    )
    model = CALIBRATED.CalibratedRootUtility(
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
    ] + [
        (page, args.wmb_corpus_weight / max(1, len(wmb_pages)))
        for page in wmb_pages
    ]
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        count = 0
        epoch_loss = 0.0
        for page, weight in weighted:
            loss = weight * quantile_loss(model, page, scaling, args)
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


def load_wmb_pages(directory: Path) -> list[object]:
    report_path = directory / "export-report.json"
    if not report_path.exists():
        raise ValueError(f"WebMainBench export is incomplete: {report_path} is missing")
    report = json.loads(report_path.read_text(encoding="utf8"))
    if report.get("schema") != "qingzhou.webmainbench-tree-dp-training-export.v1":
        raise ValueError(f"unexpected WebMainBench export schema: {report.get('schema')}")
    paths = sorted(directory.glob("*.json.gz"))
    if report.get("exported") != len(paths):
        raise ValueError(
            f"WebMainBench export file count mismatch: {len(paths)} != {report.get('exported')}"
        )
    result = []
    for path in paths:
        with gzip.open(path, "rt", encoding="utf8") as handle:
            record = json.load(handle)
        split = record.get("split")
        if split not in {"wmb-train", "wmb-holdout"}:
            raise ValueError(f"{record.get('id')}: refusing WebMainBench split {split}")
        if record.get("sourceSha256") != report.get("sourceSha256"):
            raise ValueError(f"{record.get('id')}: source provenance differs from export report")
        page = TRAINER.page_from_record(record, {split})
        tree = record["tree"]["treeElements"]
        result.append(DISTILL.READABILITY.StudyPage(
            page=page,
            context=DISTILL.rich_context(tree, page),
            corpus="wmb",
        ))
    return result


def build_wmb_page(item, beta: np.ndarray, args):
    choice = GLOBAL.build_choice_page(item, beta, args.scope_prior_weight)
    return GLOBAL_DISTILL.RootTeacherPage(
        source=None,
        choice=choice,
        teacher_quality=choice.quality,
        teacher_source_quality=1.0,
        teacher_key="webmainbench-human-tag-mask",
        conditional_human=True,
    )


def evaluate(page, model, scaling, args):
    choice = page.choice
    source = choice.root_page.item.page
    baseline = GLOBAL.ROOT_QUALITY.decode(
        choice.root_page,
        np.zeros(len(source.tokens), dtype=np.float64),
        0.0,
        0.0,
    )
    root = None
    offset = None
    predicted_gain = 0.0
    predicted_empty = 1.0
    if len(choice.indices):
        with torch.no_grad():
            logits, empty_logit = model(CALIBRATED.tensors(page, scaling))
            gains = torch.tanh(logits).numpy()
            predicted_empty = float(torch.sigmoid(empty_logit))
        best_offset = int(np.argmax(gains))
        can_rescue_empty = baseline.available or predicted_empty < 0.5
        if float(gains[best_offset]) > 0 and can_rescue_empty:
            offset = best_offset
            root = int(choice.indices[offset])
            predicted_gain = float(gains[offset])
    if root is None:
        mask = baseline.mask.copy()
        roots = baseline.roots
        retained_tokens = baseline.retained_tokens
        available = baseline.available
    else:
        mask = GLOBAL.reconstruct(choice.root_page, root)
        roots = [root]
        retained_tokens = int(source.tokens[mask].sum())
        available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS
        if not available:
            mask = baseline.mask.copy()
            roots = baseline.roots
            retained_tokens = baseline.retained_tokens
            available = baseline.available
            root = None
            offset = None
            predicted_gain = 0.0
    baseline_text = (
        TRAINER.materialized_text(source, baseline.mask) if baseline.available else ""
    )
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
        "candidateRetainedTokens": retained_tokens,
        "predictedGainLowerBound": predicted_gain,
        "predictedEmptyProbability": predicted_empty,
        "candidateMaskQuality": (
            float(choice.quality[offset]) if offset is not None else choice.baseline_quality
        ),
        "bestMaskQuality": choice.best_quality,
        "product": product,
        "deltaVsProduct": candidate_f1 - product,
        "productAvailable": page.source.product_available,
        "teacherKey": page.teacher_key,
        "teacherSourceQuality": page.teacher_source_quality,
    }


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", type=Path)
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
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = load_wmb_pages(args.wmb_units) if args.wmb_units else []
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
        train_pages = [
            GLOBAL_DISTILL.build_page(item, beta, "human", args) for item in train
        ]
        test_pages = [
            GLOBAL_DISTILL.build_page(item, beta, "human", args) for item in test
        ]
        wcxb_pages = [
            GLOBAL_DISTILL.build_wcxb_page(item, beta, args) for item in wcxb_train
        ]
        wmb_pages = [build_wmb_page(item, beta, args) for item in wmb_train]
        model, scaling, history = train_model(
            train_pages, wcxb_pages, wmb_pages, args, 13000 + fold
        )
        fold_rows = [evaluate(page, model, scaling, args) for page in test_pages]
        rows.extend(fold_rows)
        folds.append({
            "fold": fold,
            "summary": GLOBAL_DISTILL.summary(fold_rows),
            "history": history,
            "model": MLP.serialized_model(model),
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
            "localBeta": beta.tolist(),
        })
        print(json.dumps({
            "fold": fold,
            "summary": folds[-1]["summary"],
        }, ensure_ascii=False), flush=True)

    summary = GLOBAL_DISTILL.summary(rows)
    report = {
        "schema": "qingzhou.tree-dp-relative-root-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-tree-dp-with-contextual-relative-root-state",
            "decision": "replace-ordinary-dp-forest-only-when-predicted-gain-lower-bound-is-positive",
            "candidateAnswers": "local-block-training-only",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "wmbLoss": "root-gain-quantile-only-no-empty-head-gradient",
            "inferenceComplexity": "O(N*hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {"summary": summary, "rows": rows, "folds": folds},
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "calibratedRootStudySha256": TRAINER.sha256_file(CALIBRATED_PATH),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({"output": str(args.output), "summary": summary}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
