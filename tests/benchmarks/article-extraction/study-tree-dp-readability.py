#!/usr/bin/env python3
"""Evaluate small Readability-derived corrections to the shipped Tree-DP.

The shipped 16-D scorer remains a fixed offset.  This study learns only two
path-context coefficients, keeps the exact production recurrence, and
adds Readability's pre-link-density candidate score as an ``asRoot`` prior.
Chinese site-family OOF is the primary development result.  Optional WCXB dev
training contributes a fixed 0.15 corpus weight; its domain-grouped holdout is
reported but never fitted.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from sklearn.model_selection import GroupKFold


HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import tree_dp_training_core as TRAINER  # noqa: E402
FEATURE_NAMES = [
    "readabilityClassAncestorNetCapped3",
    "readabilityUnlikelyAncestor",
]
WCXB_MIN_REQUIRED_BLOCK_COVERAGE = 0.8


@dataclass
class StudyPage:
    page: object
    context: np.ndarray
    corpus: str


@dataclass
class StudyDecode:
    mask: np.ndarray
    roots: list[int]
    available: bool
    retained_tokens: int


def read_record(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf8") as handle:
        return json.load(handle)


def context_features(record: dict, page) -> np.ndarray:
    tree = record["tree"]["treeElements"]
    own_class = np.asarray([
        float(element.get("readabilityClassWeight", 0.0)) / 25.0
        for element in tree
    ], dtype=np.float64)
    unlikely = np.asarray([
        float(bool(element.get("readabilityUnlikely"))) for element in tree
    ], dtype=np.float64)
    ancestor_class = own_class.copy()
    ancestor_unlikely = unlikely.copy()
    for index in range(1, len(tree)):
        parent = page.parent[index]
        ancestor_class[index] += ancestor_class[parent]
        ancestor_unlikely[index] = max(ancestor_unlikely[index], ancestor_unlikely[parent])
    return np.column_stack([
        np.clip(ancestor_class, -3.0, 3.0),
        ancestor_unlikely,
    ])


def load_study_pages(
    directory: Path,
    corpus: str,
    *,
    allowed_zh_splits: frozenset[str] = frozenset({"base", "train"}),
) -> list[StudyPage]:
    paths = sorted(directory.glob("*.json.gz"))
    if not paths:
        raise ValueError(f"no training pages in {directory}")
    export_report_path = directory / "export-report.json"
    if not export_report_path.exists():
        raise ValueError(f"training export is incomplete: {export_report_path} is missing")
    export_report = json.loads(export_report_path.read_text(encoding="utf8"))
    expected_schema = (
        "qingzhou.article-extraction-tree-dp-training-export.v2"
        if corpus == "zh"
        else "qingzhou.wcxb-tree-dp-training-export.v1"
    )
    if export_report.get("schema") != expected_schema:
        raise ValueError(f"unexpected {corpus} export schema: {export_report.get('schema')}")
    if export_report.get("exported") != len(paths):
        raise ValueError(
            f"training export file count mismatch: {len(paths)} != {export_report.get('exported')}"
        )
    result: list[StudyPage] = []
    for path in paths:
        record = read_record(path)
        if record.get("sourceSha256") != export_report.get("sourceSha256"):
            raise ValueError(f"{record.get('id')}: source provenance differs from export report")
        original_split = record.get("split")
        if corpus == "zh":
            if original_split not in allowed_zh_splits:
                raise ValueError(f"{record.get('id')}: refusing Chinese split {original_split}")
        elif original_split not in {"wcxb-train", "wcxb-holdout"}:
            raise ValueError(f"{record.get('id')}: refusing WCXB split {original_split}")
        if corpus == "wcxb":
            gold = record.get("gold", {})
            required = int(gold.get("requiredBlocks", 0))
            aligned = int(gold.get("requiredBlocksAligned", -1))
            if required <= 0 or aligned < 0 or aligned > required:
                raise ValueError(f"{record.get('id')}: incomplete WCXB block-quality evidence")
            if aligned / required < WCXB_MIN_REQUIRED_BLOCK_COVERAGE:
                continue
        page = TRAINER.page_from_record(record, {original_split})
        result.append(StudyPage(
            page=page,
            context=context_features(record, page),
            corpus=corpus,
        ))
    return result


def source_fingerprints(pages: list[StudyPage]) -> list[dict]:
    unique = {
        json.dumps(item.page.source_sha256, sort_keys=True, separators=(",", ":"))
        for item in pages
    }
    return [json.loads(value) for value in sorted(unique)]


def fit_increment(
    zh_pages: list[StudyPage],
    wcxb_pages: list[StudyPage],
    *,
    regularization: float,
    wcxb_corpus_weight: float,
) -> np.ndarray:
    groups = [(zh_pages, 1.0)]
    if wcxb_pages and wcxb_corpus_weight:
        groups.append((wcxb_pages, wcxb_corpus_weight))
    matrices = []
    labels = []
    offsets = []
    weights = []
    for pages, corpus_weight in groups:
        fit_pages = [item for item in pages if item.page.status == "extract"]
        corpus_tokens = sum(
            float(item.page.tokens[item.page.tokens > 0].sum())
            for item in fit_pages
        )
        if not corpus_tokens:
            continue
        for item in fit_pages:
            page = item.page
            selected = page.tokens > 0
            if not np.any(selected):
                continue
            matrices.append(item.context[selected])
            labels.append(page.gold_keep[selected].astype(np.float64))
            offsets.append((
                TRAINER.CURRENT_THETA[0]
                + page.features @ TRAINER.CURRENT_THETA[1:]
            )[selected])
            weights.append(page.tokens[selected] * corpus_weight / corpus_tokens)
    matrix = np.concatenate(matrices)
    label = np.concatenate(labels)
    offset = np.concatenate(offsets)
    weight = np.concatenate(weights)

    def objective(beta: np.ndarray) -> tuple[float, np.ndarray]:
        logit = offset + matrix @ beta
        probability = 1.0 / (1.0 + np.exp(-np.clip(logit, -50.0, 50.0)))
        loss = float(np.sum(weight * (np.logaddexp(0.0, logit) - label * logit)))
        loss += 0.5 * regularization * float(beta @ beta)
        gradient = matrix.T @ (weight * (probability - label)) + regularization * beta
        return loss, gradient

    fitted = minimize(
        objective,
        np.zeros(len(FEATURE_NAMES), dtype=np.float64),
        jac=True,
        method="L-BFGS-B",
        options={"maxiter": 300, "ftol": 1e-12, "gtol": 1e-9},
    )
    if not fitted.success:
        raise RuntimeError(f"Readability increment fit failed: {fitted.message}")
    return np.asarray(fitted.x, dtype=np.float64)


def readability_scope_prior(page) -> np.ndarray:
    """Collapse Readability's candidate promotion to one structural root hint.

    The signal is computed from DOM features only.  Unlike Readability it does
    not materialize or score a competing answer; Tree-DP still owns every
    keep/carve decision below the hinted scope.
    """
    scores = page.readability_root_scores["full"]
    evidence = page.readability_root_scores["evidence"]
    candidates = sorted(
        (int(index) for index in np.flatnonzero((evidence > 0) & (scores > 0))),
        key=lambda index: (-float(scores[index]), index),
    )[:5]
    prior = np.zeros(len(page.tokens), dtype=np.float64)
    if not candidates:
        return prior
    primary = candidates[0]
    corroborating = []
    for candidate in candidates[1:]:
        if scores[candidate] / scores[primary] < 0.75:
            continue
        ancestors = set()
        ancestor = int(page.parent[candidate])
        while ancestor >= 0:
            ancestors.add(ancestor)
            ancestor = int(page.parent[ancestor])
        corroborating.append(ancestors)
    if len(corroborating) >= 3:
        ancestor = int(page.parent[primary])
        while ancestor >= 0 and page.tags[ancestor] != "body":
            if sum(ancestor in values for values in corroborating) >= 3:
                primary = ancestor
                break
            ancestor = int(page.parent[ancestor])

    last_score = float(scores[primary]) if evidence[primary] > 0 else 0.0
    threshold = last_score / 3.0
    ancestor = int(page.parent[primary])
    while ancestor >= 0 and page.tags[ancestor] != "body":
        if evidence[ancestor] > 0:
            score = float(scores[ancestor])
            if score < threshold:
                break
            if score > last_score:
                primary = ancestor
                break
            last_score = score
        ancestor = int(page.parent[ancestor])
    ancestor = int(page.parent[primary])
    while (
        ancestor >= 0
        and page.tags[ancestor] != "body"
        and len(page.children[ancestor]) == 1
    ):
        primary = ancestor
        ancestor = int(page.parent[primary])
    scope = int(page.parent[primary])
    if scope < 0:
        scope = primary
    prior[scope] = max(0.0, float(scores[primary]))
    return prior


def decode(
    item: StudyPage,
    beta: np.ndarray,
    root_weight: float,
    root_prior_mode: str = "raw",
) -> StudyDecode:
    page = item.page
    total = len(page.tokens)
    local = page.tokens * (
        TRAINER.CURRENT_THETA[0]
        + page.features @ TRAINER.CURRENT_THETA[1:]
        + item.context @ beta
    )
    raw_root_score = page.readability_root_scores["evidence-tag-class"]
    if root_prior_mode == "scope":
        root_score = readability_scope_prior(page)
    elif root_prior_mode == "hybrid":
        root_score = np.maximum(raw_root_score, readability_scope_prior(page))
    else:
        root_score = raw_root_score
    keep = np.zeros(total, dtype=np.float64)
    plain_free = np.zeros(total, dtype=np.float64)
    prior_free = np.zeros(total, dtype=np.float64)
    keep_choice: list[list[bool]] = [[] for _ in range(total)]
    plain_root = np.zeros(total, dtype=bool)
    # -2 selects this node as the one root receiving the page-level
    # Readability prior; -1 reuses the plain solution; otherwise the value is
    # the single child subtree that receives the prior budget.
    prior_mode = np.full(total, -1, dtype=np.int64)
    for index in range(total - 1, -1, -1):
        kept = float(local[index])
        choices = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            kept += keep[child] if retain else excluded
            choices.append(bool(retain))
        keep[index] = kept
        keep_choice[index] = choices
        descend = sum(plain_free[child] for child in page.children[index])
        # A dependent HTML node is not a complete materializable fragment on
        # its own.  Exclude it from the DP feasible set instead of allowing it
        # to win globally and discarding the whole solution afterwards.
        root_allowed = page.tags[index] not in TRAINER.DEPENDENT_ROOT_TAGS
        as_root = kept - TRAINER.ROOT_PENALTY if root_allowed else -np.inf
        if as_root >= descend and as_root > 0:
            plain_free[index] = as_root
            plain_root[index] = True
        else:
            plain_free[index] = max(0.0, descend)

        # Readability scores one primary candidate.  Model that page-level
        # evidence with a single reusable DP budget instead of rewarding every
        # disconnected root and accidentally encouraging fragmentation.
        prior_free[index] = plain_free[index]
        prior_as_root = as_root + root_weight * root_score[index]
        if prior_as_root >= prior_free[index] and prior_as_root > 0:
            prior_free[index] = prior_as_root
            prior_mode[index] = -2
        for child in page.children[index]:
            child_prior = descend - plain_free[child] + prior_free[child]
            if child_prior > prior_free[index] + 1e-12:
                prior_free[index] = child_prior
                prior_mode[index] = child

    retained = np.zeros(total, dtype=bool)
    roots: list[int] = []
    stack = [(0, True)]
    while stack:
        index, use_prior = stack.pop()
        mode = prior_mode[index] if use_prior else -1
        select_root = mode == -2 or (mode == -1 and plain_root[index])
        if select_root:
            roots.append(index)
            keep_stack = [index]
            while keep_stack:
                current = keep_stack.pop()
                retained[current] = True
                for offset, child in enumerate(page.children[current]):
                    if keep_choice[current][offset]:
                        keep_stack.append(child)
        else:
            prior_child = mode if use_prior and mode >= 0 else None
            stack.extend(
                (child, child == prior_child)
                for child in page.children[index]
            )
    retained_tokens = int(page.tokens[retained].sum())
    available = retained_tokens >= TRAINER.MIN_RETAINED_TOKENS and not any(
        page.tags[root] in TRAINER.DEPENDENT_ROOT_TAGS for root in roots
    )
    return StudyDecode(retained, roots, available, retained_tokens)


def score_rows(
    pages: list[StudyPage],
    beta_for_page: dict[str, np.ndarray],
    root_weight: float,
    root_prior_mode: str = "raw",
) -> tuple[list[dict], dict[str, StudyDecode]]:
    rows = []
    decodes = {}
    for item in pages:
        page = item.page
        baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
        candidate = decode(
            item,
            beta_for_page[page.id],
            root_weight,
            root_prior_mode,
        )
        baseline_text = TRAINER.materialized_text(page, baseline.mask) if baseline.available else ""
        candidate_text = TRAINER.materialized_text(page, candidate.mask) if candidate.available else ""
        baseline_f1 = TRAINER.trigram_f1(baseline_text, page.reference)
        candidate_f1 = TRAINER.trigram_f1(candidate_text, page.reference)
        rows.append({
            "id": page.id,
            "siteFamily": page.site_family,
            "split": page.split,
            "status": page.status,
            "baseline": baseline_f1,
            "candidate": candidate_f1,
            "delta": candidate_f1 - baseline_f1,
            "baselineAvailable": baseline.available,
            "candidateAvailable": candidate.available,
        })
        decodes[page.id] = candidate
    return rows, decodes


def summarize(rows: list[dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    deltas = [row["delta"] for row in extract]
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "meanDelta": float(np.mean(deltas)) if deltas else 0.0,
        "wins": sum(delta > 1e-9 for delta in deltas),
        "ties": sum(abs(delta) <= 1e-9 for delta in deltas),
        "losses": sum(delta < -1e-9 for delta in deltas),
        "worst": min(deltas, default=0.0),
        "regressionsBelowMinusPointOne": sum(delta < -0.1 for delta in deltas),
        "regressionsBelowMinusPointTwo": sum(delta < -0.2 for delta in deltas),
        "baselineExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["baselineAvailable"] for row in rows
        ),
        "candidateExcludeFalsePositives": sum(
            row["status"] == "exclude" and row["candidateAvailable"] for row in rows
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zh-units", required=True, type=Path)
    parser.add_argument("--wcxb-units", type=Path)
    parser.add_argument("--zh-validation-units", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--masks-output", type=Path)
    parser.add_argument("--wcxb-masks-output", type=Path)
    parser.add_argument("--validation-masks-output", type=Path)
    parser.add_argument("--include-unchanged-masks", action="store_true")
    parser.add_argument("--regularization", type=float, default=10.0)
    parser.add_argument("--root-weight", type=float, default=0.25)
    parser.add_argument(
        "--root-prior-mode",
        choices=("raw", "scope", "hybrid"),
        default="raw",
    )
    parser.add_argument("--wcxb-corpus-weight", type=float, default=0.15)
    parser.add_argument("--folds", type=int, default=5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    zh_pages = load_study_pages(args.zh_units, "zh")
    zh_validation = load_study_pages(
        args.zh_validation_units,
        "zh",
        allowed_zh_splits=frozenset({"validation"}),
    ) if args.zh_validation_units else []
    wcxb_pages = load_study_pages(args.wcxb_units, "wcxb") if args.wcxb_units else []
    wcxb_train = [item for item in wcxb_pages if item.page.split == "wcxb-train"]
    wcxb_holdout = [item for item in wcxb_pages if item.page.split == "wcxb-holdout"]
    groups = np.asarray([item.page.site_family for item in zh_pages])
    indices = np.arange(len(zh_pages))
    splitter = GroupKFold(n_splits=args.folds)
    beta_for_zh: dict[str, np.ndarray] = {}
    fold_reports = []
    for fold, (train_indices, test_indices) in enumerate(splitter.split(indices, groups=groups), 1):
        train_pages = [zh_pages[int(index)] for index in train_indices]
        test_pages = [zh_pages[int(index)] for index in test_indices]
        beta = fit_increment(
            train_pages,
            wcxb_train,
            regularization=args.regularization,
            wcxb_corpus_weight=args.wcxb_corpus_weight,
        )
        for item in test_pages:
            beta_for_zh[item.page.id] = beta
        rows, _ = score_rows(
            test_pages,
            {item.page.id: beta for item in test_pages},
            args.root_weight,
            args.root_prior_mode,
        )
        fold_reports.append({
            "fold": fold,
            "trainPages": len(train_pages),
            "testPages": len(test_pages),
            "testSiteFamilies": len({item.page.site_family for item in test_pages}),
            "beta": beta.tolist(),
            "summary": summarize(rows),
        })
    oof_rows, oof_decodes = score_rows(
        zh_pages,
        beta_for_zh,
        args.root_weight,
        args.root_prior_mode,
    )

    final_beta = fit_increment(
        zh_pages,
        wcxb_train,
        regularization=args.regularization,
        wcxb_corpus_weight=args.wcxb_corpus_weight,
    )
    final_rows, _ = score_rows(
        zh_pages,
        {item.page.id: final_beta for item in zh_pages},
        args.root_weight,
        args.root_prior_mode,
    )
    validation_rows = []
    validation_decodes = {}
    if zh_validation:
        validation_rows, validation_decodes = score_rows(
            zh_validation,
            {item.page.id: final_beta for item in zh_validation},
            args.root_weight,
            args.root_prior_mode,
        )
    holdout_rows = []
    holdout_decodes = {}
    if wcxb_holdout:
        holdout_rows, holdout_decodes = score_rows(
            wcxb_holdout,
            {item.page.id: final_beta for item in wcxb_holdout},
            args.root_weight,
            args.root_prior_mode,
        )
    report = {
        "schema": "qingzhou.tree-dp-readability-study.v1",
        "protocol": {
            "featureNames": FEATURE_NAMES,
            "baseScorer": "shipped-v6b-fixed-offset",
            "fitStatuses": ["extract"],
            "recurrence": "shipped-keep-carve-descend",
            "rootFeasibleSet": "exclude-dependent-html-fragment-roots-inside-dp",
            "rootPrior": {
                "scope": "readability-promoted-primary-scope",
                "hybrid": "max-raw-evidence-and-promoted-primary-scope",
                "raw": "readability-evidence-tag-class-before-link-density",
            }[args.root_prior_mode],
            "rootPriorBudget": "at-most-one-page-primary-root",
            "zhSplits": ["base", "train"],
            "wcxbSource": "dev-only" if wcxb_pages else None,
            "wcxbTrainPages": len(wcxb_train),
            "wcxbHoldoutPages": len(wcxb_holdout),
            "wcxbTestOpened": False,
            "wcxbMinRequiredBlockCoverage": WCXB_MIN_REQUIRED_BLOCK_COVERAGE,
            "zhValidationOpened": bool(zh_validation),
            "zhTestOpened": False,
            "zhSourceFingerprints": source_fingerprints(zh_pages),
            "zhValidationSourceFingerprints": source_fingerprints(zh_validation),
            "wcxbSourceFingerprints": source_fingerprints(wcxb_pages),
        },
        "hyperparameters": {
            "regularization": args.regularization,
            "rootWeight": args.root_weight,
            "rootPriorMode": args.root_prior_mode,
            "wcxbCorpusWeight": args.wcxb_corpus_weight,
            "folds": args.folds,
        },
        "finalBeta": final_beta.tolist(),
        "siteFamilyOof": {
            "summary": summarize(oof_rows),
            "folds": fold_reports,
            "rows": oof_rows,
        },
        "perPage": oof_rows,
        "fullZhFitDiagnostic": {
            "summary": summarize(final_rows),
            "rows": final_rows,
        },
        "wcxbHoldout": {
            "summary": summarize(holdout_rows),
            "rows": holdout_rows,
        } if holdout_rows else None,
        "zhValidation": {
            "summary": summarize(validation_rows),
            "rows": validation_rows,
        } if validation_rows else None,
        "studySha256": TRAINER.sha256_file(Path(__file__)),
        "trainerCoreSha256": TRAINER.sha256_file(HERE / "tree_dp_training_core.py"),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    if args.masks_output:
        changed = {}
        for item in zh_pages:
            page = item.page
            baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
            candidate = oof_decodes[page.id]
            if not args.include_unchanged_masks and np.array_equal(baseline.mask, candidate.mask):
                continue
            changed[page.id] = {
                "baselineRetained": np.flatnonzero(baseline.mask).tolist(),
                "candidateRetained": np.flatnonzero(candidate.mask).tolist(),
                "baselineRoots": baseline.roots,
                "candidateRoots": candidate.roots,
            }
        masks = {
            "schema": "qingzhou.tree-dp-readability-oof-mask-delta.v1",
            "protocol": report["protocol"],
            "hyperparameters": report["hyperparameters"],
            "pages": changed,
        }
        args.masks_output.parent.mkdir(parents=True, exist_ok=True)
        args.masks_output.write_text(
            json.dumps(masks, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf8",
        )
    if args.wcxb_masks_output:
        if not wcxb_holdout:
            raise ValueError("--wcxb-masks-output requires --wcxb-units")
        changed = {}
        for item in wcxb_holdout:
            page = item.page
            baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
            candidate = holdout_decodes[page.id]
            if not args.include_unchanged_masks and np.array_equal(baseline.mask, candidate.mask):
                continue
            changed[page.id] = {
                "baselineRetained": np.flatnonzero(baseline.mask).tolist(),
                "candidateRetained": np.flatnonzero(candidate.mask).tolist(),
                "baselineRoots": baseline.roots,
                "candidateRoots": candidate.roots,
                "baselineAvailable": baseline.available,
                "candidateAvailable": candidate.available,
            }
        masks = {
            "schema": "qingzhou.tree-dp-readability-wcxb-holdout-mask-delta.v1",
            "protocol": report["protocol"],
            "hyperparameters": report["hyperparameters"],
            "pages": changed,
        }
        args.wcxb_masks_output.parent.mkdir(parents=True, exist_ok=True)
        args.wcxb_masks_output.write_text(
            json.dumps(masks, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf8",
        )
    if args.validation_masks_output:
        if not zh_validation:
            raise ValueError("--validation-masks-output requires --zh-validation-units")
        changed = {}
        for item in zh_validation:
            page = item.page
            baseline = TRAINER.decode(page, TRAINER.CURRENT_THETA)
            candidate = validation_decodes[page.id]
            if not args.include_unchanged_masks and np.array_equal(baseline.mask, candidate.mask):
                continue
            changed[page.id] = {
                "baselineRetained": np.flatnonzero(baseline.mask).tolist(),
                "candidateRetained": np.flatnonzero(candidate.mask).tolist(),
                "baselineRoots": baseline.roots,
                "candidateRoots": candidate.roots,
                "baselineAvailable": baseline.available,
                "candidateAvailable": candidate.available,
            }
        masks = {
            "schema": "qingzhou.tree-dp-readability-validation-mask-delta.v1",
            "protocol": report["protocol"],
            "hyperparameters": report["hyperparameters"],
            "pages": changed,
        }
        args.validation_masks_output.parent.mkdir(parents=True, exist_ok=True)
        args.validation_masks_output.write_text(
            json.dumps(masks, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf8",
        )
    print(json.dumps({
        "output": str(args.output),
        "zhPages": len(zh_pages),
        "wcxbTrainPages": len(wcxb_train),
        "wcxbHoldoutPages": len(wcxb_holdout),
        "oof": summarize(oof_rows),
        "wcxbHoldout": summarize(holdout_rows) if holdout_rows else None,
        "zhValidation": summarize(validation_rows) if validation_rows else None,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
