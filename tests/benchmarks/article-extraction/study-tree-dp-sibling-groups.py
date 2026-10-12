#!/usr/bin/env python3
"""Learn Readability-style repeated-sibling actions inside one Tree-DP.

The shipped Tree-DP can keep/carve a connected subtree or descend to
independent roots.  It cannot express Readability's most useful collection
operation: keep one anonymous class of repeated siblings while dropping the
other sibling classes under the same container.  This study adds exactly that
action to the feasible set and lets it compete with the shipped ordinary
forest and the empty answer in one page-level structured objective.

The action identity is structural only: direct siblings have the same group
iff their exact ``tagName|className`` signature is equal.  Class strings,
sites, URLs, page types, external extractor answers, timing, and gold are not
serving features.  Readability-derived signals are generic local scores and
scope flags exported before labels are joined.  Inference remains one model
over one DOM tree; every element belongs to at most one direct sibling group,
so the extra action statistics are computable in O(N).

This is a development-only study.  It refuses every Chinese split except
``base`` and ``train`` and reports site-family-disjoint OOF results.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import GroupKFold

import tree_dp_training_core as TRAINER


FEATURE_NAMES = [
    "forcedEnergyPerPageToken",
    "forcedEnergyPerRetainedToken",
    "retainedPageShare",
    "rootCoverageShare",
    "carvedRootCoverageShare",
    "logRetainedTokens",
    "logGroupSize",
    "groupChildShare",
    "memberTokenMeanLog",
    "memberTokenCoefficientOfVariation",
    "memberKeepPerTokenMin",
    "memberKeepPerTokenMean",
    "memberKeepPerTokenMax",
    "ordinaryAvailable",
    "ordinaryRootCountLog",
    "retainedOrdinaryTokenRecall",
    "retainedOrdinaryTokenPrecision",
    "retainedToOrdinaryLogRatio",
    "sameTextAsOrdinary",
    "retainedAnchorShare",
    "retainedBoilerplateShare",
    "retainedContentShare",
    "retainedParagraphShare",
    "retainedHeadingShare",
    "retainedListItemShare",
    "retainedTableShare",
    "retainedOtherShare",
    "retainedReadabilityPositiveShare",
    "retainedReadabilityNegativeShare",
    "retainedReadabilityUnlikelyShare",
    "retainedReadabilityExtraneousShare",
    "retainedReadabilityRoleRejectedShare",
    "retainedPunctuationPerToken",
    "rootReadabilityEvidenceLog",
    "rootReadabilityClassWeight",
    "rootReadabilityLinkFactor",
    "rootReadabilityFullScore",
    "rootReadabilityPositiveHits",
    "rootReadabilityNegativeHits",
    "rootReadabilityUnlikely",
    "rootReadabilityRoleRejected",
    "rootDepth",
    "rootDocumentPosition",
    "rootDocumentCentrality",
    "rootChildCountLog",
    "pageTokensLog",
    "pageAnchorShare",
    "pageReadabilityEvidenceLog",
    "pageReadabilityPositiveMassLog",
    "pageReadabilityNegativeMassLog",
    "rootTagBody",
    "rootTagMainOrArticle",
    "rootTagSection",
    "rootTagDiv",
    "rootTagList",
]


@dataclass
class GroupAction:
    features: np.ndarray
    quality: float
    root: int
    sibling_group: int
    member_count: int
    retained_tokens: int
    normalized_digest: str


@dataclass
class GroupPage:
    source: TRAINER.Page
    actions: list[GroupAction]
    ordinary_quality: float
    ordinary_available: bool
    ordinary_roots: list[int]
    ordinary_retained_tokens: int
    ordinary_digest: str


@dataclass
class Scaling:
    mean: np.ndarray
    scale: np.ndarray


def read_record(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf8") as handle:
        return json.load(handle)


def text_digest(value: str) -> str:
    return hashlib.sha256(TRAINER.normalize_text(value).encode("utf8")).hexdigest()


def load_pages(directory: Path) -> tuple[list[TRAINER.Page], dict]:
    report_path = directory / "export-report.json"
    if not report_path.exists():
        raise ValueError(f"incomplete export: {report_path} is missing")
    report = json.loads(report_path.read_text(encoding="utf8"))
    if report.get("schema") != "qingzhou.article-extraction-tree-dp-training-export.v2":
        raise ValueError(f"unexpected export schema: {report.get('schema')}")
    if report.get("testOpened") is not False:
        raise ValueError("refusing an export that opened the Chinese test split")
    if set(report.get("requestedSplits", [])) != {"base", "train"}:
        raise ValueError(f"refusing splits {report.get('requestedSplits')}")
    paths = sorted(directory.glob("*.json.gz"))
    if len(paths) != int(report.get("exported", -1)):
        raise ValueError("training export file count differs from export report")
    pages = []
    for path in paths:
        record = read_record(path)
        if record.get("sourceSha256") != report.get("sourceSha256"):
            raise ValueError(f"{record.get('id')}: source provenance mismatch")
        pages.append(TRAINER.page_from_record(record, {"base", "train"}))
    return pages, report


def shipped_keep(page: TRAINER.Page):
    total = len(page.tokens)
    local = page.tokens * (
        TRAINER.CURRENT_THETA[0] + page.features @ TRAINER.CURRENT_THETA[1:]
    )
    keep = np.zeros(total, dtype=np.float64)
    choice: list[list[bool]] = [[] for _ in range(total)]
    for index in range(total - 1, -1, -1):
        value = float(local[index])
        selected = []
        for child in page.children[index]:
            excluded = -TRAINER.EXCLUDE_PENALTY * min(
                1.0,
                page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
            )
            retain = keep[child] >= excluded
            value += keep[child] if retain else excluded
            selected.append(bool(retain))
        keep[index] = value
        choice[index] = selected
    return local, keep, choice


def kept_sum(page: TRAINER.Page, choice: list[list[bool]], values: np.ndarray):
    result = np.asarray(values, dtype=np.float64).copy()
    for index in range(len(result) - 1, -1, -1):
        for offset, child in enumerate(page.children[index]):
            if choice[index][offset]:
                result[index] += result[child]
    return result


def inherited_readability_scope(page: TRAINER.Page) -> np.ndarray:
    direct = np.column_stack((
        page.readability_positive_hits > 0,
        page.readability_negative_hits > 0,
        page.readability_unlikely,
        page.readability_extraneous,
        page.readability_role_rejected,
    )).astype(np.float64)
    scope = direct.copy()
    for index in range(1, len(scope)):
        scope[index] = np.maximum(scope[index], scope[page.parent[index]])
    return scope


def reconstruct_member(
    page: TRAINER.Page,
    choice: list[list[bool]],
    root: int,
    mask: np.ndarray,
) -> None:
    stack = [root]
    while stack:
        index = stack.pop()
        mask[index] = True
        for offset, child in enumerate(page.children[index]):
            if choice[index][offset]:
                stack.append(child)


def aggregate_group(
    parent: int,
    members: list[int],
    own: np.ndarray,
    kept: np.ndarray,
) -> float:
    return float(own[parent] + sum(kept[member] for member in members))


def build_group_page(page: TRAINER.Page) -> GroupPage:
    local, keep, choice = shipped_keep(page)
    ordinary = TRAINER.decode(page, TRAINER.CURRENT_THETA)
    ordinary_text = (
        TRAINER.materialized_text(page, ordinary.mask) if ordinary.available else ""
    )
    ordinary_quality = TRAINER.trigram_f1(ordinary_text, page.reference)
    ordinary_tokens = page.tokens * ordinary.mask
    ordinary_total = float(ordinary_tokens.sum())

    page_tokens = max(1.0, float(page.tokens.sum()))
    tags = np.asarray(page.tags)
    category_values = np.column_stack((
        page.tokens * page.features[:, 6],
        page.tokens * np.clip(page.features[:, 10], 0.0, 1.0),
        page.tokens * np.clip(page.features[:, 11], 0.0, 1.0),
        page.tokens * (tags == "p"),
        page.tokens * np.isin(tags, ["h1", "h2", "h3", "h4", "h5", "h6"]),
        page.tokens * np.isin(tags, ["li", "dt", "dd"]),
        page.tokens * np.isin(tags, ["table", "tr", "td", "th"]),
        page.tokens * ~np.isin(tags, [
            "p", "h1", "h2", "h3", "h4", "h5", "h6",
            "li", "dt", "dd", "table", "tr", "td", "th",
        ]),
        page.tokens * page.features[:, 8],
    ))
    readability_scope = inherited_readability_scope(page)
    category_kept = np.column_stack([
        kept_sum(page, choice, category_values[:, column])
        for column in range(category_values.shape[1])
    ])
    readability_kept = np.column_stack([
        kept_sum(page, choice, page.tokens * readability_scope[:, column])
        for column in range(readability_scope.shape[1])
    ])
    kept_tokens = kept_sum(page, choice, page.tokens)

    actions: list[GroupAction] = []
    seen_masks: set[bytes] = set()
    components = page.readability_root_scores
    for parent, children in enumerate(page.children):
        if len(children) < 2 or page.tags[parent] in TRAINER.DEPENDENT_ROOT_TAGS:
            continue
        groups: dict[int, list[int]] = {}
        for child in children:
            group = int(page.sibling_group[child])
            groups.setdefault(group, []).append(child)
        for group, members in sorted(groups.items()):
            if len(members) < 2:
                continue
            mask = np.zeros(len(page.tokens), dtype=bool)
            mask[parent] = True
            for member in members:
                reconstruct_member(page, choice, member, mask)
            retained_tokens = int(page.tokens[mask].sum())
            if retained_tokens < TRAINER.MIN_RETAINED_TOKENS:
                continue
            identity = np.packbits(mask).tobytes()
            if identity in seen_masks:
                continue
            seen_masks.add(identity)

            candidate_text = TRAINER.materialized_text(page, mask)
            quality = TRAINER.trigram_f1(candidate_text, page.reference)
            retained = max(1.0, float(retained_tokens))
            retained_ordinary = float(ordinary_tokens[mask].sum())
            group_energy = float(local[parent])
            member_set = set(members)
            for child in children:
                if child in member_set:
                    group_energy += keep[child]
                else:
                    group_energy -= TRAINER.EXCLUDE_PENALTY * min(
                        1.0,
                        page.subtree_tokens[child] / TRAINER.MIN_EXCLUDE_TOKENS,
                    )
            group_energy -= TRAINER.ROOT_PENALTY

            aggregate = category_values[parent] + sum(
                (category_kept[member] for member in members),
                np.zeros(category_values.shape[1], dtype=np.float64),
            )
            readable = page.tokens[parent] * readability_scope[parent] + sum(
                (readability_kept[member] for member in members),
                np.zeros(readability_scope.shape[1], dtype=np.float64),
            )
            member_tokens = np.maximum(1.0, kept_tokens[members])
            member_energy = keep[members] / member_tokens
            token_mean = float(member_tokens.mean())
            token_cv = float(member_tokens.std() / max(1.0, token_mean))
            position = parent / max(1, len(page.tokens) - 1)
            root_tag = page.tags[parent]
            root_coverage = float(page.subtree_tokens[parent])
            features = np.asarray([
                np.clip(group_energy / page_tokens, -4.0, 4.0),
                np.clip(group_energy / retained, -4.0, 4.0),
                np.clip(retained / page_tokens, 0.0, 1.0),
                np.clip(root_coverage / page_tokens, 0.0, 1.0),
                np.clip((root_coverage - retained) / max(1.0, root_coverage), 0.0, 1.0),
                np.log1p(retained) / 12.0,
                np.log1p(len(members)) / 8.0,
                len(members) / max(1, len(children)),
                np.log1p(token_mean) / 12.0,
                np.clip(token_cv, 0.0, 4.0) / 4.0,
                np.clip(float(member_energy.min()), -4.0, 4.0),
                np.clip(float(member_energy.mean()), -4.0, 4.0),
                np.clip(float(member_energy.max()), -4.0, 4.0),
                float(ordinary.available),
                np.log1p(len(ordinary.roots)) / 4.0,
                retained_ordinary / max(1.0, ordinary_total),
                retained_ordinary / retained,
                np.clip(
                    np.log((retained + 1.0) / (ordinary_total + 1.0)),
                    -8.0,
                    8.0,
                ) / 8.0,
                float(text_digest(candidate_text) == text_digest(ordinary_text)),
                *np.clip(aggregate[:8] / retained, 0.0, 1.0),
                *np.clip(readable / retained, 0.0, 1.0),
                np.clip(float(aggregate[8]) / retained, 0.0, 4.0) / 4.0,
                np.log1p(max(0.0, float(components["evidence"][parent]))) / 8.0,
                np.clip(float(components["class"][parent]) / 25.0, -4.0, 4.0),
                np.clip(float(components["link-factor"][parent]), 0.0, 1.0),
                np.clip(float(components["full"][parent]) / 25.0, -4.0, 4.0),
                np.clip(float(page.readability_positive_hits[parent]) / 2.0, 0.0, 1.0),
                np.clip(float(page.readability_negative_hits[parent]) / 2.0, 0.0, 1.0),
                float(page.readability_unlikely[parent]),
                float(page.readability_role_rejected[parent]),
                np.clip(float(page.features[parent, 13]), 0.0, 1.0),
                position,
                1.0 - 2.0 * abs(position - 0.5),
                np.log1p(len(children)) / 8.0,
                np.log1p(page_tokens) / 12.0,
                np.clip(float(page.features[0, 14]), 0.0, 1.0),
                np.log1p(max(0.0, float(np.max(components["evidence"])))) / 8.0,
                np.log1p(float(np.maximum(0.0, components["full"]).sum())) / 12.0,
                np.log1p(float(np.maximum(0.0, -components["full"]).sum())) / 12.0,
                float(root_tag == "body"),
                float(root_tag in {"main", "article"}),
                float(root_tag == "section"),
                float(root_tag == "div"),
                float(root_tag in {"ul", "ol", "dl"}),
            ], dtype=np.float64)
            if features.shape != (len(FEATURE_NAMES),):
                raise ValueError(
                    f"{page.id}: group feature width {len(features)} != {len(FEATURE_NAMES)}"
                )
            if not np.all(np.isfinite(features)):
                raise ValueError(f"{page.id}: non-finite group feature")
            actions.append(GroupAction(
                features=features,
                quality=quality,
                root=parent,
                sibling_group=group,
                member_count=len(members),
                retained_tokens=retained_tokens,
                normalized_digest=text_digest(candidate_text),
            ))
    return GroupPage(
        source=page,
        actions=actions,
        ordinary_quality=ordinary_quality,
        ordinary_available=ordinary.available,
        ordinary_roots=ordinary.roots,
        ordinary_retained_tokens=ordinary.retained_tokens,
        ordinary_digest=text_digest(ordinary_text),
    )


class GroupActionEnergy(torch.nn.Module):
    def __init__(self, dimensions: int, width: int, bound: float):
        super().__init__()
        self.bound = bound
        self.network = (
            torch.nn.Linear(dimensions * 3, 1)
            if width == 0
            else torch.nn.Sequential(
                torch.nn.Linear(dimensions * 3, width),
                torch.nn.Tanh(),
                torch.nn.Linear(width, 1),
            )
        )
        # The exact shipped forest is the zero-parameter behavior.  A sibling
        # group must learn positive evidence to displace it or empty.
        output = self.network if width == 0 else self.network[-1]
        torch.nn.init.zeros_(output.weight)
        torch.nn.init.zeros_(output.bias)

    def forward(self, values: torch.Tensor) -> torch.Tensor:
        mean = values.mean(dim=0, keepdim=True)
        maximum = values.max(dim=0, keepdim=True).values
        context = torch.cat((values, values - mean, values - maximum), dim=1)
        raw = self.network(context).squeeze(1)
        return self.bound * torch.tanh(raw / self.bound)


def fit_scaling(pages: list[GroupPage]) -> Scaling:
    matrices = [
        np.asarray([action.features for action in page.actions], dtype=np.float64)
        for page in pages if page.actions
    ]
    matrix = np.concatenate(matrices) if matrices else np.zeros((1, len(FEATURE_NAMES)))
    mean = matrix.mean(axis=0)
    scale = matrix.std(axis=0)
    scale[scale < 1e-6] = 1.0
    return Scaling(mean, scale)


def action_tensor(page: GroupPage, scaling: Scaling) -> torch.Tensor:
    values = np.asarray([action.features for action in page.actions], dtype=np.float64)
    values = np.clip((values - scaling.mean) / scaling.scale, -8.0, 8.0)
    return torch.as_tensor(values, dtype=torch.float32)


def page_loss(
    model: GroupActionEnergy,
    page: GroupPage,
    scaling: Scaling,
    args: argparse.Namespace,
) -> torch.Tensor:
    if not page.actions:
        return torch.zeros((), dtype=torch.float32)
    scores = model(action_tensor(page, scaling))
    quality = torch.as_tensor(
        [action.quality for action in page.actions], dtype=torch.float32
    )
    references = [torch.zeros((), dtype=torch.float32)]
    reference_quality = [1.0 if page.source.status == "exclude" else 0.0]
    if page.ordinary_available:
        references.append(torch.zeros((), dtype=torch.float32))
        reference_quality.append(page.ordinary_quality)
    all_scores = torch.cat((scores, torch.stack(references)))
    all_quality = torch.cat((
        quality,
        torch.as_tensor(reference_quality, dtype=torch.float32),
    ))
    best = torch.max(all_quality)
    gap = best - all_quality
    cost = (
        args.loss_margin * gap
        + args.tail_loss_margin * torch.relu(gap - args.tail_delta)
    )
    compatible = all_quality >= best - args.gold_tolerance
    return torch.logsumexp(all_scores + cost, dim=0) - torch.logsumexp(
        all_scores[compatible], dim=0
    )


def train_model(
    pages: list[GroupPage],
    args: argparse.Namespace,
    seed: int,
) -> tuple[GroupActionEnergy, Scaling, list[dict]]:
    random.seed(seed)
    torch.manual_seed(seed)
    scaling = fit_scaling(pages)
    model = GroupActionEnergy(len(FEATURE_NAMES), args.hidden_width, args.score_bound)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay
    )
    family_counts: dict[str, int] = {}
    for page in pages:
        family_counts[page.source.site_family] = (
            family_counts.get(page.source.site_family, 0) + 1
        )
    raw_weights = np.asarray([
        (args.exclude_weight if page.source.status == "exclude" else 1.0)
        / family_counts[page.source.site_family]
        for page in pages
    ], dtype=np.float64)
    raw_weights /= max(1e-12, float(raw_weights.sum()))
    weighted = list(zip(pages, raw_weights, strict=True))
    history = []
    for epoch in range(1, args.epochs + 1):
        random.shuffle(weighted)
        optimizer.zero_grad(set_to_none=True)
        batch = torch.zeros((), dtype=torch.float32)
        count = 0
        total_loss = 0.0
        for page, weight in weighted:
            loss = float(weight) * page_loss(model, page, scaling, args)
            batch = batch + loss
            total_loss += float(loss.detach())
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
        history.append({"epoch": epoch, "loss": total_loss})
    return model, scaling, history


def evaluate(
    page: GroupPage,
    model: GroupActionEnergy,
    scaling: Scaling,
) -> dict:
    if page.actions:
        with torch.no_grad():
            scores = model(action_tensor(page, scaling)).numpy()
        selected = int(np.argmax(scores))
        selected_score = float(scores[selected])
    else:
        scores = np.zeros(0, dtype=np.float64)
        selected = -1
        selected_score = 0.0

    # Empty and ordinary are fixed zero-energy references.  Exact ties retain
    # the shipped answer; without one they abstain.
    use_group = selected >= 0 and selected_score > 0.0
    if use_group:
        action = page.actions[selected]
        quality = action.quality
        available = True
        kind = "sibling-group"
        roots = [action.root]
        retained_tokens = action.retained_tokens
        digest = action.normalized_digest
        group = action.sibling_group
        members = action.member_count
    elif page.ordinary_available:
        quality = page.ordinary_quality
        available = True
        kind = "ordinary"
        roots = page.ordinary_roots
        retained_tokens = page.ordinary_retained_tokens
        digest = page.ordinary_digest
        group = None
        members = None
    else:
        quality = 1.0 if page.source.status == "exclude" else 0.0
        available = False
        kind = "empty"
        roots = []
        retained_tokens = 0
        digest = text_digest("")
        group = None
        members = None
    delta = quality - page.ordinary_quality
    return {
        "id": page.source.id,
        "siteFamily": page.source.site_family,
        "split": page.source.split,
        "status": page.source.status,
        "baseline": page.ordinary_quality,
        "candidate": quality,
        "delta": delta,
        "baselineAvailable": page.ordinary_available,
        "candidateAvailable": available,
        "selectedAction": kind,
        "selectedScore": selected_score,
        "candidateRoots": roots,
        "candidateRetainedTokens": retained_tokens,
        "siblingGroup": group,
        "siblingMembers": members,
        "outputChanged": digest != page.ordinary_digest,
        "availableGroupActions": len(page.actions),
        "bestGroupQuality": max(
            (action.quality for action in page.actions), default=0.0
        ),
    }


def summarize(rows: list[dict]) -> dict:
    extract = [row for row in rows if row["status"] == "extract"]
    switches = [row for row in extract if row["outputChanged"]]
    losses = [row for row in switches if row["delta"] < -1e-12]
    wins = [row for row in switches if row["delta"] > 1e-12]
    exclude = [row for row in rows if row["status"] == "exclude"]
    return {
        "pages": len(rows),
        "extractPages": len(extract),
        "excludePages": len(exclude),
        "baselineMeanF1": float(np.mean([row["baseline"] for row in extract])) if extract else 0.0,
        "candidateMeanF1": float(np.mean([row["candidate"] for row in extract])) if extract else 0.0,
        "meanDelta": float(np.mean([row["delta"] for row in extract])) if extract else 0.0,
        "switches": len(switches),
        "switchFamilies": len({row["siteFamily"] for row in switches}),
        "wins": len(wins),
        "losses": len(losses),
        "worstDelta": min((row["delta"] for row in switches), default=0.0),
        "lossBelowPointOne": sum(row["delta"] < -0.1 for row in switches),
        "lossBelowPointTwo": sum(row["delta"] < -0.2 for row in switches),
        "excludeFalsePositivesBefore": sum(row["baselineAvailable"] for row in exclude),
        "excludeFalsePositivesAfter": sum(row["candidateAvailable"] for row in exclude),
        "groupActions": sum(row["availableGroupActions"] for row in rows),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--units", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--only-fold", type=int)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-pages", type=int, default=32)
    parser.add_argument("--hidden-width", type=int, default=16)
    parser.add_argument("--score-bound", type=float, default=3.0)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--loss-margin", type=float, default=4.0)
    parser.add_argument("--tail-loss-margin", type=float, default=8.0)
    parser.add_argument("--tail-delta", type=float, default=0.10)
    parser.add_argument("--gold-tolerance", type=float, default=0.01)
    parser.add_argument("--exclude-weight", type=float, default=10.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source_pages, export_report = load_pages(args.units)
    pages = [build_group_page(page) for page in source_pages]
    zero_parameter_parity = all(
        page.ordinary_available == TRAINER.decode(
            page.source, TRAINER.CURRENT_THETA
        ).available
        for page in pages
    )
    if not zero_parameter_parity:
        raise ValueError("zero-parameter ordinary action differs from shipped Tree-DP")
    indices = np.arange(len(pages))
    groups = np.asarray([page.source.site_family for page in pages])
    rows = []
    folds = []
    for fold, (train_indices, test_indices) in enumerate(
        GroupKFold(args.folds).split(indices, groups=groups), 1
    ):
        if args.only_fold is not None and fold != args.only_fold:
            continue
        train = [pages[int(index)] for index in train_indices]
        test = [pages[int(index)] for index in test_indices]
        model, scaling, history = train_model(train, args, 26000 + fold)
        fold_rows = [evaluate(page, model, scaling) for page in test]
        fold_summary = summarize(fold_rows)
        rows.extend(fold_rows)
        folds.append({
            "fold": fold,
            "trainingPages": len(train),
            "trainingActions": sum(len(page.actions) for page in train),
            "summary": fold_summary,
            "history": history,
            "model": {
                key: value.detach().numpy().tolist()
                for key, value in model.state_dict().items()
            },
            "scalingMean": scaling.mean.tolist(),
            "scalingScale": scaling.scale.tolist(),
        })
        print(json.dumps({"fold": fold, "summary": fold_summary}, ensure_ascii=False), flush=True)
    report = {
        "schema": "qingzhou.tree-dp-sibling-group-study.v1",
        "protocol": {
            "trainingSplits": ["base", "train"],
            "grouping": "siteFamily",
            "validationOpened": False,
            "testOpened": False,
            "runtimeCandidates": False,
            "runtimeActions": ["empty", "ordinary-tree-dp-forest", "exact-sibling-group"],
            "siblingIdentity": "exact tagName|className, exported as anonymous per-parent integer",
            "ordinaryEnergy": "fixed-zero-reference",
            "emptyEnergy": "fixed-zero-reference",
            "groupEnergy": "bounded page-context MLP",
            "featureNames": FEATURE_NAMES,
            "inferenceComplexity": "O(N*hiddenWidth)",
        },
        "hyperparameters": {
            key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
        },
        "export": {
            "sourceSha256": export_report.get("sourceSha256"),
            "pages": export_report.get("exported"),
            "splitCounts": export_report.get("splitCounts"),
        },
        "actionSpace": {
            "pages": len(pages),
            "pagesWithGroupActions": sum(bool(page.actions) for page in pages),
            "groupActions": sum(len(page.actions) for page in pages),
            "zeroParameterParity": zero_parameter_parity,
        },
        "siteFamilyOof": {
            "summary": summarize(rows),
            "folds": folds,
            "rows": rows,
        },
        "provenance": {
            "studySha256": TRAINER.sha256_file(Path(__file__)),
            "trainingCoreSha256": TRAINER.sha256_file(Path(TRAINER.__file__)),
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf8"
    )
    print(json.dumps({
        "output": str(args.output),
        "summary": report["siteFamilyOof"]["summary"],
        "actionSpace": report["actionSpace"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
