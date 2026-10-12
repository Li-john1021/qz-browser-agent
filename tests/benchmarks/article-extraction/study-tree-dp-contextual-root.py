#!/usr/bin/env python3
"""Study a page-conditioned root energy for the single Tree-DP extractor.

The existing bounded root MLP scores each legal root independently.  That is
an unnecessarily weak model of the actual decision: a root is good relative
to the other roots on the same page.  This study adds a small permutation-
equivariant page context (mean and max over learned root embeddings) while
keeping inference to one linear block scorer, one root network and one DP.

Readability and the other extractors are training-only teachers.  They are not
run, represented, or selected at inference time.  The study is restricted to
base+train site-family OOF; it never opens Chinese validation/test or WCXB
test.
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
GLOBAL_DISTILL = load_module("qingzhou_contextual_root_data", GLOBAL_DISTILL_PATH)
DISTILL = GLOBAL_DISTILL.DISTILL
MLP = GLOBAL_DISTILL.MLP
GLOBAL = MLP.GLOBAL
TRAINER = DISTILL.TRAINER


class ContextualRootEnergy(torch.nn.Module):
    """Bounded residual energy with learned page-relative root context."""

    def __init__(self, dimensions: int, width: int, residual_bound: float):
        super().__init__()
        self.residual_bound = residual_bound
        self.root_encoder = torch.nn.Linear(dimensions, width)
        # local embedding, deviation from the page mean, and gap to the page
        # maximum are all permutation-equivariant and need only O(R * width).
        self.context = torch.nn.Sequential(
            torch.nn.Linear(3 * width, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        # The initial model is exactly the fixed shipped-DP prior.  Context has
        # to earn a bounded correction from page-level training evidence.
        torch.nn.init.zeros_(self.context[-1].weight)
        torch.nn.init.zeros_(self.context[-1].bias)

    def forward(self, features: torch.Tensor, prior: torch.Tensor) -> torch.Tensor:
        if not len(features):
            return prior
        hidden = torch.tanh(self.root_encoder(features))
        mean = torch.mean(hidden, dim=0, keepdim=True)
        maximum = torch.max(hidden, dim=0, keepdim=True).values
        relative = torch.cat([
            hidden,
            hidden - mean,
            maximum - hidden,
        ], dim=1)
        raw = self.context(relative).squeeze(-1)
        residual = self.residual_bound * torch.tanh(raw / self.residual_bound)
        return prior + residual


def train_model(pages, wcxb_pages, wmb_pages, kind: str, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    choices = [page.choice for page in [*pages, *wcxb_pages, *wmb_pages]]
    scaling = MLP.fit_scaling(choices, args.scaling_roots_per_page)
    model = ContextualRootEnergy(
        len(GLOBAL.CHOICE_FEATURE_NAMES),
        args.hidden_width,
        args.residual_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
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
            loss = weight * GLOBAL_DISTILL.page_loss(
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
    choice = GLOBAL_DISTILL.GLOBAL.build_choice_page(
        item, beta, args.scope_prior_weight
    )
    return GLOBAL_DISTILL.RootTeacherPage(
        source=None,
        choice=choice,
        teacher_quality=choice.quality,
        teacher_source_quality=1.0,
        teacher_key="webmainbench-human-tag-mask",
        conditional_human=True,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", required=True, type=Path)
    parser.add_argument("--wmb-units", type=Path)
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
    parser.add_argument("--wmb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--variants", default="human,ensemble")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.teacher_weight = args.local_teacher_weight
    pages, audit = DISTILL.load_pages(args)
    wcxb = DISTILL.load_wcxb_pages(args.wcxb_units)
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    wmb = load_wmb_pages(args.wmb_units) if args.wmb_units else []
    wmb_train = [item for item in wmb if item.page.split == "wmb-train"]
    wmb_holdout = [item for item in wmb if item.page.split == "wmb-holdout"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    kinds = tuple(
        value.strip() for value in args.variants.split(",") if value.strip()
    )
    if not kinds or any(kind not in {"human", "product", "ensemble"} for kind in kinds):
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
            train_pages = [
                GLOBAL_DISTILL.build_page(item, local_beta, kind, args)
                for item in train
            ]
            test_pages = [
                GLOBAL_DISTILL.build_page(item, local_beta, kind, args)
                for item in test
            ]
            wcxb_pages = [
                GLOBAL_DISTILL.build_wcxb_page(item, local_beta, args)
                for item in wcxb_train
            ]
            wmb_pages = [
                build_wmb_page(item, local_beta, args)
                for item in wmb_train
            ]
            model, scaling, history = train_model(
                train_pages, wcxb_pages, wmb_pages, kind, args, 9000 + 10 * fold
            )
            fold_rows = [
                GLOBAL_DISTILL.evaluate(page, model, scaling, args)
                for page in test_pages
            ]
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
                key: value["summary"]
                for key, value in fold_report["variants"].items()
            },
        }, ensure_ascii=False), flush=True)

    summaries = {
        kind: GLOBAL_DISTILL.summary(values) for kind, values in rows.items()
    }
    report = {
        "schema": "qingzhou.tree-dp-contextual-root-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidates": False,
            "runtimeModel": "single-rich-linear-block-scorer-plus-contextual-root-energy-plus-tree-dp",
            "pageContext": "learned-root-embedding-mean-and-max",
            "humanGold": "primary-page-global-loss",
            "candidateMasks": "training-only-exact-global-auxiliary-loss",
            "positiveOnlyRootMasks": "rejected",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbHoldoutOpened": False,
            "wcxbTestOpened": False,
            "wmbTrainPages": len(wmb_train),
            "wmbHoldoutPages": len(wmb_holdout),
            "wmbCorpusRole": "exact-tag-supervision-with-domain-held-out-diagnostic",
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
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf8",
    )
    print(json.dumps({
        "output": str(args.output),
        "summaries": summaries,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
