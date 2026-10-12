#!/usr/bin/env python3
"""Site-disjoint evaluation for Qingzhou's internal article candidates.

This is benchmark code only. It never imports into the extension and never uses
site, URL, selector, or benchmark page-type fields as model features.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pickle
import statistics
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


CANDIDATE_SETS = {
    "core": ("rules", "readability"),
    "all": ("rules", "readability", "paragraph", "baseline", "recall", "treedp"),
}
INTRINSIC_FEATURES = (
    "chars",
    "pageShare",
    "paragraphCount",
    "headingCount",
    "tableCount",
    "listItemCount",
    "imageCount",
    "linkCount",
    "linkTextShare",
    "topLevelBlocks",
    "averageBlockChars",
    "shortBlockShare",
    "longBlockShare",
    "cjkShare",
    "sentenceMarksPerK",
    "repeatedContentScore",
    "dirty",
)
SET_FEATURES = (
    "setCandidateCount",
    "setLengthRank",
    "setRelativeToLongest",
    "setMeanPeerNgramF1",
    "setMaxPeerNgramF1",
    "setDuplicateGroupSize",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate candidate rerankers with site-disjoint folds and a frozen increment holdout.",
    )
    parser.add_argument("--dataset", required=True, help="Gold-scored internal-candidates.jsonl")
    parser.add_argument("--output", required=True, help="JSON report path")
    parser.add_argument("--seed", type=int, default=20260814)
    return parser.parse_args()


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * ratio))]


def load_pages(path: Path) -> list[dict]:
    pages = []
    # Split on real newlines only: JSON strings may legally contain unescaped
    # U+2028/U+2029, which str.splitlines() would treat as line boundaries.
    for line_number, line in enumerate(path.read_text("utf-8").split("\n"), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if value.get("goldStatus") not in {"extract", "exclude"}:
            continue
        if not value.get("id") or not value.get("siteId"):
            raise ValueError(f"line {line_number}: extract page requires id and siteId")
        if value.get("goldSplit") not in {"base", "increment"}:
            raise ValueError(f"line {line_number}: gold page requires base or increment goldSplit")
        raw_candidates = value.get("candidates", [])
        candidates = []
        for candidate in raw_candidates:
            metrics = candidate.get("metrics")
            if not candidate.get("available") or (value.get("goldStatus") == "extract" and not metrics):
                continue
            candidates.append(candidate)
        pages.append({
            **value,
            "candidates": candidates,
            "allCandidates": raw_candidates,
            "lineNumber": line_number,
        })
    if not pages:
        raise ValueError("dataset contains no gold-scored pages")
    return pages


def extract_pages(pages: list[dict]) -> list[dict]:
    return [page for page in pages if page["goldStatus"] == "extract"]


def normalized_text(value: object) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(character for character in text if character not in "\u200b\u200c\u200d\u200e\u200f\ufeff")
    return " ".join(text.split()).strip()


def ngram_f1(left: str, right: str, size: int = 3, limit: int = 80_000) -> float:
    def counts(value: str) -> Counter:
        text = normalized_text(value)[:limit]
        return Counter(text[index:index + size] for index in range(max(0, len(text) - size + 1)))

    actual = counts(left)
    expected = counts(right)
    actual_total = sum(actual.values())
    expected_total = sum(expected.values())
    overlap = sum(min(count, expected.get(gram, 0)) for gram, count in actual.items())
    precision = overlap / actual_total if actual_total else 0.0
    recall = overlap / expected_total if expected_total else 0.0
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def numeric(value: object) -> float:
    if not isinstance(value, (int, float, bool)):
        return 0.0
    result = float(value)
    return result if math.isfinite(result) else 0.0


def selectable_candidates(page: dict, keys: tuple[str, ...]) -> list[dict]:
    return [
        candidate
        for candidate in page["candidates"]
        if candidate.get("key") in keys and isinstance(candidate.get("features"), dict)
    ]


def feature_names(keys: tuple[str, ...]) -> list[str]:
    return [
        *(f"candidate:{key}" for key in keys),
        *(f"feature:{name}" for name in (*INTRINSIC_FEATURES, *SET_FEATURES)),
    ]


def build_feature_table(pages: list[dict], keys: tuple[str, ...]) -> dict[tuple[int, str], dict[str, float]]:
    table = {}
    for page in pages:
        candidates = selectable_candidates(page, keys)
        lengths = {
            candidate["key"]: numeric(candidate.get("outputChars") or candidate["features"].get("chars"))
            for candidate in candidates
        }
        longest = max(lengths.values(), default=0.0)
        texts = {
            candidate["key"]: normalized_text((candidate.get("output") or {}).get("text"))
            for candidate in candidates
        }
        similarities = defaultdict(list)
        for left_index, left in enumerate(candidates):
            for right in candidates[left_index + 1:]:
                score = ngram_f1(texts[left["key"]], texts[right["key"]])
                similarities[left["key"]].append(score)
                similarities[right["key"]].append(score)
        duplicate_counts = Counter(texts.values())
        for candidate in candidates:
            key = candidate["key"]
            values = {
                name: numeric(candidate["features"].get(name))
                for name in INTRINSIC_FEATURES
            }
            peers = similarities[key]
            values.update({
                "setCandidateCount": float(len(candidates)),
                "setLengthRank": float(1 + sum(length > lengths[key] for length in lengths.values())),
                "setRelativeToLongest": lengths[key] / longest if longest else 0.0,
                "setMeanPeerNgramF1": mean(peers),
                "setMaxPeerNgramF1": max(peers, default=0.0),
                "setDuplicateGroupSize": float(duplicate_counts[texts[key]]),
            })
            table[(page["lineNumber"], key)] = values
    return table


def rows_for_pages(
    pages: list[dict],
    keys: tuple[str, ...],
    names: list[str],
    feature_table: dict[tuple[int, str], dict[str, float]],
    require_targets: bool = True,
):
    rows, targets, owners, candidates = [], [], [], []
    for page_index, page in enumerate(pages):
        if require_targets and page["goldStatus"] != "extract":
            continue
        for candidate in selectable_candidates(page, keys):
            key = candidate["key"]
            values = feature_table.get((page["lineNumber"], key))
            if values is None:
                continue
            row = []
            for name in names:
                if name.startswith("candidate:"):
                    row.append(float(key == name.split(":", 1)[1]))
                else:
                    row.append(values[name.split(":", 1)[1]])
            rows.append(row)
            if require_targets:
                targets.append(float(candidate["metrics"]["mainNgramF1"]))
            owners.append(page_index)
            candidates.append(candidate)
    return rows, targets, owners, candidates


def current_candidate(page: dict) -> dict | None:
    strategy = page.get("currentStrategy", "")
    available = page["candidates"]
    exact = next((candidate for candidate in available if candidate.get("strategy") == strategy), None)
    if exact:
        return exact
    prefixes = {
        "rules-recall": "recall",
        "paragraph-rescue": "paragraph",
        "readability": "readability",
        "rules": "rules",
    }
    key = prefixes.get(strategy, "baseline" if strategy.startswith("baseline-") else "")
    return next((candidate for candidate in available if candidate["key"] == key), None)


def product_current(page: dict) -> dict | None:
    current = page.get("productCurrent")
    if isinstance(current, dict):
        return {"key": "product-current", **current}
    return current_candidate(page)


def resolve_selection(pages: list[dict], choices: dict[int, dict], keys: tuple[str, ...]):
    selected = dict(choices)
    eligible = fallback = unscored = 0
    for page_index, page in enumerate(pages):
        candidates = selectable_candidates(page, keys)
        if candidates:
            eligible += 1
            if page_index not in selected:
                unscored += 1
            continue
        current = product_current(page)
        if current:
            selected[page_index] = current
            fallback += 1
        else:
            unscored += 1
    total = len(pages)
    return selected, {
        "populationPages": total,
        "extractPages": len(extract_pages(pages)),
        "excludePages": sum(page["goldStatus"] == "exclude" for page in pages),
        "rerankEligiblePages": eligible,
        "rerankSelectedPages": sum(index in choices for index in range(total)),
        "rerankCoverage": eligible / total if total else 0.0,
        "fallbackToCurrentPages": fallback,
        "unscoredPages": unscored,
    }


def aggregate_selection(pages: list[dict], selected: dict[int, dict], keys: tuple[str, ...]) -> dict:
    selected_f1, selected_precision, selected_recall = [], [], []
    oracle_f1, current_f1, regrets = [], [], []
    improved = regressed = oracle_ties = 0
    selected_keys = Counter()
    for page_index, page in enumerate(pages):
        if page["goldStatus"] != "extract":
            continue
        if page_index not in selected:
            continue
        candidates = selectable_candidates(page, keys)
        choice = selected[page_index]
        oracle = max(candidates, key=lambda candidate: candidate["metrics"]["mainNgramF1"]) if candidates else None
        current = product_current(page)
        score = float(choice["metrics"]["mainNgramF1"])
        selected_f1.append(score)
        selected_precision.append(float(choice["metrics"]["mainNgramPrecision"]))
        selected_recall.append(float(choice["metrics"]["mainNgramRecall"]))
        selected_keys[choice["key"]] += 1
        if current and isinstance(current.get("metrics"), dict):
            baseline = float(current["metrics"]["mainNgramF1"])
            current_f1.append(baseline)
            improved += int(score > baseline + 1e-12)
            regressed += int(score + 1e-12 < baseline)
        if oracle:
            upper = float(oracle["metrics"]["mainNgramF1"])
            oracle_f1.append(upper)
            regrets.append(max(0.0, upper - score))
            oracle_ties += int(abs(score - upper) <= 1e-12)
    count = len(selected_f1)
    return {
        "populationPages": len(extract_pages(pages)),
        "scoredPages": count,
        "mainNgramPrecision": mean(selected_precision),
        "mainNgramRecall": mean(selected_recall),
        "mainNgramF1": mean(selected_f1),
        "p10PageF1": percentile(selected_f1, 0.10),
        "currentMainNgramF1": mean(current_f1),
        "currentComparablePages": len(current_f1),
        "oracleMainNgramF1": mean(oracle_f1),
        "oracleComparablePages": len(oracle_f1),
        "meanOracleRegret": mean(regrets),
        "oracleTies": oracle_ties,
        "improvedVsCurrent": improved,
        "regressedVsCurrent": regressed,
        "selectedCandidateCounts": dict(sorted(selected_keys.items())),
    }


def observed_candidate_cost(pages: list[dict], keys: tuple[str, ...]) -> dict:
    totals = []
    per_candidate = defaultdict(list)
    for page in pages:
        elapsed = []
        for candidate in page["allCandidates"]:
            if candidate.get("key") not in keys:
                continue
            value = candidate.get("elapsedMs")
            if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                continue
            value = float(value)
            elapsed.append(value)
            per_candidate[candidate["key"]].append(value)
        if elapsed:
            totals.append(sum(elapsed))
    return {
        "note": "sum of isolated candidate-body timings; excludes shared setup and raw Readability parsing, so it is diagnostic rather than end-to-end or additive latency",
        "observedPages": len(totals),
        "meanTotalMs": mean(totals),
        "p95TotalMs": percentile(totals, 0.95),
        "byCandidateMeanMs": {key: mean(values) for key, values in sorted(per_candidate.items())},
    }


def model_factories(seed: int):
    try:
        from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
        from sklearn.linear_model import Ridge
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler
        from sklearn.tree import DecisionTreeRegressor
    except ImportError as error:
        raise RuntimeError("scikit-learn is required for reranker evaluation") from error

    factories = {
        "ridge": lambda: make_pipeline(StandardScaler(), Ridge(alpha=3.0)),
        "decisionTree": lambda: DecisionTreeRegressor(
            max_depth=5,
            min_samples_leaf=12,
            random_state=seed,
        ),
        "randomForest": lambda: RandomForestRegressor(
            n_estimators=240,
            max_depth=5,
            min_samples_leaf=8,
            max_features=0.8,
            n_jobs=1,
            random_state=seed,
        ),
        "histGradientBoosting": lambda: HistGradientBoostingRegressor(
            max_iter=160,
            learning_rate=0.05,
            max_leaf_nodes=7,
            min_samples_leaf=15,
            l2_regularization=2.0,
            random_state=seed,
        ),
    }
    try:
        from lightgbm import LGBMRegressor

        factories["lightGBM"] = lambda: LGBMRegressor(
            n_estimators=180,
            learning_rate=0.04,
            num_leaves=7,
            max_depth=3,
            min_child_samples=15,
            subsample=0.9,
            colsample_bytree=0.9,
            reg_lambda=2.0,
            verbosity=-1,
            n_jobs=1,
            deterministic=True,
            force_col_wise=True,
            random_state=seed,
        )
    except ImportError:
        pass
    return factories


def fit_predict(
    factory,
    train_pages: list[dict],
    test_pages: list[dict],
    keys: tuple[str, ...],
    names: list[str],
    feature_table: dict[tuple[int, str], dict[str, float]],
):
    import numpy

    train_x, train_y, _, _ = rows_for_pages(train_pages, keys, names, feature_table)
    test_x, _, test_owners, test_candidates = rows_for_pages(
        test_pages,
        keys,
        names,
        feature_table,
        require_targets=False,
    )
    if not train_x:
        raise ValueError(f"training split has no usable candidates for {keys}")
    started = time.perf_counter()
    model = factory()
    model.fit(numpy.asarray(train_x, dtype=float), numpy.asarray(train_y, dtype=float))
    fit_ms = (time.perf_counter() - started) * 1_000
    started = time.perf_counter()
    predictions = model.predict(numpy.asarray(test_x, dtype=float)) if test_x else []
    predict_ms = (time.perf_counter() - started) * 1_000
    selected = {}
    selected_scores = {}
    for owner, candidate, score in zip(test_owners, test_candidates, predictions):
        if owner not in selected_scores or score > selected_scores[owner]:
            selected_scores[owner] = float(score)
            selected[owner] = candidate
    return selected, {
        "fitMs": fit_ms,
        "predictMs": predict_ms,
        "trainCandidateRows": len(train_x),
        "testCandidateRows": len(test_x),
        "predictUsPerCandidate": predict_ms * 1_000 / len(test_x) if test_x else 0.0,
        "pickleBytes": len(pickle.dumps(model, protocol=pickle.HIGHEST_PROTOCOL)),
    }


def group_folds(pages: list[dict], splits: int):
    from sklearn.model_selection import GroupKFold

    groups = [page.get("siteId") or page["id"] for page in pages]
    unique = len(set(groups))
    count = min(splits, unique)
    if count < 2:
        raise ValueError("site-disjoint evaluation requires at least two sites")
    return GroupKFold(n_splits=count).split(pages, groups=groups)


def evaluate_choices(pages: list[dict], choices: dict[int, dict], keys: tuple[str, ...]) -> dict:
    selected, coverage = resolve_selection(pages, choices, keys)
    return {
        "metrics": aggregate_selection(pages, selected, keys),
        "coverage": coverage,
        "excludeFalsePositive": aggregate_exclude_false_positives(pages, selected),
    }


def candidate_is_non_empty(candidate: dict | None) -> bool | None:
    if not candidate:
        return None
    if isinstance(candidate.get("nonEmpty"), bool):
        return candidate["nonEmpty"]
    output = candidate.get("output")
    if not isinstance(output, dict):
        return None
    return bool(normalized_text(output.get("text")) or normalized_text(output.get("markdown")))


def aggregate_exclude_false_positives(pages: list[dict], selected: dict[int, dict]) -> dict:
    current_known = selected_known = current_fp = selected_fp = 0
    jointly_known = current_joint_fp = selected_joint_fp = 0
    for page_index, page in enumerate(pages):
        if page["goldStatus"] != "exclude":
            continue
        current_non_empty = candidate_is_non_empty(product_current(page))
        selected_non_empty = candidate_is_non_empty(selected.get(page_index))
        if current_non_empty is not None:
            current_known += 1
            current_fp += int(current_non_empty)
        if selected_non_empty is not None:
            selected_known += 1
            selected_fp += int(selected_non_empty)
        if current_non_empty is not None and selected_non_empty is not None:
            jointly_known += 1
            current_joint_fp += int(current_non_empty)
            selected_joint_fp += int(selected_non_empty)
    return {
        "populationPages": sum(page["goldStatus"] == "exclude" for page in pages),
        "currentKnownPages": current_known,
        "currentFalsePositivePages": current_fp,
        "selectedKnownPages": selected_known,
        "selectedFalsePositivePages": selected_fp,
        "jointlyKnownPages": jointly_known,
        "currentJointFalsePositivePages": current_joint_fp,
        "selectedJointFalsePositivePages": selected_joint_fp,
        "jointFalsePositiveDelta": selected_joint_fp - current_joint_fp,
    }


def subset_choices(pages: list[dict], choices: dict[int, dict], indices: list[int]):
    return [pages[index] for index in indices], {
        subset_index: choices[page_index]
        for subset_index, page_index in enumerate(indices)
        if page_index in choices
    }


def evaluate_model(
    factory,
    pages: list[dict],
    keys: tuple[str, ...],
    names: list[str],
    feature_table: dict[tuple[int, str], dict[str, float]],
    folds: int = 5,
):
    selected = {}
    runtime = []
    fold_sites = []
    for train_indices, test_indices in group_folds(pages, folds):
        train = extract_pages([pages[index] for index in train_indices])
        test = [pages[index] for index in test_indices]
        choices, timing = fit_predict(factory, train, test, keys, names, feature_table)
        selected.update({int(test_indices[index]): choice for index, choice in choices.items()})
        runtime.append(timing)
        fold_sites.append({
            "train": len({page["siteId"] for page in train}),
            "test": len({page["siteId"] for page in test}),
        })
    total_predict_ms = sum(item["predictMs"] for item in runtime)
    total_test_rows = sum(item["testCandidateRows"] for item in runtime)
    return {
        **evaluate_choices(pages, selected, keys),
        "fitMs": sum(item["fitMs"] for item in runtime),
        "predictMs": total_predict_ms,
        "testCandidateRows": total_test_rows,
        "predictUsPerCandidate": total_predict_ms * 1_000 / total_test_rows if total_test_rows else 0.0,
        "maxPickleBytes": max(item["pickleBytes"] for item in runtime),
        "foldSites": fold_sites,
    }


def evaluate_candidate_set(pages: list[dict], keys: tuple[str, ...], factories: dict) -> dict:
    names = feature_names(keys)
    feature_table = build_feature_table(pages, keys)
    base = [page for page in pages if page.get("goldSplit") == "base"]
    increment = [page for page in pages if page.get("goldSplit") == "increment"]
    if not base or not increment:
        raise ValueError("dataset must contain both base and increment gold splits")
    report = {
        "candidates": list(keys),
        "features": names,
        "observedCandidateCost": observed_candidate_cost(pages, keys),
        "modelSizeNote": "pickleBytes is the measured Python evaluation artifact, not a projected production JavaScript payload",
        "siteOverlap": sorted({page["siteId"] for page in base} & {page["siteId"] for page in increment}),
        "splitUsage": {
            "baseSiteGroupCV": "model selection diagnostic on original base pages",
            "incrementFrozenHoldout": "primary untouched evaluation; do not tune from this result and then continue to call it frozen",
            "incrementUnseenSiteHoldout": "strict subset of the frozen increment whose siteId is absent from base",
            "combinedSiteGroupCV": "post-hoc robustness diagnostic only; it trains on increment pages and is not a frozen-holdout score",
        },
        "models": {},
    }
    base_sites = {page["siteId"] for page in base}
    unseen_increment_indices = [
        index for index, page in enumerate(increment)
        if page["siteId"] not in base_sites
    ]
    for name, factory in factories.items():
        base_cv = evaluate_model(factory, base, keys, names, feature_table)
        choices, runtime = fit_predict(factory, extract_pages(base), increment, keys, names, feature_table)
        increment_holdout = {
            **evaluate_choices(increment, choices, keys),
            **runtime,
        }
        unseen_pages, unseen_choices = subset_choices(increment, choices, unseen_increment_indices)
        unseen_increment = evaluate_choices(unseen_pages, unseen_choices, keys)
        unseen_increment["sites"] = len({page["siteId"] for page in unseen_pages})
        combined_cv = evaluate_model(factory, pages, keys, names, feature_table)
        report["models"][name] = {
            "baseSiteGroupCV": base_cv,
            "incrementFrozenHoldout": increment_holdout,
            "incrementUnseenSiteHoldout": unseen_increment,
            "combinedSiteGroupCV": combined_cv,
        }
    return report


def main() -> None:
    arguments = parse_args()
    dataset = Path(arguments.dataset).resolve()
    output = Path(arguments.output).resolve()
    pages = load_pages(dataset)
    factories = model_factories(arguments.seed)
    report = {
        "schema": "qingzhou.article-extraction-reranker-eval.v2",
        "dataset": str(dataset),
        "pages": len(pages),
        "extractPages": len(extract_pages(pages)),
        "excludePages": sum(page["goldStatus"] == "exclude" for page in pages),
        "sites": len({page["siteId"] for page in pages}),
        "splits": dict(Counter(page.get("goldSplit", "") for page in pages)),
        "featurePolicy": {
            "included": "fixed allowlist of candidate key, generic structure/text features, and agreement features recomputed within each candidate set",
            "excluded": ["site", "host", "URL", "selector", "benchmark page type", "gold metrics", "candidate timing", "features from candidates outside the evaluated set"],
        },
        "candidateSets": {
            name: evaluate_candidate_set(pages, keys, factories)
            for name, keys in CANDIDATE_SETS.items()
        },
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(f"{output.suffix}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({
        "output": str(output),
        "pages": report["pages"],
        "sites": report["sites"],
        "models": list(factories),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
