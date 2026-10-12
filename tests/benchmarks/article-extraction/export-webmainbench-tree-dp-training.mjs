#!/usr/bin/env node
import { ensureTestExtension } from "../../support/extension-build.mjs";
import { prepareUpstreamArticleAssets } from "../../support/upstream-article-assets.mjs";

import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { gzipSync } from "node:zlib";

import { chromium } from "playwright";

import { registrableDomain } from "./corpus-diversity-audit.mjs";
import { instrumentArticleExtractorSource } from "./instrument-extractor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const defaultSource = join(
  root,
  "tests/results/article-extraction/external-corpora/webmainbench/webmainbench.jsonl",
);
const defaultOutput = join(
  root,
  "tests/results/article-extraction/zh-realworld-1500-v3/workspaces/tree-dp/readability-v2/wmb-units",
);
const UID_RE = /\bdata-anno-uid\s*=\s*["']([^"']+)["']/gi;
const MIN_KNOWN_TOKEN_SHARE = 0.98;

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
  const digest = createHash("sha256");
  return new Promise((resolveDigest, reject) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveDigest(digest.digest("hex")));
  });
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

function annotationValues(html) {
  UID_RE.lastIndex = 0;
  const values = [];
  for (let match; (match = UID_RE.exec(String(html || "")));) values.push(match[1]);
  return values;
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function frozenHtml(value) {
  const injection = `<meta http-equiv="content-security-policy" content="script-src 'none'; object-src 'none'; base-uri 'none'">
<style data-qz-benchmark-freeze>*,*::before,*::after{animation:none!important;transition:none!important}</style>`;
  const html = String(value || "").replace(
    /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?refresh\b)[^>]*>/gi,
    "",
  );
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, match => `${match}${injection}`);
  }
  return `${injection}${html}`;
}

function corpusSplit(siteFamily) {
  const bucket = Number.parseInt(sha256(siteFamily || "unknown").slice(0, 8), 16)
    / 0x1_0000_0000;
  return bucket < 0.2 ? "wmb-holdout" : "wmb-train";
}

class BoundedQueue {
  constructor(capacity) {
    this.capacity = capacity;
    this.values = [];
    this.readers = [];
    this.writers = [];
    this.closed = false;
    this.error = null;
  }

  async push(value) {
    while (!this.closed && !this.readers.length && this.values.length >= this.capacity) {
      await new Promise(resolveWriter => this.writers.push(resolveWriter));
    }
    if (this.closed) throw this.error || new Error("queue is closed");
    const reader = this.readers.shift();
    if (reader) reader.resolve(value);
    else this.values.push(value);
  }

  async take() {
    if (this.values.length) {
      const value = this.values.shift();
      this.writers.shift()?.();
      return value;
    }
    if (this.closed) {
      if (this.error) throw this.error;
      return null;
    }
    return new Promise((resolveReader, rejectReader) => {
      this.readers.push({ resolve: resolveReader, reject: rejectReader });
    });
  }

  close(error = null) {
    this.closed = true;
    this.error = error;
    for (const writer of this.writers.splice(0)) writer();
    for (const reader of this.readers.splice(0)) {
      if (error) reader.reject(error);
      else reader.resolve(null);
    }
  }
}

const source = resolve(option("--source", defaultSource));
const output = resolve(option("--output", defaultOutput));
const workers = numberOption("--workers", 4);
const limit = numberOption("--limit", Number.MAX_SAFE_INTEGER);
const offset = numberOption("--offset", 0);
const extensionDir = await ensureTestExtension();
const extractorPath = join(extensionDir, "content/article-extractor.js");
const readabilityPath = (await prepareUpstreamArticleAssets()).readability;
const instrumenterPath = join(root, "tests/benchmarks/article-extraction/instrument-extractor.mjs");
const extractorSource = readFileSync(extractorPath, "utf8");
const instrumentedExtractor = instrumentArticleExtractorSource(extractorSource);
const sourceSha256 = Object.freeze({
  exporter: await fileSha256(fileURLToPath(import.meta.url)),
  extractor: sha256(extractorSource),
  instrumenter: await fileSha256(instrumenterPath),
  readability: await fileSha256(readabilityPath),
  corpus: await fileSha256(source),
});

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const queue = new BoundedQueue(Math.max(2, workers * 2));
const failures = [];
const rejected = [];
const splitCounts = {};
const languageCounts = {};
let considered = 0;
let queued = 0;
let exported = 0;
let totalNodes = 0;
let totalTokens = 0;
let totalKnownTokens = 0;

async function work() {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.addInitScript({
    content: readFileSync(readabilityPath, "utf8"),
  });
  await context.addInitScript({ content: instrumentedExtractor });
  await context.route("**/*", route => route.abort());
  let page = await context.newPage();
  for (;;) {
    const item = await queue.take();
    if (!item) break;
    const { index, record, mainValues } = item;
    const id = `wmb-${record.track_id}`;
    try {
      await page.setContent(frozenHtml(record.html), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.evaluate(() => new Promise(resolveFrame => (
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      )));
      const result = await page.evaluate(keptAnnotationValues => (
        globalThis.__qingzhouArticleBenchmark.collect(document, {
          provenance: true,
          goldSelection: {
            status: "extract",
            annotationAttribute: "data-anno-uid",
            keptAnnotationValues,
          },
        })
      ), mainValues);
      const provenance = result?.diagnostics?.provenance;
      const tree = provenance?.sourceTree?.treeElements;
      const segments = provenance?.sourceTree?.treeTextSegments;
      const gold = provenance?.gold;
      const forced = result?.diagnostics?.forcedTreeDp;
      if (provenance?.schema !== "qingzhou.article-extraction-provenance.v1"
        || gold?.schema !== "qingzhou.article-extraction-annotation-gold-selection.v1"
        || !Array.isArray(tree)
        || !Array.isArray(segments)
        || !forced) {
        throw new Error("instrumented extractor returned incomplete WMB provenance");
      }
      if (gold.requestedValues !== gold.resolvedValues) {
        throw new Error("WMB annotation values did not resolve exactly");
      }
      if (tree.length !== forced.nodeCount) {
        throw new Error(`Tree-DP coordinate mismatch: ${tree.length} != ${forced.nodeCount}`);
      }
      const pageTokens = tree.reduce((sum, element) => sum + element.tokens, 0);
      const knownTokens = tree.reduce(
        (sum, element) => sum + (element.goldKnown ? element.tokens : 0),
        0,
      );
      const keptTokens = tree.reduce(
        (sum, element) => sum + (element.goldKnown && element.goldKeep ? element.tokens : 0),
        0,
      );
      const knownTokenShare = pageTokens ? knownTokens / pageTokens : 0;
      if (!pageTokens || !keptTokens || knownTokenShare < MIN_KNOWN_TOKEN_SHARE) {
        rejected.push({
          index,
          id,
          reason: !pageTokens ? "empty-tree" : (!keptTokens ? "empty-gold" : "low-known-token-share"),
          pageTokens,
          knownTokens,
          knownTokenShare,
          unknownTextUnits: gold.unknownTextUnits,
        });
        continue;
      }
      const reference = normalizedText(segments
        .filter(([_owner, _text, keep]) => keep === true)
        .map(([_owner, text]) => text)
        .join(""));
      if (!reference) throw new Error("WMB gold mask produced empty reference text");
      const url = String(record.url || "");
      const siteFamily = registrableDomain(url) || new URL(url).hostname;
      const split = corpusSplit(siteFamily);
      const language = String(record.meta?.language || "unknown");
      const outputRecord = {
        schema: "qingzhou.article-extraction-tree-dp-training-page.v2",
        id,
        siteId: siteFamily,
        siteFamily,
        type: "web-main-content",
        vertical: `webmainbench-${language}`,
        split,
        status: "extract",
        inputSha256: sha256(record.html),
        labelSha256: sha256(record.main_html),
        sourceSha256,
        snapshotReplay: {
          scripts: "blocked-by-csp",
          network: "aborted",
          motion: "disabled-by-injected-style",
          metaRefresh: "removed-before-render",
        },
        reference: {
          mainText: reference,
          requiredBlocks: [],
          noiseBlocks: [],
        },
        gold: {
          ...gold,
          source: "webmainbench-data-anno-uid",
          knownTokenShare,
          providedMainContentSha256: sha256(record.convert_main_content || ""),
        },
        tree: provenance.sourceTree,
        shipped: forced,
        parity: {
          nodeCount: tree.length,
          pageTokens,
          knownTokens,
          knownTokenShare,
          unknownTokenNodes: tree.filter(element => element.tokens > 0 && !element.goldKnown).length,
        },
        sourceMeta: record.meta || {},
      };
      writeGzipJsonAtomic(join(output, `${id}.json.gz`), outputRecord);
      exported += 1;
      splitCounts[split] = (splitCounts[split] || 0) + 1;
      languageCounts[language] = (languageCounts[language] || 0) + 1;
      totalNodes += tree.length;
      totalTokens += pageTokens;
      totalKnownTokens += knownTokens;
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes("annotation gold selection values must resolve exactly once")) {
        rejected.push({
          index,
          id,
          reason: "annotation-identity-lost-by-html-parser",
          error: message,
        });
      } else {
        failures.push({ index, id, error: message });
      }
      await page.close().catch(() => {});
      page = await context.newPage();
    }
    const finished = exported + rejected.length + failures.length;
    if (finished && finished % 50 === 0) {
      console.log(`WebMainBench export ${finished}/${queued || "?"}`);
    }
  }
  await context.close();
}

async function produce() {
  const lines = createInterface({
    input: createReadStream(source, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let index = -1;
  try {
    for await (const line of lines) {
      index += 1;
      if (index < offset) continue;
      if (considered >= limit) break;
      considered += 1;
      const record = JSON.parse(line);
      const fullValues = annotationValues(record.html);
      const mainValues = annotationValues(record.main_html);
      const fullSet = new Set(fullValues);
      const mainSet = new Set(mainValues);
      if (!fullValues.length || !mainValues.length
        || fullValues.length !== fullSet.size
        || mainValues.length !== mainSet.size
        || [...mainSet].some(value => !fullSet.has(value))) {
        rejected.push({
          index,
          id: `wmb-${record.track_id || index}`,
          reason: "invalid-annotation-identity",
          fullValues: fullValues.length,
          uniqueFullValues: fullSet.size,
          mainValues: mainValues.length,
          uniqueMainValues: mainSet.size,
        });
        continue;
      }
      queued += 1;
      await queue.push({ index, record, mainValues });
    }
    queue.close();
  } catch (error) {
    queue.close(error);
    throw error;
  }
}

try {
  await Promise.all([
    produce(),
    ...Array.from({ length: workers }, work),
  ]);
} finally {
  await browser.close();
}

const report = {
  schema: "qingzhou.webmainbench-tree-dp-training-export.v1",
  source,
  sourcePartition: "single-public-jsonl",
  output,
  offset,
  limit,
  considered,
  queued,
  exported,
  rejectedByLabelIntegrity: rejected.length,
  failures,
  rejected,
  splitCounts,
  languageCounts,
  minKnownTokenShare: MIN_KNOWN_TOKEN_SHARE,
  totalNodes,
  totalTokens,
  totalKnownTokens,
  knownTokenShare: totalTokens ? totalKnownTokens / totalTokens : 0,
  sourceSha256,
};
if (failures.length || exported + rejected.length !== considered) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  writeJsonAtomic(join(output, "export-report.json"), report);
  console.log(JSON.stringify({ ...report, rejected: rejected.slice(0, 20) }, null, 2));
}
