#!/usr/bin/env python3
"""Conservative pairwise reranker evaluation for the 1,500-page protocol.

Implements the protocol in docs/benchmarks.md#evaluate-article-extraction:
- pairwise ridge trained on within-page feature differences against the real
  product output (incumbent), equal total weight per page, duplicates removed;
- switch only when the best challenger's predicted gain exceeds a
  validation-selected threshold and deterministic safety gates pass;
- site-grouped learning curves (nested 200/400/600/800 subsets, balanced
  resamples, same validation set) with coefficient stability;
- the frozen 400-page test shard is evaluated once, and only when the
  readiness criteria hold; otherwise the report says the test stays closed.

Site, host, URL, page type, selector, timing, and gold-derived values are
never model features.
"""

import argparse
import json
import math
import random
import unicodedata
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge

FEATURES = (
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
    "lengthRank",
    "relativeToLongest",
    "meanPeerNgramF1",
    "maxPeerNgramF1",
    "duplicateGroupSize",
)
LOG_FEATURES = {
    "chars",
    "paragraphCount",
    "headingCount",
    "tableCount",
    "listItemCount",
    "imageCount",
    "linkCount",
    "topLevelBlocks",
    "averageBlockChars",
}

# Boundary-risk features comparing the challenger's text against the incumbent
# (product) text. All are computable at inference time and use no gold data.
PAIR_FEATURES = (
    "retainShare",   # share of incumbent 3-grams kept by the challenger
    "keptShare",     # share of challenger 3-grams that also exist in the incumbent
    "headRetain",    # share of the incumbent head (first 250 chars) kept
    "tailRetain",    # share of the incumbent tail (last 250 chars) kept
    "logLenRatio",   # log length ratio challenger/incumbent
)


def normalized_text(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = "".join(ch for ch in text if ch not in "\u200b\u200c\u200d\u200e\u200f\ufeff")
    return " ".join(text.split())


def gram_set(text: str, size: int = 3) -> set:
    if len(text) < size:
        return {text} if text else set()
    return {text[i:i + size] for i in range(len(text) - size + 1)}


def candidate_text(candidate: dict) -> str:
    output = candidate.get("output")
    if isinstance(output, dict):
        return normalized_text(output.get("text") or output.get("markdown") or "")
    return normalized_text(output or "")


def pair_features(challenger: dict, incumbent: dict, cache: dict) -> np.ndarray:
    pair_key = (challenger.get("key") or id(challenger), incumbent.get("key") or id(incumbent))
    memo = cache.setdefault("_pairs", {})
    if pair_key in memo:
        return memo[pair_key]

    def grams_of(entry):
        key = entry.get("key") or id(entry)
        if key not in cache:
            text = candidate_text(entry)
            cache[key] = (text, gram_set(text))
        return cache[key]

    ch_text, ch_grams = grams_of(challenger)
    inc_text, inc_grams = grams_of(incumbent)
    overlap = len(ch_grams & inc_grams)
    retain = overlap / max(1, len(inc_grams))
    kept = overlap / max(1, len(ch_grams))
    head = gram_set(inc_text[:250])
    tail = gram_set(inc_text[-250:])
    head_retain = len(head & ch_grams) / max(1, len(head))
    tail_retain = len(tail & ch_grams) / max(1, len(tail))
    log_len = math.log((len(ch_text) + 1) / (len(inc_text) + 1))
    result = np.array([retain, kept, head_retain, tail_retain, log_len], dtype=np.float64)
    memo[pair_key] = result
    return result


def pair_vector(challenger: dict, incumbent: dict, cache: dict) -> np.ndarray:
    return np.concatenate([
        feature_vector(challenger) - feature_vector(incumbent),
        pair_features(challenger, incumbent, cache),
    ])


def feature_vector(candidate: dict) -> np.ndarray:
    raw = candidate.get("features") or {}
    row = []
    for name in FEATURES:
        value = raw.get(name)
        if isinstance(value, bool):
            value = 1.0 if value else 0.0
        value = float(value) if value is not None else 0.0
        if name in LOG_FEATURES:
            value = math.log1p(max(0.0, value))
        row.append(value)
    return np.array(row, dtype=np.float64)


def gold_f1(entry: dict):
    metrics = entry.get("metrics") or {}
    return metrics.get("mainNgramF1")


def load_dataset(dataset_path: Path, manifest_path: Path) -> list[dict]:
    split_by_id = {}
    for sample in json.loads(manifest_path.read_text("utf-8"))["samples"]:
        split_by_id[sample["id"]] = sample.get("evaluationSplit") or "base"
    pages = []
    for line in dataset_path.read_text("utf-8").split("\n"):
        if not line.strip():
            continue
        rec = json.loads(line)
        rec["evaluationSplit"] = split_by_id[rec["id"]]
        candidates = []
        for cand in rec.get("candidates", []):
            if not cand.get("available") or cand.get("duplicateOf"):
                continue
            candidates.append(cand)
        rec["usableCandidates"] = candidates
        pc = rec.get("productCurrent") or {}
        incumbent = None
        pf1 = gold_f1(pc)
        pchars = pc.get("outputChars")
        for cand in candidates:
            cf1 = gold_f1(cand)
            if rec.get("goldStatus") == "extract":
                if (cand.get("outputChars") == pchars and cf1 is not None
                        and pf1 is not None and abs(cf1 - pf1) < 1e-9):
                    incumbent = cand
                    break
            elif cand.get("outputChars") == pchars:
                incumbent = cand
                break
        rec["incumbent"] = incumbent
        pages.append(rec)
    return pages


def build_pairs(pages: list[dict]):
    """Within-page (challenger - incumbent) feature diffs with equal page weight."""
    xs, ys, ws = [], [], []
    for rec in pages:
        if rec.get("goldStatus") != "extract":
            continue
        inc = rec.get("incumbent")
        if inc is None:
            continue
        inc_f1 = gold_f1(inc)
        if inc_f1 is None:
            continue
        cache = rec.setdefault("_grams", {})
        challengers = [c for c in rec["usableCandidates"]
                       if c is not inc and gold_f1(c) is not None]
        if not challengers:
            continue
        weight = 1.0 / len(challengers)
        for cand in challengers:
            xs.append(pair_vector(cand, inc, cache))
            ys.append(gold_f1(cand) - inc_f1)
            ws.append(weight)
    return np.array(xs), np.array(ys), np.array(ws)


class PairwiseRidge:
    def __init__(self, alpha: float = 1.0):
        self.alpha = alpha
        self.mean = None
        self.scale = None
        self.model = None

    def fit(self, xs, ys, ws):
        self.mean = xs.mean(axis=0)
        self.scale = xs.std(axis=0)
        self.scale[self.scale < 1e-12] = 1.0
        self.model = Ridge(alpha=self.alpha, fit_intercept=False)
        self.model.fit((xs - self.mean) / self.scale, ys, sample_weight=ws)
        return self

    def predict(self, xs):
        return self.model.predict((xs - self.mean) / self.scale)

    @property
    def coef(self):
        return self.model.coef_.copy()


class PairwiseGBM:
    """Small tree ensemble on the same pairwise diffs; nonlinear capacity probe."""

    def __init__(self, seed: int = 0):
        self.seed = seed
        self.model = None

    def fit(self, xs, ys, ws):
        self.model = HistGradientBoostingRegressor(
            max_depth=3, max_iter=200, learning_rate=0.06, random_state=self.seed)
        self.model.fit(xs, ys, sample_weight=ws)
        return self

    def predict(self, xs):
        return self.model.predict(np.asarray(xs))

    coef = None


def deterministic_gate(candidate: dict) -> bool:
    features = candidate.get("features") or {}
    if features.get("dirty"):
        return False
    if not candidate.get("outputChars"):
        return False
    return True


def apply_policy(model: PairwiseRidge, pages: list[dict], threshold: float):
    """Return per-page decisions for extract pages: (current F1, selected F1, switched, site)."""
    rows = []
    for rec in pages:
        if rec.get("goldStatus") != "extract":
            continue
        cur_f1 = gold_f1(rec.get("productCurrent") or {})
        if cur_f1 is None:
            continue
        inc = rec.get("incumbent")
        selected_f1, switched, chosen = cur_f1, False, "product-current"
        if inc is not None:
            cache = rec.setdefault("_grams", {})
            best_gain, best = 0.0, None
            for cand in rec["usableCandidates"]:
                if cand is inc or gold_f1(cand) is None:
                    continue
                if not deterministic_gate(cand):
                    continue
                gain = float(model.predict(pair_vector(cand, inc, cache).reshape(1, -1))[0])
                if gain > best_gain:
                    best_gain, best = gain, cand
            if best is not None and best_gain > threshold:
                selected_f1, switched, chosen = gold_f1(best), True, best.get("strategy")
        rows.append({
            "id": rec["id"],
            "siteId": rec["siteId"],
            "current": cur_f1,
            "selected": selected_f1,
            "switched": switched,
            "chosen": chosen,
        })
    return rows


def percentile(values, ratio):
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round((len(ordered) - 1) * ratio))]


def bottom_share_mean(values, share=0.05):
    if not values:
        return 0.0
    ordered = sorted(values)
    count = max(1, round(len(ordered) * share))
    return sum(ordered[:count]) / count


def site_macro(rows, key):
    per_site = defaultdict(list)
    for row in rows:
        per_site[row["siteId"]].append(row[key])
    return sum(sum(v) / len(v) for v in per_site.values()) / max(1, len(per_site))


def summarize_policy(rows):
    switches = [r for r in rows if r["switched"]]
    deltas = [r["selected"] - r["current"] for r in switches]
    improved = sum(1 for d in deltas if d > 1e-9)
    regressed = sum(1 for d in deltas if d < -1e-9)
    return {
        "pages": len(rows),
        "sites": len({r["siteId"] for r in rows}),
        "currentPageMacroF1": sum(r["current"] for r in rows) / max(1, len(rows)),
        "selectedPageMacroF1": sum(r["selected"] for r in rows) / max(1, len(rows)),
        "currentSiteMacroF1": site_macro(rows, "current"),
        "selectedSiteMacroF1": site_macro(rows, "selected"),
        "switches": len(switches),
        "switchedSites": len({r["siteId"] for r in switches}),
        "improvedSwitches": improved,
        "regressedSwitches": regressed,
        "switchPrecision": improved / len(switches) if switches else None,
        "worstSwitchDelta": min(deltas) if deltas else 0.0,
        "meanSwitchDelta": sum(deltas) / len(deltas) if deltas else 0.0,
        "currentP10": percentile([r["current"] for r in rows], 0.10),
        "selectedP10": percentile([r["selected"] for r in rows], 0.10),
        "currentBottom5Mean": bottom_share_mean([r["current"] for r in rows]),
        "selectedBottom5Mean": bottom_share_mean([r["selected"] for r in rows]),
    }


def safety_gates(summary, minimum_switches, minimum_sites):
    checks = {
        "enoughSwitches": summary["switches"] >= minimum_switches,
        "enoughSwitchedSites": summary["switchedSites"] >= minimum_sites,
        "switchPrecision>=0.80": (summary["switchPrecision"] or 0.0) >= 0.80,
        "wins>=4xLosses": summary["improvedSwitches"] >= 4 * max(1, summary["regressedSwitches"])
        if summary["regressedSwitches"] else summary["improvedSwitches"] > 0,
        "worstSwitch>-0.10": summary["worstSwitchDelta"] > -0.10,
        "noSwitchLoses>=0.20": summary["worstSwitchDelta"] > -0.20,
        "p10NonInferior(0.002)": summary["selectedP10"] >= summary["currentP10"] - 0.002,
        "bottom5NotWorse": summary["selectedBottom5Mean"] >= summary["currentBottom5Mean"] - 1e-9,
        "siteMacroImproves": summary["selectedSiteMacroF1"] > summary["currentSiteMacroF1"],
        "pageMacroImproves>=0.005": summary["selectedPageMacroF1"] - summary["currentPageMacroF1"] >= 0.005,
    }
    return checks, all(checks.values())


def exclude_false_positives(model, pages, threshold):
    current_fp, selected_fp, considered = 0, 0, 0
    for rec in pages:
        if rec.get("goldStatus") != "exclude":
            continue
        considered += 1
        pc = rec.get("productCurrent") or {}
        cur_non_empty = bool(pc.get("nonEmpty") or pc.get("outputChars"))
        current_fp += 1 if cur_non_empty else 0
        inc = rec.get("incumbent")
        sel_non_empty = cur_non_empty
        if inc is not None:
            cache = rec.setdefault("_grams", {})
            best_gain, best = 0.0, None
            for cand in rec["usableCandidates"]:
                if cand is inc or not deterministic_gate(cand):
                    continue
                gain = float(model.predict(pair_vector(cand, inc, cache).reshape(1, -1))[0])
                if gain > best_gain:
                    best_gain, best = gain, cand
            if best is not None and best_gain > threshold:
                sel_non_empty = bool(best.get("outputChars"))
        selected_fp += 1 if sel_non_empty else 0
    return {"pages": considered, "currentFalsePositives": current_fp,
            "selectedFalsePositives": selected_fp}


def site_groups(pages):
    groups = defaultdict(list)
    for rec in pages:
        groups[rec["siteId"]].append(rec)
    return groups


def sample_subset(groups, target_pages, rng):
    names = list(groups.keys())
    rng.shuffle(names)
    subset, total = [], 0
    for name in names:
        subset.extend(groups[name])
        total += len(groups[name])
        if total >= target_pages:
            break
    return subset


def cosine(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-12 or nb < 1e-12:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def learning_curves(train_pages, validation_pages, sizes, resamples, make_model, seed):
    groups = site_groups(train_pages)
    curve = []
    coefs_by_size = defaultdict(list)
    for size in sizes:
        deltas = []
        for resample in range(resamples):
            rng = random.Random(seed * 1000 + size * 17 + resample)
            subset = sample_subset(groups, size, rng)
            xs, ys, ws = build_pairs(subset)
            if len(xs) < 50:
                continue
            model = make_model().fit(xs, ys, ws)
            rows = apply_policy(model, validation_pages, threshold=0.0)
            summary = summarize_policy(rows)
            deltas.append(summary["selectedPageMacroF1"] - summary["currentPageMacroF1"])
            if getattr(model, "coef", None) is not None:
                coefs_by_size[size].append(model.coef)
        mean = sum(deltas) / len(deltas) if deltas else None
        curve.append({
            "trainPages": size,
            "resamples": len(deltas),
            "meanValidationDelta": mean,
            "minValidationDelta": min(deltas) if deltas else None,
            "maxValidationDelta": max(deltas) if deltas else None,
            "stdValidationDelta": (sum((d - mean) ** 2 for d in deltas) / len(deltas)) ** 0.5
            if deltas else None,
        })
    stability = {}
    for size, coefs in coefs_by_size.items():
        sims = [cosine(coefs[i], coefs[j])
                for i in range(len(coefs)) for j in range(i + 1, len(coefs))]
        stability[str(size)] = {
            "meanPairwiseCosine": sum(sims) / len(sims) if sims else None,
            "minPairwiseCosine": min(sims) if sims else None,
        }
    return curve, stability


def readiness(curve, stability, train_pages, linear=True):
    by_size = {item["trainPages"]: item for item in curve}
    gain = None
    upper = None
    if 600 in by_size and 800 in by_size and by_size[600]["meanValidationDelta"] is not None:
        gain = by_size[800]["meanValidationDelta"] - by_size[600]["meanValidationDelta"]
        upper = by_size[800]["maxValidationDelta"] - by_size[600]["minValidationDelta"]
    # Stability is measured at 600 pages: the 800-page "resamples" are identical
    # (the full training shard), so their agreement carries no information.
    top_cosine = (stability.get("600") or {}).get("meanPairwiseCosine")
    delta_std_600 = (by_size.get(600) or {}).get("stdValidationDelta")
    gain_sites = set()
    gain_pages = 0
    for rec in train_pages:
        if rec.get("goldStatus") != "extract":
            continue
        cur = gold_f1(rec.get("productCurrent") or {})
        if cur is None:
            continue
        best = max((gold_f1(c) or 0.0) for c in rec["usableCandidates"]) if rec["usableCandidates"] else 0.0
        if best - cur >= 0.03:
            gain_pages += 1
            gain_sites.add(rec["siteId"])
    checks = {
        "curveGain600to800<0.001": gain is not None and gain < 0.001,
        "curveGainUpperBound<0.002": upper is not None and upper < 0.002,
        "gainPages>=300": gain_pages >= 300,
        "gainSiteGroups>=80": len(gain_sites) >= 80,
    }
    if linear:
        checks["coefficientCosineAt600>0.95"] = top_cosine is not None and top_cosine > 0.95
    else:
        checks["validationDeltaStdAt600<0.005"] = delta_std_600 is not None and delta_std_600 < 0.005
    return {
        "checks": checks,
        "allPassed": all(checks.values()),
        "curveGain600to800": gain,
        "curveGainUpperResampleBound": upper,
        "coefficientCosineAt600": top_cosine,
        "validationDeltaStdAt600": delta_std_600,
        "trainPagesWithGain>=0.03": gain_pages,
        "trainSiteGroupsWithGain": len(gain_sites),
    }


def site_cluster_bootstrap(rows, iterations, seed):
    per_site = defaultdict(list)
    for row in rows:
        per_site[row["siteId"]].append(row["selected"] - row["current"])
    names = list(per_site.keys())
    rng = random.Random(seed)
    means = []
    for _ in range(iterations):
        picked = [per_site[names[rng.randrange(len(names))]] for _ in names]
        flat = [d for group in picked for d in group]
        means.append(sum(flat) / len(flat))
    means.sort()
    return means[max(0, int(len(means) * 0.05) - 1)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--alpha", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=20260814)
    parser.add_argument("--resamples", type=int, default=10)
    parser.add_argument("--open-test", action="store_true",
                        help="Evaluate the frozen test shard when readiness and validation gates pass")
    args = parser.parse_args()

    pages = load_dataset(Path(args.dataset), Path(args.manifest))
    train = [p for p in pages if p["evaluationSplit"] in ("base", "train")]
    validation = [p for p in pages if p["evaluationSplit"] == "validation"]
    test = [p for p in pages if p["evaluationSplit"] == "test"]

    anchored = sum(1 for p in pages if p.get("goldStatus") == "extract" and p.get("incumbent") is not None)
    extract_total = sum(1 for p in pages if p.get("goldStatus") == "extract")

    xs, ys, ws = build_pairs(train)
    models = {
        "ridge": PairwiseRidge(alpha=args.alpha).fit(xs, ys, ws),
        "gbm": PairwiseGBM(seed=args.seed).fit(xs, ys, ws),
    }

    thresholds = [round(t * 0.005, 3) for t in range(0, 61)]
    scans = {}
    chosen = None
    for name, model in models.items():
        scan = []
        feasible = []
        for threshold in thresholds:
            rows = apply_policy(model, validation, threshold)
            summary = summarize_policy(rows)
            checks, passed = safety_gates(summary, minimum_switches=30, minimum_sites=15)
            entry = {"model": name, "threshold": threshold, "summary": summary,
                     "gates": checks, "feasible": passed}
            scan.append(entry)
            if passed:
                feasible.append(entry)
        scans[name] = scan
        best = max(feasible, key=lambda e: e["summary"]["selectedPageMacroF1"]) if feasible else None
        if best and (chosen is None
                     or best["summary"]["selectedPageMacroF1"] > chosen["summary"]["selectedPageMacroF1"]):
            chosen = best

    curve_model = chosen["model"] if chosen else "ridge"
    factories = {
        "ridge": lambda: PairwiseRidge(alpha=args.alpha),
        "gbm": lambda: PairwiseGBM(seed=args.seed),
    }
    curve, stability = learning_curves(
        train, validation, sizes=(200, 400, 600, 800),
        resamples=args.resamples, make_model=factories[curve_model], seed=args.seed)
    ready = readiness(curve, stability, train, linear=curve_model == "ridge")

    report = {
        "schema": "qingzhou.article-extraction-conservative-reranker.v2",
        "dataset": str(Path(args.dataset).resolve()),
        "model": {"kinds": list(models), "alpha": args.alpha,
                  "features": list(FEATURES), "pairFeatures": list(PAIR_FEATURES),
                  "logFeatures": sorted(LOG_FEATURES)},
        "splits": {"train": len(train), "validation": len(validation), "test": len(test)},
        "incumbentAnchoring": {"extractPages": extract_total, "anchored": anchored,
                               "coverage": anchored / max(1, extract_total)},
        "trainingPairs": len(xs),
        "validationThresholdScan": {
            name: [
                {"threshold": e["threshold"],
                 "delta": e["summary"]["selectedPageMacroF1"] - e["summary"]["currentPageMacroF1"],
                 "switches": e["summary"]["switches"],
                 "switchPrecision": e["summary"]["switchPrecision"],
                 "worstSwitchDelta": e["summary"]["worstSwitchDelta"],
                 "feasible": e["feasible"]}
                for e in scan]
            for name, scan in scans.items()},
        "selectedModel": chosen["model"] if chosen else None,
        "selectedThreshold": chosen["threshold"] if chosen else None,
        "validationAtSelectedThreshold": chosen["summary"] if chosen else None,
        "validationGatesAtSelectedThreshold": chosen["gates"] if chosen else None,
        "learningCurveModel": curve_model,
        "learningCurve": curve,
        "coefficientStability": stability,
        "readiness": ready,
        "frozenTest": {"opened": False,
                       "reason": "readiness or validation feasibility not satisfied, or --open-test not passed"},
    }

    if chosen and ready["allPassed"] and args.open_test:
        model = models[chosen["model"]]
        rows = apply_policy(model, test, chosen["threshold"])
        summary = summarize_policy(rows)
        checks, passed = safety_gates(summary, minimum_switches=50, minimum_sites=30)
        lower = site_cluster_bootstrap(rows, iterations=2000, seed=args.seed)
        fp = exclude_false_positives(model, test, chosen["threshold"])
        report["frozenTest"] = {
            "opened": True,
            "threshold": chosen["threshold"],
            "summary": summary,
            "gates": checks,
            "bootstrapDeltaLowerBound95": lower,
            "bootstrapGate>0": lower > 0,
            "excludeFalsePositives": fp,
            "excludeFalsePositivesNotWorse": fp["selectedFalsePositives"] <= fp["currentFalsePositives"],
            "allGatesPassed": passed and lower > 0
            and fp["selectedFalsePositives"] <= fp["currentFalsePositives"],
        }

    Path(args.output).write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n", "utf-8")

    print(f"train/validation/test = {len(train)}/{len(validation)}/{len(test)}")
    print(f"incumbent anchoring: {anchored}/{extract_total} = {anchored / max(1, extract_total):.3f}")
    print(f"training pairs: {len(xs)}")
    if chosen:
        s = chosen["summary"]
        print(f"selected: {chosen['model']} @ threshold {chosen['threshold']}"
              f" (validation delta {s['selectedPageMacroF1'] - s['currentPageMacroF1']:+.4f},"
              f" switches {s['switches']}, precision {s['switchPrecision']:.2f},"
              f" worst {s['worstSwitchDelta']:+.4f})")
    else:
        print("no feasible threshold on validation: conservative switching cannot pass the safety gates")
    print("readiness:", json.dumps(ready["checks"]))
    print("frozen test opened:", report["frozenTest"]["opened"])
    if report["frozenTest"].get("opened"):
        s = report["frozenTest"]["summary"]
        print(f"TEST delta {s['selectedPageMacroF1'] - s['currentPageMacroF1']:+.4f},"
              f" switches {s['switches']} across {s['switchedSites']} sites,"
              f" precision {s['switchPrecision']}, worst {s['worstSwitchDelta']:+.4f},"
              f" bootstrap lower {report['frozenTest']['bootstrapDeltaLowerBound95']:+.4f},"
              f" all gates {report['frozenTest']['allGatesPassed']}")
    print("report:", args.output)


if __name__ == "__main__":
    main()
