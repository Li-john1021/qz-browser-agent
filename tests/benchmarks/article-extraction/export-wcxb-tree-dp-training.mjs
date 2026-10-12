#!/usr/bin/env node
import { ensureTestExtension } from "../../support/extension-build.mjs";
import { prepareUpstreamArticleAssets } from "../../support/upstream-article-assets.mjs";

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { chromium } from "playwright";

import { registrableDomain } from "./corpus-diversity-audit.mjs";
import { instrumentArticleExtractorSource } from "./instrument-extractor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const defaultSource = join(
  root,
  "tests/results/article-extraction/external-corpora/wcxb-source",
);
const defaultOutput = join(
  root,
  "tests/results/article-extraction/zh-realworld-1500-v3/workspaces/tree-dp/readability-v2/wcxb-dev-units",
);
const ALIGNMENT_THRESHOLD = 0.8;
const ELEMENT_LOCAL_TOKEN_RECALL = 0.85;
const MIN_FUZZY_CHARS = 20;
const MIN_FUZZY_TOKENS = 4;
const MAX_LOCAL_SPAN_FACTOR = 2.5;
const MAX_LOCAL_SPAN_SLACK = 20;
const MAX_ANCHOR_OCCURRENCES = 64;

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function numberOption(name, fallback) {
  const value = Number(option(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeGzipJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, gzipSync(`${JSON.stringify(value)}\n`, { level: 9 }));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ngrams(value, size = 3) {
  const points = Array.from(normalizeText(value));
  const result = new Set();
  for (let index = 0; index + size <= points.length; index += 1) {
    result.add(points.slice(index, index + size).join(""));
  }
  return result;
}

function overlapMetrics(left, right) {
  const leftGrams = ngrams(left);
  const rightGrams = ngrams(right);
  if (!leftGrams.size || !rightGrams.size) {
    const exact = normalizeText(left) === normalizeText(right);
    return { precision: Number(exact), recall: Number(exact), f1: Number(exact) };
  }
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  const precision = overlap / leftGrams.size;
  const recall = overlap / rightGrams.size;
  return {
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
  };
}

function normalizeAlignmentText(value) {
  return normalizeText(value)
    .toLocaleLowerCase("en-US")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-");
}

function alignmentTokens(value) {
  return normalizeAlignmentText(value).match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
}

function buildAlignmentIndex(value) {
  const text = normalizeAlignmentText(value);
  const tokens = alignmentTokens(text);
  const positions = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const bucket = positions.get(token) || [];
    bucket.push(index);
    positions.set(token, bucket);
  }
  return { text, tokens, positions };
}

function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function locallyAlignedText(value, reference) {
  const text = normalizeAlignmentText(value);
  if (!text) return false;
  if (reference.text.includes(text)) return true;
  if (Array.from(text).length < MIN_FUZZY_CHARS) return false;
  const tokens = alignmentTokens(text);
  if (tokens.length < MIN_FUZZY_TOKENS) return false;

  const anchors = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const positions = reference.positions.get(tokens[index]);
    if (positions?.length) anchors.push({ count: positions.length, index, positions });
  }
  if (anchors.length / tokens.length < ELEMENT_LOCAL_TOKEN_RECALL) return false;
  anchors.sort((left, right) => left.count - right.count || left.index - right.index);
  const anchor = anchors[0];
  if (anchor.count > MAX_ANCHOR_OCCURRENCES) return false;

  for (const referencePosition of anchor.positions) {
    let matched = 1;
    let first = referencePosition;
    let last = referencePosition;
    let cursor = referencePosition;
    for (let index = anchor.index - 1; index >= 0; index -= 1) {
      const positions = reference.positions.get(tokens[index]) || [];
      const positionIndex = lowerBound(positions, cursor) - 1;
      if (positionIndex < 0) continue;
      cursor = positions[positionIndex];
      first = cursor;
      matched += 1;
    }
    cursor = referencePosition;
    for (let index = anchor.index + 1; index < tokens.length; index += 1) {
      const positions = reference.positions.get(tokens[index]) || [];
      const positionIndex = lowerBound(positions, cursor + 1);
      if (positionIndex >= positions.length) continue;
      cursor = positions[positionIndex];
      last = cursor;
      matched += 1;
    }
    const maxSpan = Math.max(
      tokens.length * MAX_LOCAL_SPAN_FACTOR,
      tokens.length + MAX_LOCAL_SPAN_SLACK,
    );
    if (matched / tokens.length >= ELEMENT_LOCAL_TOKEN_RECALL
      && last - first + 1 <= maxSpan) {
      return true;
    }
  }
  return false;
}

function monotonicallyAlignedText(value, reference) {
  const text = normalizeAlignmentText(value);
  if (!text) return false;
  if (reference.text.includes(text)) return true;
  if (Array.from(text).length < MIN_FUZZY_CHARS) return false;
  const tokens = alignmentTokens(text);
  if (tokens.length < MIN_FUZZY_TOKENS) return false;
  let cursor = -1;
  let matched = 0;
  for (const token of tokens) {
    const positions = reference.positions.get(token) || [];
    const positionIndex = lowerBound(positions, cursor + 1);
    if (positionIndex >= positions.length) continue;
    cursor = positions[positionIndex];
    matched += 1;
  }
  return matched / tokens.length >= ELEMENT_LOCAL_TOKEN_RECALL;
}

function frozenSnapshotHtml(value) {
  const style = "<style data-qz-benchmark-freeze>*,*::before,*::after{animation:none!important;transition:none!important}</style>";
  const html = String(value || "").replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?refresh\b)[^>]*>/gi,
    "",
  );
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, match => `${match}${style}`);
  }
  return `${style}${html}`;
}

function wcxbSplit(siteFamily) {
  // Only upstream dev is inspected. Reserve a deterministic domain-grouped
  // fifth for model/penalty selection; WCXB test remains sealed.
  const bucket = Number.parseInt(sha256(siteFamily || "unknown").slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < 0.2 ? "wcxb-holdout" : "wcxb-train";
}

const source = resolve(option("--source", defaultSource));
const output = resolve(option("--output", defaultOutput));
const workers = numberOption("--workers", 4);
const limit = numberOption("--limit", Number.MAX_SAFE_INTEGER);
const requestedIds = new Set(option("--ids", "").split(",").map(value => value.trim()).filter(Boolean));
const devHtml = join(source, "dev/html");
const devTruth = join(source, "dev/ground-truth");
const sealedTest = join(source, "test");
if (!existsSync(devHtml) || !existsSync(devTruth) || !existsSync(sealedTest)) {
  throw new Error("WCXB source must contain dev/{html,ground-truth} and a sealed test directory");
}

const allIds = Array.from({ length: 9_999 }, (_, index) => String(index + 1).padStart(4, "0"))
  .filter(id => existsSync(join(devHtml, `${id}.html.gz`)) && existsSync(join(devTruth, `${id}.json`)));
const ids = allIds.filter(id => !requestedIds.size || requestedIds.has(id)).slice(0, limit);
if (!ids.length) throw new Error("WCXB dev export selected no samples");
if (requestedIds.size && ids.length !== requestedIds.size) {
  const found = new Set(ids);
  throw new Error(`unknown WCXB dev ids: ${[...requestedIds].filter(id => !found.has(id)).join(", ")}`);
}

const extensionDir = await ensureTestExtension();
const extractorPath = join(extensionDir, "content/article-extractor.js");
const readabilityPath = (await prepareUpstreamArticleAssets()).readability;
const instrumenterPath = join(root, "tests/benchmarks/article-extraction/instrument-extractor.mjs");
const extractorSource = readFileSync(extractorPath, "utf8");
const instrumentedExtractor = instrumentArticleExtractorSource(extractorSource);
const sourceSha256 = Object.freeze({
  exporter: fileSha256(fileURLToPath(import.meta.url)),
  extractor: sha256(extractorSource),
  instrumenter: fileSha256(instrumenterPath),
  readability: fileSha256(readabilityPath),
  wcxbHead: (() => {
    const head = join(source, ".git/HEAD");
    if (!existsSync(head)) return null;
    const value = readFileSync(head, "utf8").trim();
    if (!value.startsWith("ref: ")) return value;
    const ref = join(source, ".git", value.slice(5));
    return existsSync(ref) ? readFileSync(ref, "utf8").trim() : null;
  })(),
});

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let cursor = 0;
const failures = [];
const rejected = [];
const splitCounts = {};
let exported = 0;
let totalNodes = 0;
let totalTokens = 0;

async function work() {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
  });
  let active = null;
  await context.addInitScript({
    content: readFileSync(readabilityPath, "utf8"),
  });
  await context.addInitScript({ content: instrumentedExtractor });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (active && request.isNavigationRequest() && request.frame().parentFrame() === null) {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy": "script-src 'none'; object-src 'none'; base-uri 'none'",
        },
        body: active.html,
      });
    } else {
      await route.abort();
    }
  });
  let page = await context.newPage();
  for (;;) {
    const index = cursor++;
    if (index >= ids.length) break;
    const id = ids[index];
    const truthPath = join(devTruth, `${id}.json`);
    const htmlPath = join(devHtml, `${id}.html.gz`);
    try {
      const truth = json(truthPath);
      const reference = normalizeText(truth?.ground_truth?.main_content || "");
      if (!reference) {
        rejected.push({ id, reason: "empty-ground-truth" });
        continue;
      }
      active = { html: frozenSnapshotHtml(gunzipSync(readFileSync(htmlPath)).toString("utf8")) };
      const targetUrl = /^https?:\/\//i.test(truth.url || "")
        ? truth.url
        : `https://wcxb.invalid/${id}`;
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.evaluate(() => new Promise(resolveFrame => (
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      )));
      const result = await page.evaluate(() => (
        globalThis.__qingzhouArticleBenchmark.collect(document, { provenance: true })
      ));
      const provenance = result?.diagnostics?.provenance;
      const tree = provenance?.sourceTree?.treeElements;
      const segments = provenance?.sourceTree?.treeTextSegments;
      const forced = result?.diagnostics?.forcedTreeDp;
      if (provenance?.schema !== "qingzhou.article-extraction-provenance.v1"
        || !Array.isArray(tree)
        || !Array.isArray(segments)) {
        throw new Error("instrumented extractor returned incomplete provenance");
      }
      if (!tree.length || !forced) {
        rejected.push({ id, reason: "tree-coordinate-unavailable" });
        continue;
      }
      if (tree.length !== forced.nodeCount) {
        throw new Error(`Tree-DP coordinate mismatch: ${tree.length} != ${forced.nodeCount}`);
      }
      const referenceIndex = buildAlignmentIndex(reference);
      const noiseReferences = (truth.ground_truth.without || [])
        .map(value => buildAlignmentIndex(value))
        .filter(index => index.text);
      const keep = tree.map(element => (
        element.tokens > 0
          && locallyAlignedText(element.ownText, referenceIndex)
          && !noiseReferences.some(noise => locallyAlignedText(element.ownText, noise))
      ));
      const projection = normalizeText(segments
        .filter(segment => keep[Number(segment[0])])
        .map(segment => segment[1])
        .join(""));
      const alignment = overlapMetrics(projection, reference);
      const projectionIndex = buildAlignmentIndex(projection);
      const requiredBlocks = (truth.ground_truth.with || []).map(value => ({
        text: String(value || ""),
        aligned: locallyAlignedText(value, projectionIndex)
          || monotonicallyAlignedText(value, projectionIndex),
      }));
      const noiseBlocks = (truth.ground_truth.without || []).map(value => ({
        text: String(value || ""),
        aligned: locallyAlignedText(value, projectionIndex),
      }));
      const missingRequired = requiredBlocks.filter(block => !block.aligned);
      const includedNoise = noiseBlocks.filter(block => block.aligned);
      if (alignment.f1 < ALIGNMENT_THRESHOLD || includedNoise.length) {
        rejected.push({
          id,
          reason: alignment.f1 < ALIGNMENT_THRESHOLD
            ? "main-content-alignment"
            : "included-noise-block",
          alignment,
          referenceChars: reference.length,
          projectionChars: projection.length,
          requiredBlocks: requiredBlocks.length,
          requiredBlocksAligned: requiredBlocks.length - missingRequired.length,
          missingRequired: missingRequired.map(block => block.text),
          noiseBlocks: noiseBlocks.length,
          includedNoise: includedNoise.map(block => block.text),
        });
        continue;
      }
      const url = String(truth.url || targetUrl);
      const siteFamily = registrableDomain(url) || new URL(targetUrl).hostname;
      const split = wcxbSplit(siteFamily);
      const labelledTree = tree.map((element, elementIndex) => ({
        ...element,
        goldKnown: element.tokens > 0,
        goldKeep: element.tokens > 0 ? keep[elementIndex] : null,
      }));
      const labelledSegments = segments.map(segment => [
        segment[0],
        segment[1],
        tree[Number(segment[0])]?.tokens > 0 ? keep[Number(segment[0])] : null,
      ]);
      const pageTokens = labelledTree.reduce((sum, element) => sum + element.tokens, 0);
      const record = {
        schema: "qingzhou.article-extraction-tree-dp-training-page.v2",
        id: `wcxb-${id}`,
        siteId: siteFamily,
        siteFamily,
        type: truth?._internal?.page_type?.primary || "article",
        vertical: "wcxb-en",
        split,
        status: "extract",
        inputSha256: fileSha256(htmlPath),
        labelSha256: fileSha256(truthPath),
        sourceSha256,
        snapshotReplay: {
          scripts: "blocked-by-csp",
          motion: "disabled-by-injected-style",
          metaRefresh: "removed-before-navigation",
        },
        reference: {
          mainText: truth.ground_truth.main_content,
          requiredBlocks: truth.ground_truth.with || [],
          noiseBlocks: truth.ground_truth.without || [],
        },
        gold: {
          schema: "qingzhou.wcxb-text-alignment-gold.v1",
          status: "extract",
          method: "exact-substring-or-local-token-sequence",
          elementLocalTokenRecall: ELEMENT_LOCAL_TOKEN_RECALL,
          minFuzzyChars: MIN_FUZZY_CHARS,
          minFuzzyTokens: MIN_FUZZY_TOKENS,
          maxLocalSpanFactor: MAX_LOCAL_SPAN_FACTOR,
          maxLocalSpanSlack: MAX_LOCAL_SPAN_SLACK,
          requiredBlocks: requiredBlocks.length,
          requiredBlocksAligned: requiredBlocks.length - missingRequired.length,
          missingRequiredBlocks: missingRequired.length,
          noiseBlocks: noiseBlocks.length,
          alignment,
        },
        tree: {
          ...provenance.sourceTree,
          treeElements: labelledTree,
          treeTextSegments: labelledSegments,
        },
        shipped: forced,
        parity: {
          nodeCount: tree.length,
          pageTokens,
          unknownTokenNodes: 0,
        },
      };
      writeGzipJsonAtomic(join(output, `${record.id}.json.gz`), record);
      exported += 1;
      splitCounts[split] = (splitCounts[split] || 0) + 1;
      totalNodes += tree.length;
      totalTokens += pageTokens;
    } catch (error) {
      const message = String(error?.message || error);
      if (error?.name === "TimeoutError" || /^page\.goto: Timeout /i.test(message)) {
        rejected.push({ id, reason: "snapshot-render-timeout", error: message });
      } else {
        failures.push({ id, error: message });
      }
      await page.close().catch(() => {});
      page = await context.newPage();
    } finally {
      active = null;
    }
    if ((index + 1) % 50 === 0) console.log(`WCXB dev export ${index + 1}/${ids.length}`);
  }
  await context.close();
}

try {
  await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, work));
} finally {
  await browser.close();
}

const report = {
  schema: "qingzhou.wcxb-tree-dp-training-export.v1",
  source,
  sourcePartition: "dev-only",
  sealedTestPath: sealedTest,
  output,
  selectedSamples: ids.length,
  exported,
  rejectedByAlignment: rejected.length,
  rejectedByLabelIntegrity: rejected.length,
  alignmentThreshold: ALIGNMENT_THRESHOLD,
  splitCounts,
  failures,
  rejected,
  totalNodes,
  totalTokens,
  sourceSha256,
};
if (failures.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  writeJsonAtomic(join(output, "export-report.json"), report);
  console.log(JSON.stringify({ ...report, rejected: rejected.slice(0, 20) }, null, 2));
}
