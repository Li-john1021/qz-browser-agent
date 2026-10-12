#!/usr/bin/env python3
"""Training-only candidate distillation for a single Tree-DP extractor.

The experiment asks a narrow question: can the generic signals encoded by the
legacy candidate family regularize one linear Tree-DP block scorer without
running any candidate at inference time?  Human text-region labels remain the
primary target.  Candidate provenance contributes an auxiliary, lower-weight
loss only where the current benchmark can prove source-DOM identity:

* exact clone masks provide keep and drop evidence;
* unique monotone mappings provide positive keep evidence only;
* unknown, synthetic, ambiguous, or coordinate-mismatched evidence is skipped;
  the human-gold page itself remains in training and evaluation.

All evaluation is site-family OOF on Chinese base+train.  Chinese validation
and test, and WCXB test, are refused by construction.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import re
import sys
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
READABILITY_PATH = HERE / "study-tree-dp-readability.py"
SPEC = importlib.util.spec_from_file_location(
    "qingzhou_candidate_distillation_readability", READABILITY_PATH
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {READABILITY_PATH}")
READABILITY = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = READABILITY
SPEC.loader.exec_module(READABILITY)
TRAINER = READABILITY.TRAINER


ZERO_WIDTH_RE = re.compile("[\u200b-\u200f\ufeff]")
SPACE_RE = re.compile(r"\s+")
PROVENANCE_KEYS = ("rules", "readability", "paragraph", "baseline", "recall")
IDENTITY_FIELDS = (
    "source", "parent", "tag", "anchor", "heading", "listItem",
    "boilerplateHits", "contentHits", "readabilityClassWeight",
    "readabilityUnlikely", "readabilityRoleRejected", "repeated", "depth",
    "ownText", "ownChars", "tokens", "sourceUnitIds",
)

RICH_FEATURE_NAMES = [
    "readabilityClassAncestorNetCapped3",
    "readabilityUnlikelyAncestor",
    "readabilityClassOwn",
    "readabilityUnlikelyOwn",
    "readabilityRoleRejectedAncestor",
    "readabilityParagraphEvidenceLog",
    "readabilityTagPrior",
    "readabilityLinkFactor",
    "readabilityRawScore",
    "readabilityLinkAdjustedScore",
    "readabilitySubtreeCharShare",
]


@dataclass
class Teacher:
    key: str
    exact: bool
    quality: float
    known: np.ndarray
    keep: np.ndarray
    coverage: float


@dataclass
class DistillPage:
    item: object
    rich_context: np.ndarray
    product_teacher: Teacher | None
    ensemble_teachers: list[Teacher]
    product_f1: float
    product_available: bool


def read_gzip(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf8") as handle:
        return json.load(handle)


def normalize_text(value: str) -> str:
    return SPACE_RE.sub(
        " ", ZERO_WIDTH_RE.sub("", unicodedata.normalize("NFKC", value or ""))
    ).strip()


def children_for(parent: np.ndarray) -> list[list[int]]:
    children: list[list[int]] = [[] for _ in parent]
    for index in range(1, len(parent)):
        if parent[index] < 0 or parent[index] >= index:
            raise ValueError(f"invalid parent preorder at {index}")
        children[int(parent[index])].append(index)
    return children


def current_page(old: dict, internal: dict) -> object:
    source_tree = internal["benchmarkDiagnostics"]["provenance"]["sourceTree"]
    current = source_tree["treeElements"]
    previous = old["tree"]["treeElements"]
    if len(current) != len(previous):
        raise ValueError(
            f"{old['id']}: current/gold Tree-DP coordinates differ "
            f"({len(current)} != {len(previous)})"
        )
    for index, (left, right) in enumerate(zip(previous, current, strict=True)):
        for field in IDENTITY_FIELDS:
            if left.get(field) != right.get(field):
                raise ValueError(
                    f"{old['id']}: coordinate identity differs at {index}.{field}"
                )
    # Candidate provenance can legitimately predate an additive training-only
    # feature export.  Once the exact DOM coordinate above has matched, take
    # those additive signals from the gold unit rather than silently replacing
    # them with zero.  Candidate masks and text still use their own provenance
    # coordinate below.
    readability_tree = (
        previous
        if all("readabilityPositiveHits" in item for item in previous)
        else current
    )

    parent = np.asarray([item["parent"] for item in current], dtype=np.int64)
    tokens = np.asarray([item["tokens"] for item in current], dtype=np.float64)
    features = np.asarray([item["features"] for item in current], dtype=np.float64)
    gold_known = np.asarray([item.get("goldKnown") is True for item in previous], dtype=bool)
    gold_keep = np.asarray([item.get("goldKeep") is True for item in previous], dtype=bool)
    if np.any((tokens > 0) & ~gold_known):
        raise ValueError(f"{old['id']}: human gold is unknown on a token-bearing node")
    children = children_for(parent)
    subtree_tokens = tokens.copy()
    for index in range(len(tokens) - 1, 0, -1):
        subtree_tokens[parent[index]] += subtree_tokens[index]
    segments = [
        (int(segment[0]), str(segment[1]), segment[2] if len(segment) > 2 else None)
        for segment in source_tree.get("treeTextSegments", [])
    ]
    page = TRAINER.Page(
        id=old["id"],
        site_family=old["siteFamily"],
        split=old["split"],
        status=old["status"],
        reference=old.get("reference", {}).get("mainText", ""),
        parent=parent,
        tags=[str(item["tag"]) for item in current],
        tokens=tokens,
        features=features,
        gold_known=gold_known,
        gold_keep=gold_keep,
        children=children,
        subtree_tokens=subtree_tokens,
        readability_root_scores=TRAINER.readability_root_components(
            current, parent, children
        ),
        readability_positive_hits=np.asarray([
            float(item.get("readabilityPositiveHits", 0.0)) for item in readability_tree
        ], dtype=np.float64),
        readability_negative_hits=np.asarray([
            float(item.get("readabilityNegativeHits", 0.0)) for item in readability_tree
        ], dtype=np.float64),
        readability_ok_maybe=np.asarray([
            bool(item.get("readabilityOkMaybe")) for item in readability_tree
        ], dtype=bool),
        readability_extraneous=np.asarray([
            bool(item.get("readabilityExtraneous")) for item in readability_tree
        ], dtype=bool),
        readability_byline=np.asarray([
            bool(item.get("readabilityByline")) for item in readability_tree
        ], dtype=bool),
        readability_share=np.asarray([
            bool(item.get("readabilityShare")) for item in readability_tree
        ], dtype=bool),
        readability_unlikely=np.asarray([
            bool(item.get("readabilityUnlikely")) for item in current
        ]),
        readability_role_rejected=np.asarray([
            bool(item.get("readabilityRoleRejected")) for item in current
        ]),
        sibling_group=np.asarray([
            int(item.get("siblingGroup", 0)) for item in current
        ], dtype=np.int64),
        segments=segments,
        source_sha256={
            "gold": old.get("sourceSha256"),
            "candidateProvenance": internal.get("schema"),
        },
        shipped=internal["benchmarkDiagnostics"]["forcedTreeDp"],
    )
    decoded = TRAINER.decode(page, TRAINER.CURRENT_THETA)
    shipped = page.shipped
    if abs(decoded.value - float(shipped["bestDpScore"])) > 1e-7:
        raise ValueError(f"{page.id}: current source-tree score parity failed")
    if len(decoded.roots) != int(shipped["includeRootCount"]):
        raise ValueError(f"{page.id}: current source-tree root parity failed")
    if decoded.retained_tokens != int(shipped["retainedTokens"]):
        raise ValueError(f"{page.id}: current source-tree retained-token parity failed")
    return page


def rich_context(tree: list[dict], page) -> np.ndarray:
    base = READABILITY.context_features({"tree": {"treeElements": tree}}, page)
    own_class = np.asarray([
        float(item.get("readabilityClassWeight", 0.0)) / 25.0 for item in tree
    ])
    own_unlikely = np.asarray([
        float(bool(item.get("readabilityUnlikely"))) for item in tree
    ])
    role = np.asarray([
        float(bool(item.get("readabilityRoleRejected"))) for item in tree
    ])
    role_ancestor = role.copy()
    for index in range(1, len(tree)):
        role_ancestor[index] = max(role_ancestor[index], role_ancestor[page.parent[index]])
    components = page.readability_root_scores
    subtree_chars = components["subtree-chars"]
    page_chars = max(1.0, float(subtree_chars[0]))
    return np.column_stack([
        base,
        own_class,
        own_unlikely,
        role_ancestor,
        np.log1p(np.maximum(0.0, components["evidence"])),
        components["tag"] / 5.0,
        components["link-factor"],
        np.clip(components["evidence-tag-class"] / 25.0, -4.0, 4.0),
        np.clip(components["full"] / 25.0, -4.0, 4.0),
        np.clip(subtree_chars / page_chars, 0.0, 1.0),
    ]).astype(np.float64)


def expand_ranges(ranges: list[list[int]], total: int) -> np.ndarray:
    mask = np.zeros(total, dtype=bool)
    for start, end in ranges:
        start = int(start)
        end = int(end)
        if start < 0 or end < start or end > total:
            raise ValueError(f"invalid provenance range [{start}, {end})/{total}")
        mask[start:end] = True
    return mask


def teacher_from_candidate(
    key: str,
    descriptor: dict,
    provenance: dict,
    source_tree: dict,
    page,
) -> Teacher | None:
    if not descriptor.get("available") or not descriptor.get("output"):
        return None
    if page.status != "extract":
        return None
    quality = float(descriptor.get("metrics", {}).get("mainNgramF1", 0.0))
    if quality <= 0.0:
        return None
    exact = provenance.get("exact") is True
    positive_only = (
        provenance.get("status") == "positive-only"
        and provenance.get("unmatchedUnitSemantics") == "unknown"
    )
    if not exact and not positive_only:
        return None
    unit_count = len(source_tree["textUnits"])
    selected = expand_ranges(
        provenance.get("retainedRanges" if exact else "positiveRanges", []),
        unit_count,
    )
    known = np.zeros(len(page.tokens), dtype=bool)
    keep = np.zeros(len(page.tokens), dtype=bool)
    for index, element in enumerate(source_tree["treeElements"]):
        if page.tokens[index] <= 0:
            continue
        unit_ids = [int(value) for value in element.get("sourceUnitIds", [])]
        if not unit_ids:
            continue
        states = selected[unit_ids]
        if exact:
            if np.all(states == states[0]):
                known[index] = True
                keep[index] = bool(states[0])
        elif np.all(states):
            # Positive-only provenance never turns an unmatched source unit
            # into a negative label.  A partially mapped own-text node is
            # therefore unknown, not kept.
            known[index] = True
            keep[index] = True
    evidence_tokens = float(page.tokens[known].sum())
    coverage = evidence_tokens / max(1.0, float(page.tokens.sum()))
    if not evidence_tokens:
        return None
    return Teacher(key, exact, quality, known, keep, coverage)


def choose_product_teacher(
    internal: dict,
    current_output: dict,
    teachers: dict[str, Teacher],
) -> Teacher | None:
    target = normalize_text(current_output.get("sourceText", ""))
    if not target:
        return None
    candidates = []
    for descriptor in internal["candidates"]:
        teacher = teachers.get(descriptor["key"])
        if teacher is None:
            continue
        source = normalize_text((descriptor.get("output") or {}).get("sourceText", ""))
        if source == target:
            candidates.append(teacher)
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda item: (item.exact, item.coverage, item.quality, item.key),
    )


def unique_ensemble_teachers(internal: dict, teachers: dict[str, Teacher]) -> list[Teacher]:
    groups: dict[str, list[Teacher]] = {}
    for descriptor in internal["candidates"]:
        key = descriptor["key"]
        if key not in PROVENANCE_KEYS or key not in teachers:
            continue
        output = normalize_text((descriptor.get("output") or {}).get("sourceText", ""))
        if not output:
            continue
        groups.setdefault(output, []).append(teachers[key])
    return [
        max(values, key=lambda item: (item.exact, item.coverage, item.quality, item.key))
        for values in groups.values()
    ]


def load_pages(
    args,
    *,
    directory: Path | None = None,
    allowed_splits: frozenset[str] = frozenset({"base", "train"}),
) -> tuple[list[DistillPage], dict]:
    directory = directory or args.zh_units
    paths = sorted(directory.glob("*.json.gz"))
    if not paths:
        raise ValueError(f"no Chinese units in {directory}")
    pages = []
    skipped = []
    coverage = Counter()
    for path in paths:
        old = read_gzip(path)
        if old.get("split") not in allowed_splits:
            raise ValueError(f"{old.get('id')}: refusing Chinese split {old.get('split')}")
        internal_path = args.provenance / f"{old['id']}.json"
        current_path = args.current_outputs / f"{old['id']}.json"
        if not internal_path.exists() or not current_path.exists():
            raise ValueError(f"{old['id']}: candidate provenance/current output missing")
        internal = json.loads(internal_path.read_text(encoding="utf8"))
        try:
            page = current_page(old, internal)
            source_tree = internal["benchmarkDiagnostics"]["provenance"]["sourceTree"]
            provenance = internal["benchmarkDiagnostics"]["provenance"]["candidates"]
            descriptors = {item["key"]: item for item in internal["candidates"]}
            teachers = {}
            for key in (*PROVENANCE_KEYS, "treedp"):
                teacher = teacher_from_candidate(
                    key, descriptors[key], provenance[key], source_tree, page
                )
                if teacher is not None:
                    teachers[key] = teacher
                    coverage[f"{key}:{'exact' if teacher.exact else 'positive'}"] += 1
            current_output = json.loads(current_path.read_text(encoding="utf8"))
            product_teacher = choose_product_teacher(internal, current_output, teachers)
            if product_teacher is not None:
                coverage[
                    f"product:{'exact' if product_teacher.exact else 'positive'}"
                ] += 1
            current_tree = source_tree["treeElements"]
        except ValueError as error:
            if "coordinate" not in str(error):
                raise
            # Candidate provenance is optional training evidence.  A stale or
            # incompatible coordinate must not silently remove an otherwise
            # valid human-gold page from OOF evaluation.
            skipped.append({"id": old["id"], "reason": str(error)})
            page = TRAINER.page_from_record(old, set(allowed_splits))
            teachers = {}
            product_teacher = None
            current_tree = old["tree"]["treeElements"]
        product_available = bool(internal.get("productCurrent", {}).get("available"))
        product_f1 = (
            float(internal["productCurrent"]["metrics"]["mainNgramF1"])
            if product_available and page.status == "extract"
            else 0.0
        )
        item = READABILITY.StudyPage(
            page=page,
            context=READABILITY.context_features(
                {"tree": {"treeElements": current_tree}}, page
            ),
            corpus="zh",
        )
        pages.append(DistillPage(
            item=item,
            rich_context=rich_context(current_tree, page),
            product_teacher=product_teacher,
            ensemble_teachers=unique_ensemble_teachers(internal, teachers),
            product_f1=product_f1,
            product_available=product_available,
        ))
    return pages, {"skipped": skipped, "teacherCoverage": dict(coverage)}


def load_wcxb_pages(directory: Path) -> list[object]:
    """Load WCXB with the same rich feature computation as Chinese pages."""
    base = READABILITY.load_study_pages(directory, "wcxb")
    records = {
        path.name.removesuffix(".json.gz"): read_gzip(path)
        for path in directory.glob("*.json.gz")
    }
    result = []
    for item in base:
        record = records.get(item.page.id)
        if record is None:
            raise ValueError(f"{item.page.id}: WCXB source record is missing")
        tree = record["tree"]["treeElements"]
        result.append(READABILITY.StudyPage(
            page=item.page,
            context=rich_context(tree, item.page),
            corpus="wcxb",
        ))
    return result


def context_for(item, variant: str) -> np.ndarray:
    return item.item.context if variant == "v7" else item.rich_context


def teacher_list(item: DistillPage, variant: str) -> list[Teacher]:
    if variant == "product":
        return [] if item.product_teacher is None else [item.product_teacher]
    if variant == "ensemble":
        return item.ensemble_teachers
    return []


def fit_increment(
    zh_pages: list[DistillPage],
    wcxb_pages: list[object],
    variant: str,
    args,
) -> np.ndarray:
    dimensions = 2 if variant == "v7" else len(RICH_FEATURE_NAMES)
    matrices = []
    labels = []
    offsets = []
    weights = []

    human_rows = []
    human_total = 0.0
    for item in zh_pages:
        page = item.item.page
        selected = (page.tokens > 0) & page.gold_known
        if not np.any(selected):
            continue
        values = context_for(item, variant)[selected]
        token_weight = page.tokens[selected]
        human_rows.append((values, page.gold_keep[selected].astype(float), page, selected, token_weight))
        human_total += float(token_weight.sum())
    wcxb_total = sum(
        float(item.page.tokens[(item.page.tokens > 0) & item.page.gold_known].sum())
        for item in wcxb_pages
    )
    for item in wcxb_pages:
        page = item.page
        selected = (page.tokens > 0) & page.gold_known
        if not np.any(selected):
            continue
        values = item.context[selected, :2] if variant == "v7" else item.context[selected]
        token_weight = page.tokens[selected]
        matrices.append(values)
        labels.append(page.gold_keep[selected].astype(float))
        offsets.append((
            TRAINER.CURRENT_THETA[0] + page.features @ TRAINER.CURRENT_THETA[1:]
        )[selected])
        weights.append(token_weight * args.wcxb_corpus_weight / max(1.0, wcxb_total))

    for values, target, page, selected, token_weight in human_rows:
        matrices.append(values)
        labels.append(target)
        offsets.append((
            TRAINER.CURRENT_THETA[0] + page.features @ TRAINER.CURRENT_THETA[1:]
        )[selected])
        weights.append(token_weight / max(1.0, human_total))

    auxiliary = []
    auxiliary_total = 0.0
    if variant in {"product", "ensemble"} and args.teacher_weight > 0:
        for item in zh_pages:
            page = item.item.page
            values = item.rich_context
            for teacher in teacher_list(item, variant):
                selected = (page.tokens > 0) & teacher.known
                if not np.any(selected):
                    continue
                token_weight = page.tokens[selected] * teacher.quality
                if not float(token_weight.sum()):
                    continue
                auxiliary.append((
                    values[selected],
                    teacher.keep[selected].astype(float),
                    (TRAINER.CURRENT_THETA[0] + page.features @ TRAINER.CURRENT_THETA[1:])[selected],
                    token_weight,
                ))
                auxiliary_total += float(token_weight.sum())
    for values, target, offset, token_weight in auxiliary:
        matrices.append(values)
        labels.append(target)
        offsets.append(offset)
        weights.append(
            token_weight * args.teacher_weight / max(1.0, auxiliary_total)
        )

    matrix = np.concatenate(matrices)
    label = np.concatenate(labels)
    offset = np.concatenate(offsets)
    weight = np.concatenate(weights)

    def objective(beta: np.ndarray) -> tuple[float, np.ndarray]:
        logit = offset + matrix @ beta
        probability = 1.0 / (1.0 + np.exp(-np.clip(logit, -50.0, 50.0)))
        loss = float(np.sum(weight * (np.logaddexp(0.0, logit) - label * logit)))
        loss += 0.5 * args.regularization * float(beta @ beta)
        gradient = matrix.T @ (weight * (probability - label)) + args.regularization * beta
        return loss, gradient

    result = minimize(
        objective,
        np.zeros(dimensions, dtype=np.float64),
        jac=True,
        method="L-BFGS-B",
        options={"maxiter": 300, "ftol": 1e-12, "gtol": 1e-9},
    )
    if not result.success:
        raise RuntimeError(f"{variant} fit failed: {result.message}")
    return np.asarray(result.x, dtype=np.float64)


def decode(item: DistillPage, beta: np.ndarray, variant: str, root_weight: float):
    study = READABILITY.StudyPage(
        page=item.item.page,
        context=context_for(item, variant),
        corpus="zh",
    )
    return READABILITY.decode(study, beta, root_weight)


def row(item: DistillPage, result, baseline) -> dict:
    page = item.item.page
    baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
    candidate_text = TRAINER.materialized_text(page, result.mask) if result.available else ""
    baseline_f1 = TRAINER.trigram_f1(baseline_text, page.reference) if page.status == "extract" else 0.0
    candidate_f1 = TRAINER.trigram_f1(candidate_text, page.reference) if page.status == "extract" else 0.0
    product_score = item.product_f1 if page.status == "extract" else 0.0
    return {
        "id": page.id,
        "siteFamily": page.site_family,
        "split": page.split,
        "status": page.status,
        "baseline": baseline_f1,
        "candidate": candidate_f1,
        "delta": candidate_f1 - baseline_f1,
        "product": product_score,
        "deltaVsProduct": candidate_f1 - product_score,
        "baselineAvailable": baseline.available,
        "candidateAvailable": result.available,
        "productAvailable": item.product_available,
        "baselineRoots": baseline.roots,
        "candidateRoots": result.roots,
    }


def summarize(rows: list[dict]) -> dict:
    extract = [value for value in rows if value["status"] == "extract"]
    deltas = [value["delta"] for value in extract]
    product_deltas = [value["deltaVsProduct"] for value in extract]
    excludes = [value for value in rows if value["status"] == "exclude"]
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "baselineMeanF1": float(np.mean([value["baseline"] for value in extract])),
        "candidateMeanF1": float(np.mean([value["candidate"] for value in extract])),
        "meanDelta": float(np.mean(deltas)),
        "wins": sum(value > 1e-9 for value in deltas),
        "ties": sum(abs(value) <= 1e-9 for value in deltas),
        "losses": sum(value < -1e-9 for value in deltas),
        "worst": min(deltas, default=0.0),
        "regressionsBelowMinusPointOne": sum(value < -0.1 for value in deltas),
        "regressionsBelowMinusPointTwo": sum(value < -0.2 for value in deltas),
        "meanDeltaVsProduct": float(np.mean(product_deltas)),
        "worstVsProduct": min(product_deltas, default=0.0),
        "regressionsVsProductBelowMinusPointOne": sum(
            value < -0.1 for value in product_deltas
        ),
        "regressionsVsProductBelowMinusPointTwo": sum(
            value < -0.2 for value in product_deltas
        ),
        "baselineExcludeFalsePositives": sum(value["baselineAvailable"] for value in excludes),
        "candidateExcludeFalsePositives": sum(value["candidateAvailable"] for value in excludes),
        "worstPages": sorted(extract, key=lambda value: value["delta"])[:20],
        "worstVsProductPages": sorted(
            extract, key=lambda value: value["deltaVsProduct"]
        )[:20],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--current-outputs", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--root-weight", type=float, default=0.25)
    parser.add_argument("--teacher-weight", type=float, default=0.15)
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    pages, audit = load_pages(args)
    wcxb = (
        load_wcxb_pages(args.wcxb_units)
        if args.wcxb_units else []
    )
    wcxb_train = [item for item in wcxb if item.page.split == "wcxb-train"]
    indices = np.arange(len(pages))
    groups = np.asarray([item.item.page.site_family for item in pages])
    variants = ("v7", "rich", "product", "ensemble")
    rows = {variant: [] for variant in variants}
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        fitted = {
            variant: fit_increment(train, wcxb_train, variant, args)
            for variant in variants
        }
        fold_report = {"fold": fold, "variants": {}}
        baselines = {
            item.item.page.id: TRAINER.decode(item.item.page, TRAINER.CURRENT_THETA)
            for item in test
        }
        for variant in variants:
            fold_rows = [
                row(
                    item,
                    decode(item, fitted[variant], variant, args.root_weight),
                    baselines[item.item.page.id],
                )
                for item in test
            ]
            rows[variant].extend(fold_rows)
            fold_report["variants"][variant] = {
                "beta": fitted[variant].tolist(),
                "summary": summarize(fold_rows),
            }
        folds.append(fold_report)
        print(json.dumps({
            "fold": fold,
            "summaries": {
                key: value["summary"] for key, value in fold_report["variants"].items()
            },
        }, ensure_ascii=False), flush=True)

    report = {
        "schema": "qingzhou.tree-dp-candidate-distillation-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "runtimeCandidateGeneration": False,
            "runtimeModel": "single-linear-block-scorer-plus-tree-dp",
            "candidateEvidence": "training-only-exact-or-positive-only-tristate",
            "unknownEvidence": "skipped-not-negative",
            "duplicateCandidateAnswers": "one-strongest-provenance-representative",
            "zhValidationOpened": False,
            "zhTestOpened": False,
            "wcxbTestOpened": False,
            "featureNames": RICH_FEATURE_NAMES,
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "audit": audit,
        "siteFamilyOof": {
            "variants": {
                variant: {"summary": summarize(values), "rows": values}
                for variant, values in rows.items()
            },
            "folds": folds,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "readabilityStudySha256": TRAINER.sha256_file(READABILITY_PATH),
            "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(args.output),
        "audit": audit,
        "summaries": {
            key: summarize(value) for key, value in rows.items()
        },
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
