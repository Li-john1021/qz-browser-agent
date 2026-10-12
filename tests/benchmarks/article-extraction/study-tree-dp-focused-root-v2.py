#!/usr/bin/env python3
"""Benchmark-only page-relative root model for Tree-DP Focused mode.

Focused mode is one connected primary scope with ordinary Tree-DP carve
decisions inside it.  All legal roots on a page compete in one listwise loss;
the model never predicts an absolute cross-page score and never consumes URL,
site, page type, timing, Readability output, or gold at inference time.

The training cohort is the human ``detail`` stratum from base+train.  This is
only capacity evidence for the proposed mode: page type selects training and
reporting rows but is deliberately absent from serving features.  Evaluation
is site-family OOF and this loader refuses validation/test.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MODES = load_module(
    "qingzhou_focused_root_modes",
    HERE / "study-tree-dp-focused-collection-em.py",
)
GLOBAL = load_module(
    "qingzhou_focused_root_global",
    HERE / "study-tree-dp-global-choice.py",
)
CORE = MODES.CORE


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


class ContextualRootEnergy(torch.nn.Module):
    """Permutation-equivariant bounded residual over all roots on one page."""

    def __init__(self, dimensions: int, width: int, residual_bound: float):
        super().__init__()
        self.residual_bound = residual_bound
        self.encoder = torch.nn.Linear(dimensions, width)
        self.head = torch.nn.Sequential(
            torch.nn.Linear(3 * width, width),
            torch.nn.Tanh(),
            torch.nn.Linear(width, 1),
        )
        torch.nn.init.zeros_(self.head[-1].weight)
        torch.nn.init.zeros_(self.head[-1].bias)

    def forward(self, features: torch.Tensor, prior: torch.Tensor) -> torch.Tensor:
        hidden = torch.tanh(self.encoder(features))
        mean = torch.mean(hidden, dim=0, keepdim=True)
        maximum = torch.max(hidden, dim=0, keepdim=True).values
        contextual = torch.cat([hidden, hidden - mean, maximum - hidden], dim=1)
        raw = self.head(contextual).squeeze(-1)
        residual = self.residual_bound * torch.tanh(raw / self.residual_bound)
        return prior + residual


@dataclass
class LinearRootRanker:
    scaler: StandardScaler
    classifier: LogisticRegression
    training_pairs: int

    def predict(self, features: np.ndarray) -> np.ndarray:
        return np.asarray(
            self.classifier.decision_function(self.scaler.transform(features)),
            dtype=np.float64,
        )


def load_page_types(directory: Path) -> dict[str, str]:
    result = {}
    for path in sorted(directory.glob("*.json.gz")):
        with gzip.open(path, "rt", encoding="utf8") as handle:
            record = json.load(handle)
        split = record.get("split")
        if split not in {"base", "train"}:
            raise ValueError(f"{record.get('id')}: refusing split {split}")
        result[record["id"]] = record.get("type", "")
    return result


def load_candidate_metrics(path: Path) -> dict[str, dict]:
    result = {}
    with path.open("r", encoding="utf8") as handle:
        for line in handle:
            record = json.loads(line)
            candidates = {item.get("key"): item for item in record.get("candidates", [])}

            def quality(key: str) -> float:
                candidate = candidates.get(key, {})
                if not candidate.get("available"):
                    return 0.0
                return float((candidate.get("metrics") or {}).get("mainNgramF1", 0.0))

            result[record["id"]] = {
                "forcedTree": quality("treedp"),
                "readability": quality("readability"),
                "readabilityText": str(
                    ((candidates.get("readability", {}).get("output") or {}).get(
                        "sourceText", ""
                    ))
                ),
            }
    return result


def sampled_feature_rows(pages, maximum: int) -> np.ndarray:
    rows = []
    for page in pages:
        count = len(page.indices)
        if not count:
            continue
        if count <= maximum:
            offsets = np.arange(count)
        else:
            third = maximum // 3
            offsets = np.unique(np.concatenate([
                np.argsort(page.current_energy[page.indices])[-third:],
                np.argsort(page.quality)[-third:],
                np.linspace(0, count - 1, maximum - 2 * third, dtype=np.int64),
            ]))
        rows.append(page.features[offsets])
    if not rows:
        raise ValueError("no focused root feature rows")
    return np.concatenate(rows)


def fit_scaling(pages, maximum: int) -> Scaling:
    matrix = sampled_feature_rows(pages, maximum)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(matrix.mean(axis=0), scale)


def root_prior(page, args) -> np.ndarray:
    if args.root_prior == "readability":
        readability_index = GLOBAL.CHOICE_FEATURE_NAMES.index(
            "readabilityLinkAdjustedScore"
        )
        value = page.features[:, readability_index]
        return args.readability_prior_scale * (value - np.max(value))
    if args.root_prior == "blend":
        readability_index = GLOBAL.CHOICE_FEATURE_NAMES.index(
            "readabilityLinkAdjustedScore"
        )
        value = page.features[:, readability_index]
        readability = args.readability_prior_scale * (value - np.max(value))
        return args.current_energy_prior * page.energy_offset + readability
    return args.current_energy_prior * page.energy_offset


def page_tensors(page, scaling: Scaling, args):
    features = np.clip((page.features - scaling.mean) / scaling.scale, -8.0, 8.0)
    return (
        torch.as_tensor(features, dtype=torch.float32),
        torch.as_tensor(root_prior(page, args), dtype=torch.float32),
        torch.as_tensor(page.quality, dtype=torch.float32),
    )


def listwise_loss(
    scores: torch.Tensor,
    quality: torch.Tensor,
    *,
    margin: float,
    tolerance: float,
) -> torch.Tensor:
    best = torch.max(quality)
    augmented = scores + margin * (best - quality)
    denominator = torch.logsumexp(augmented, dim=0)
    compatible = quality >= best - tolerance
    numerator = torch.logsumexp(scores[compatible], dim=0)
    return denominator - numerator


def page_loss(model, page, scaling: Scaling, args) -> torch.Tensor:
    features, prior, quality = page_tensors(page, scaling, args)
    scores = model(features, prior)
    loss = listwise_loss(
        scores,
        quality,
        margin=args.loss_margin,
        tolerance=args.gold_tolerance,
    )
    if args.readability_teacher_weight > 0:
        teacher = torch.as_tensor(page.readability_teacher_quality, dtype=torch.float32)
        if float(torch.max(teacher)) > 0:
            loss = loss + args.readability_teacher_weight * listwise_loss(
                scores,
                teacher,
                margin=args.readability_teacher_margin,
                tolerance=args.readability_teacher_tolerance,
            )
    return loss


def attach_readability_teacher(page, readability_text: str) -> None:
    source = page.root_page.item.page
    quality = np.zeros(len(page.indices), dtype=np.float64)
    if readability_text:
        for offset, root in enumerate(page.indices):
            mask = reconstruct(page.root_page, int(root))
            text = CORE.materialized_text(source, mask)
            quality[offset] = CORE.trigram_f1(text, readability_text)
    page.readability_teacher_quality = quality


def constrain_to_primary_evidence(page) -> bool:
    """Keep roots whose materialized connected scope contains primary evidence.

    The primary node is reconstructed from Readability's scoring mechanics,
    not from its candidate output.  It is therefore an ordinary inference-time
    DOM signal.  If the page has no such evidence, or the local carve state
    cannot retain it from any legal root, fail open to the original root set.
    """
    source = page.root_page.item.page
    primary, _scope, _top = GLOBAL.SINGLE.readability_primary_scope(source)
    if primary is None:
        return False
    selected = np.asarray([
        offset
        for offset, root in enumerate(page.indices)
        if reconstruct(page.root_page, int(root))[primary]
    ], dtype=np.int64)
    if not len(selected):
        return False
    page.indices = page.indices[selected]
    page.features = page.features[selected]
    page.energy_offset = page.energy_offset[selected]
    page.quality = page.quality[selected]
    page.best_quality = float(np.max(page.quality))
    tied = np.flatnonzero(page.quality >= page.best_quality - 1e-12)
    page.target_offset = int(max(
        tied,
        key=lambda offset: (
            float(page.current_energy[page.indices[offset]]),
            -int(page.indices[offset]),
        ),
    ))
    return True


def train_model(pages, args, seed: int):
    torch.manual_seed(seed)
    random.seed(seed)
    scaling = fit_scaling(pages, args.scaling_roots_per_page)
    model = ContextualRootEnergy(
        len(GLOBAL.CHOICE_FEATURE_NAMES), args.hidden_width, args.residual_bound,
    )
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay,
    )
    family_counts: dict[tuple[str, str], int] = {}
    corpus_families: dict[str, set[str]] = {}
    for page in pages:
        corpus = getattr(page, "training_corpus", "zh")
        family = page.root_page.item.page.site_family
        key = (corpus, family)
        family_counts[key] = family_counts.get(key, 0) + 1
        corpus_families.setdefault(corpus, set()).add(family)
    corpus_mass = {"zh": 1.0, "wcxb": args.wcxb_corpus_weight}
    weighted = [
        (
            page,
            corpus_mass.get(getattr(page, "training_corpus", "zh"), 1.0)
            / max(1, len(corpus_families[getattr(page, "training_corpus", "zh")]))
            / family_counts[(
                getattr(page, "training_corpus", "zh"),
                page.root_page.item.page.site_family,
            )],
        )
        for page in pages
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


def hard_negative_offsets(page, maximum: int = 64) -> np.ndarray:
    best = float(np.max(page.quality))
    negatives = np.flatnonzero(page.quality <= best - 0.05)
    if len(negatives) <= maximum:
        return negatives
    readability_index = GLOBAL.CHOICE_FEATURE_NAMES.index(
        "readabilityLinkAdjustedScore"
    )
    quarter = maximum // 4
    return np.unique(np.concatenate([
        negatives[np.argsort(page.current_energy[page.indices][negatives])[-quarter:]],
        negatives[np.argsort(page.features[negatives, readability_index])[-quarter:]],
        negatives[np.argsort(page.quality[negatives])[-quarter:]],
        negatives[np.linspace(0, len(negatives) - 1, maximum - 3 * quarter, dtype=np.int64)],
    ]))


def fit_linear_ranker(pages, args) -> LinearRootRanker:
    family_counts: dict[str, int] = {}
    for page in pages:
        family = page.root_page.item.page.site_family
        family_counts[family] = family_counts.get(family, 0) + 1
    family_total = max(1, len(family_counts))
    matrices = []
    labels = []
    weights = []
    for page in pages:
        best = float(np.max(page.quality))
        positives = np.flatnonzero(page.quality >= best - args.gold_tolerance)
        if len(positives) > 4:
            positives = positives[np.argsort(page.current_energy[page.indices][positives])[-4:]]
        negatives = hard_negative_offsets(page)
        differences = []
        outcomes = []
        for positive in positives:
            for negative in negatives:
                difference = page.features[positive] - page.features[negative]
                if np.max(np.abs(difference)) <= 1e-12:
                    continue
                differences.extend([difference, -difference])
                outcomes.extend([1.0, 0.0])
        if not differences:
            continue
        matrix = np.asarray(differences, dtype=np.float64)
        family = page.root_page.item.page.site_family
        page_weight = 1.0 / (family_total * family_counts[family])
        matrices.append(matrix)
        labels.append(np.asarray(outcomes, dtype=np.float64))
        weights.append(np.full(len(outcomes), page_weight / len(outcomes)))
    matrix = np.concatenate(matrices)
    label = np.concatenate(labels)
    weight = np.concatenate(weights)
    scaler = StandardScaler(with_mean=False)
    scaler.fit(matrix, sample_weight=weight)
    classifier = LogisticRegression(
        C=args.ranking_c,
        fit_intercept=False,
        solver="lbfgs",
        max_iter=1000,
        tol=1e-10,
    )
    classifier.fit(scaler.transform(matrix), label, sample_weight=weight)
    return LinearRootRanker(scaler, classifier, len(label))


def reconstruct(root_page, root: int) -> np.ndarray:
    return MODES.reconstruct_root(root_page.item.page, root, root_page.keep_choice)


def candidate_row(page, root: int, score: float, metrics: dict, local_beta) -> dict:
    source = page.root_page.item.page
    mask = reconstruct(page.root_page, root)
    text = CORE.materialized_text(source, mask)
    candidate = CORE.trigram_f1(text, source.reference)
    focused = MODES.finalize_decode(source, mask, [root], score)
    collection = MODES.decode_collection(
        page.root_page.item,
        MODES.baseline_logits(page.root_page.item, local_beta),
    )
    return {
        "id": source.id,
        "siteFamily": source.site_family,
        "split": source.split,
        "candidate": candidate,
        "collection": collection.quality,
        "forcedTree": metrics[source.id]["forcedTree"],
        "readability": metrics[source.id]["readability"],
        "deltaVsTree": candidate - metrics[source.id]["forcedTree"],
        "deltaVsReadability": candidate - metrics[source.id]["readability"],
        "root": root,
        "rootTag": source.tags[root],
        "rootMaskQuality": float(page.quality[np.flatnonzero(page.indices == root)[0]]),
        "bestRootMaskQuality": float(page.best_quality),
        "retainedTokens": int(source.tokens[mask].sum()),
        "modeFeatures": MODES.candidate_pair_features(focused, collection).tolist(),
    }


def evaluate(page, models, scalings: list[Scaling], metrics: dict, args, local_beta) -> dict:
    predictions = []
    with torch.no_grad():
        for model, scaling in zip(models, scalings, strict=True):
            features, prior, _quality = page_tensors(page, scaling, args)
            predictions.append(model(features, prior).numpy())
    scores = np.mean(predictions, axis=0)
    offset = int(np.argmax(scores))
    root = int(page.indices[offset])
    return candidate_row(page, root, float(scores[offset]), metrics, local_beta)


def evaluate_linear(page, model: LinearRootRanker, metrics: dict, local_beta) -> dict:
    scores = model.predict(page.features)
    offset = int(np.argmax(scores))
    root = int(page.indices[offset])
    return candidate_row(page, root, float(scores[offset]), metrics, local_beta)


def mode_gate_oof(rows: list[dict], folds: int) -> dict:
    matrix = np.asarray([row["modeFeatures"] for row in rows], dtype=np.float64)
    target = np.asarray([
        row["candidate"] - row["collection"] for row in rows
    ], dtype=np.float64)
    groups = np.asarray([row["siteFamily"] for row in rows])
    prediction = np.zeros(len(rows), dtype=np.float64)
    fold_values = np.zeros(len(rows), dtype=np.int64)
    indices = np.arange(len(rows))
    models = []
    for fold, (training, heldout) in enumerate(
        GroupKFold(folds).split(indices, groups=groups), 1
    ):
        family_counts: dict[str, int] = {}
        for index in training:
            family = groups[index]
            family_counts[family] = family_counts.get(family, 0) + 1
        weight = np.asarray([
            1.0 / family_counts[groups[index]] for index in training
        ])
        model = Ridge(alpha=10.0)
        model.fit(matrix[training], target[training], sample_weight=weight)
        prediction[heldout] = model.predict(matrix[heldout])
        fold_values[heldout] = fold
        models.append({
            "fold": fold,
            "coefficient": model.coef_.tolist(),
            "intercept": float(model.intercept_),
        })
    selected = np.asarray([
        row["candidate"] if prediction[index] >= 0 else row["collection"]
        for index, row in enumerate(rows)
    ])
    readability = np.asarray([row["readability"] for row in rows])
    delta = selected - readability
    return {
        "summary": {
            "pages": len(rows),
            "selectedMeanF1": float(selected.mean()),
            "focusedMeanF1": float(np.mean([row["candidate"] for row in rows])),
            "collectionMeanF1": float(np.mean([row["collection"] for row in rows])),
            "readabilityMeanF1": float(readability.mean()),
            "meanDeltaVsReadability": float(delta.mean()),
            "focusedSelections": int((prediction >= 0).sum()),
            "collectionSelections": int((prediction < 0).sum()),
            "winsVsReadability": int((delta > 1e-9).sum()),
            "lossesVsReadability": int((delta < -1e-9).sum()),
            "worstVsReadability": float(delta.min()),
            "regressionsVsReadabilityBelowMinusPointOne": int((delta < -0.1).sum()),
            "regressionsVsReadabilityBelowMinusPointTwo": int((delta < -0.2).sum()),
        },
        "rows": [
            {
                "id": row["id"],
                "fold": int(fold_values[index]),
                "selectedMode": "focused" if prediction[index] >= 0 else "collection",
                "predictedFocusedMinusCollection": float(prediction[index]),
                "selectedF1": float(selected[index]),
                "deltaVsReadability": float(delta[index]),
            }
            for index, row in enumerate(rows)
        ],
        "models": models,
    }


def summary(rows: list[dict]) -> dict:
    candidate = np.asarray([row["candidate"] for row in rows])
    tree = np.asarray([row["forcedTree"] for row in rows])
    readability = np.asarray([row["readability"] for row in rows])
    delta_tree = candidate - tree
    delta_readability = candidate - readability
    return {
        "pages": len(rows),
        "candidateMeanF1": float(candidate.mean()),
        "forcedTreeMeanF1": float(tree.mean()),
        "readabilityMeanF1": float(readability.mean()),
        "meanDeltaVsTree": float(delta_tree.mean()),
        "meanDeltaVsReadability": float(delta_readability.mean()),
        "winsVsReadability": int((delta_readability > 1e-9).sum()),
        "lossesVsReadability": int((delta_readability < -1e-9).sum()),
        "worstVsReadability": float(delta_readability.min()),
        "regressionsVsReadabilityBelowMinusPointOne": int((delta_readability < -0.1).sum()),
        "regressionsVsReadabilityBelowMinusPointTwo": int((delta_readability < -0.2).sum()),
        "p10F1": float(np.quantile(candidate, 0.1)),
    }


def serialize_model(model) -> dict:
    return {name: value.detach().numpy().tolist() for name, value in model.state_dict().items()}


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--units", required=True, type=Path)
    parser.add_argument("--extractor", required=True, type=Path)
    parser.add_argument("--current-candidates", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-pages", type=int, default=24)
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--residual-bound", type=float, default=6.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--current-energy-prior", type=float, default=0.5)
    parser.add_argument(
        "--root-prior", choices=("current", "readability", "blend"),
        default="current",
    )
    parser.add_argument("--readability-prior-scale", type=float, default=1.0)
    parser.add_argument("--scope-prior-weight", type=float, default=0.25)
    parser.add_argument("--scaling-roots-per-page", type=int, default=128)
    parser.add_argument("--ensemble-size", type=int, default=3)
    parser.add_argument(
        "--model", choices=("contextual-mlp", "pairwise-linear"),
        default="contextual-mlp",
    )
    parser.add_argument("--ranking-c", type=float, default=1.0)
    parser.add_argument("--readability-teacher-weight", type=float, default=1.0)
    parser.add_argument("--readability-teacher-margin", type=float, default=2.0)
    parser.add_argument("--readability-teacher-tolerance", type=float, default=0.02)
    parser.add_argument(
        "--focused-obligation",
        choices=("none", "primary-evidence"),
        default="none",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    torch.set_num_threads(1)
    units = args.units.resolve()
    all_pages = MODES.load_pages(units)
    page_types = load_page_types(units)
    metrics = load_candidate_metrics(args.current_candidates.resolve())
    local_beta, extractor_sha = MODES.artifact_local_beta(args.extractor.resolve())
    details = [
        item for item in all_pages
        if item.page.status == "extract" and page_types[item.page.id] == "detail"
    ]
    missing = [item.page.id for item in details if item.page.id not in metrics]
    if missing:
        raise ValueError(f"missing current metrics for {len(missing)} detail pages")
    choices = [
        GLOBAL.build_choice_page(item, local_beta, args.scope_prior_weight)
        for item in details
    ]
    if any(not len(page.indices) for page in choices):
        raise ValueError("Focused detail page has no legal root")
    obligation_pages = 0
    for page in choices:
        page.training_corpus = "zh"
        if (
            args.focused_obligation == "primary-evidence"
            and constrain_to_primary_evidence(page)
        ):
            obligation_pages += 1
        attach_readability_teacher(
            page,
            metrics[page.root_page.item.page.id]["readabilityText"],
        )

    wcxb_choices = []
    if args.wcxb_units:
        wcxb_items = [
            item for item in MODES.DISTILL.load_wcxb_pages(args.wcxb_units.resolve())
            if item.page.split == "wcxb-train"
        ]
        wcxb_choices = [
            GLOBAL.build_choice_page(item, local_beta, args.scope_prior_weight)
            for item in wcxb_items
        ]
        wcxb_choices = [page for page in wcxb_choices if len(page.indices)]
        for page in wcxb_choices:
            page.training_corpus = "wcxb"
            if args.focused_obligation == "primary-evidence":
                constrain_to_primary_evidence(page)
            page.readability_teacher_quality = np.zeros(
                len(page.indices), dtype=np.float64,
            )

    groups = np.asarray([page.root_page.item.page.site_family for page in choices])
    indices = np.arange(len(choices))
    rows = []
    folds = []
    for fold, (train_indices, heldout_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        training = [choices[int(index)] for index in train_indices] + wcxb_choices
        heldout = [choices[int(index)] for index in heldout_indices]
        if args.model == "pairwise-linear":
            linear = fit_linear_ranker(training, args)
            fold_rows = [
                evaluate_linear(page, linear, metrics, local_beta)
                for page in heldout
            ]
            model_report = {
                "trainingPairs": linear.training_pairs,
                "scalingScale": linear.scaler.scale_.tolist(),
                "coefficient": linear.classifier.coef_[0].tolist(),
            }
        else:
            trained = [
                train_model(training, args, 41_000 + 100 * fold + seed)
                for seed in range(args.ensemble_size)
            ]
            models = [item[0] for item in trained]
            scalings = [item[1] for item in trained]
            histories = [item[2] for item in trained]
            fold_rows = [
                evaluate(page, models, scalings, metrics, args, local_beta)
                for page in heldout
            ]
            model_report = {
                "ensemble": [
                    {
                        "history": history,
                        "scalingMean": scaling.mean.tolist(),
                        "scalingScale": scaling.scale.tolist(),
                        "model": serialize_model(model),
                    }
                    for model, scaling, history in zip(
                        models, scalings, histories, strict=True,
                    )
                ],
            }
        for row in fold_rows:
            row["fold"] = fold
        rows.extend(fold_rows)
        folds.append({
            "fold": fold,
            "trainingPages": len(training),
            "heldoutPages": len(heldout),
            "trainingFamilies": len({page.root_page.item.page.site_family for page in training}),
            "heldoutFamilies": len({page.root_page.item.page.site_family for page in heldout}),
            "summary": summary(fold_rows),
            "model": model_report,
        })
        print(json.dumps({"fold": fold, **folds[-1]["summary"]}, ensure_ascii=False), flush=True)

    gate = mode_gate_oof(rows, args.folds)
    report = {
        "schema": "qingzhou.tree-dp-focused-root-study.v2",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "trainingCohort": "human-page-type-detail",
            "servingUsesPageType": False,
            "grouping": "siteFamily",
            "validationOpened": False,
            "testOpened": False,
            "mode": "one-legal-root-with-tree-dp-carve",
            "objective": "page-listwise-cost-augmented-latent-best-root",
            "runtimeFeatures": GLOBAL.CHOICE_FEATURE_NAMES,
            "runtimeReadabilityCandidate": False,
            "inferenceComplexity": "O(N*hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "provenance": {
            "extractorSha256": extractor_sha,
            "currentCandidatesSha256": CORE.sha256_file(args.current_candidates.resolve()),
            "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "detailPages": len(choices),
            "detailFamilies": len(set(groups)),
            "obligationPages": obligation_pages,
            "wcxbTrainingPages": len(wcxb_choices),
        },
        "siteFamilyOof": {
            "summary": summary(rows),
            "rows": sorted(rows, key=lambda row: row["id"]),
            "folds": folds,
        },
        "twoModeSiteFamilyOof": gate,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"output": str(args.output), "summary": report["siteFamilyOof"]["summary"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
