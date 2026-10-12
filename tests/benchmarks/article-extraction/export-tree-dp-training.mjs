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
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { instrumentArticleExtractorSource } from "./instrument-extractor.mjs";
import { registrableDomain } from "./corpus-diversity-audit.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const defaultCorpus = join(root, "tests/results/article-extraction/zh-realworld-1500-v3");

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

function registrableSiteFallback(sample) {
  return String(sample.siteFamily
    || registrableDomain(sample.finalUrl || sample.requestedUrl || sample.url)
    || sample.siteId
    || "");
}

const corpus = resolve(option("--corpus", defaultCorpus));
const manifestPath = resolve(option("--manifest", join(corpus, "manifest.json")));
const labels = resolve(option("--labels", join(corpus, "manual-labels-final-v1")));
const output = resolve(option(
  "--output",
  join(corpus, "workspaces/tree-dp/loss-v1/units"),
));
const workers = numberOption("--workers", 4);
const limit = numberOption("--limit", Number.MAX_SAFE_INTEGER);
const validationEvaluation = process.argv.includes("--validation-evaluation");
const defaultSplits = validationEvaluation ? "validation" : "base,train";
const splits = new Set(option("--splits", defaultSplits).split(",").map(value => value.trim()).filter(Boolean));
const allowedSplits = validationEvaluation
  ? new Set(["validation"])
  : new Set(["base", "train"]);
for (const split of splits) {
  if (!allowedSplits.has(split)) {
    const purpose = validationEvaluation ? "validation evaluation" : "training";
    throw new Error(`${purpose} export is fail-closed to ${[...allowedSplits].join(",")}; refusing split: ${split}`);
  }
}

const requestedIds = new Set(option("--ids", "").split(",").map(value => value.trim()).filter(Boolean));
const manifest = json(manifestPath);
const allSamples = Array.isArray(manifest) ? manifest : manifest.samples;
if (!Array.isArray(allSamples)) throw new Error("corpus manifest has no samples array");
const samples = allSamples.filter(sample => (
  splits.has(sample.evaluationSplit || "base")
  && (!requestedIds.size || requestedIds.has(sample.id))
)).slice(0, limit);
if (!samples.length) throw new Error("training export selected no samples");
if (requestedIds.size && samples.length !== requestedIds.size) {
  const found = new Set(samples.map(sample => sample.id));
  const missing = [...requestedIds].filter(id => !found.has(id));
    throw new Error(`requested sample ids were not found in ${[...allowedSplits].join(",")}: ${missing.join(", ")}`);
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
  manifest: fileSha256(manifestPath),
  labelsManifest: existsSync(join(labels, "manifest.json"))
    ? fileSha256(join(labels, "manifest.json"))
    : null,
});

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let cursor = 0;
let exported = 0;
const failures = [];
const splitCounts = {};
const statusCounts = {};
let totalNodes = 0;
let totalTokens = 0;
let goldUnknownTokenNodes = 0;
let forcedTreeUnavailable = 0;

async function work() {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  await context.addInitScript({
    content: readFileSync(readabilityPath, "utf8"),
  });
  await context.addInitScript({ content: instrumentedExtractor });
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.url().startsWith("file:")) {
      await route.abort();
      return;
    }
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      const snapshotPath = fileURLToPath(request.url());
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "content-security-policy": "script-src 'none'; object-src 'none'; base-uri 'none'",
        },
        body: readFileSync(snapshotPath),
      });
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  for (;;) {
    const index = cursor++;
    if (index >= samples.length) break;
    const sample = samples[index];
    const split = sample.evaluationSplit || "base";
    const labelPath = join(labels, "labels", `${sample.id}.json`);
    const target = join(output, `${sample.id}.json.gz`);
    try {
      if (!existsSync(labelPath)) throw new Error("human label is missing");
      const label = json(labelPath);
      if (label.sampleId !== sample.id || label.inputSha256 !== sample.inputSha256) {
        throw new Error("human label identity does not match manifest sample");
      }
      if (!inside(corpus, resolve(corpus, sample.snapshot))) {
        throw new Error("snapshot escapes the corpus directory");
      }
      await page.goto(pathToFileURL(resolve(corpus, sample.snapshot)).href, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await page.addStyleTag({
        content: "*,*::before,*::after{animation:none!important;transition:none!important}",
      });
      await page.evaluate(() => new Promise(resolveFrame => (
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
      )));
      const result = await page.evaluate((goldSelection) => (
        globalThis.__qingzhouArticleBenchmark.collect(document, {
          provenance: true,
          goldSelection,
        })
      ), {
        status: label.status,
        includeRegionIds: label.selection?.includeRegionIds || [],
        excludeRegionIds: label.selection?.excludeRegionIds || [],
      });
      const provenance = result?.diagnostics?.provenance;
      const tree = provenance?.sourceTree?.treeElements;
      const gold = provenance?.gold;
      const forced = result?.diagnostics?.forcedTreeDp;
      if (provenance?.schema !== "qingzhou.article-extraction-provenance.v1"
        || gold?.schema !== "qingzhou.article-extraction-tree-dp-gold-selection.v1"
        || !Array.isArray(tree)) {
        throw new Error("instrumented extractor returned incomplete training provenance");
      }
      if (gold.requestedInclude !== gold.resolvedInclude
        || gold.requestedExclude !== gold.resolvedExclude) {
        throw new Error("gold region selection did not resolve exactly");
      }
      if (forced && tree.length !== forced.nodeCount) {
        throw new Error(`Tree-DP coordinate mismatch: ${tree.length} != ${forced.nodeCount}`);
      }
      const pageTokens = tree.reduce((sum, element) => sum + element.tokens, 0);
      if (forced && pageTokens !== forced.pageTokens) {
        throw new Error(`Tree-DP token mismatch: ${pageTokens} != ${forced.pageTokens}`);
      }
      const unknown = tree.filter(element => element.tokens > 0 && !element.goldKnown).length;
      const record = {
        schema: "qingzhou.article-extraction-tree-dp-training-page.v2",
        id: sample.id,
        siteId: sample.siteId,
        siteFamily: registrableSiteFallback(sample),
        type: sample.type,
        vertical: sample.vertical,
        split,
        status: label.status,
        inputSha256: sample.inputSha256,
        labelSha256: fileSha256(labelPath),
        sourceSha256,
        snapshotReplay: {
          scripts: "blocked-by-csp",
          motion: "disabled-by-injected-style",
        },
        reference: {
          mainText: String(label.reference?.mainText || ""),
          requiredBlocks: label.reference?.requiredBlocks || [],
          noiseBlocks: label.reference?.noiseBlocks || [],
        },
        gold,
        tree: provenance.sourceTree,
        shipped: forced || {
          schema: "qingzhou.article-extraction-tree-dp-diagnostics.v1",
          available: false,
          nodeCount: tree.length,
          pageTokens,
        },
        parity: {
          nodeCount: tree.length,
          pageTokens,
          unknownTokenNodes: unknown,
        },
      };
      writeGzipJsonAtomic(target, record);
      exported += 1;
      splitCounts[split] = (splitCounts[split] || 0) + 1;
      statusCounts[label.status] = (statusCounts[label.status] || 0) + 1;
      totalNodes += tree.length;
      totalTokens += pageTokens;
      goldUnknownTokenNodes += unknown;
      if (!forced) forcedTreeUnavailable += 1;
    } catch (error) {
      failures.push({ id: sample.id, error: String(error?.message || error) });
    }
    if ((index + 1) % 50 === 0) console.log(`tree-dp export ${index + 1}/${samples.length}`);
  }
  await context.close();
}

function inside(parent, child) {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

try {
  await Promise.all(Array.from({ length: Math.min(workers, samples.length) }, work));
} finally {
  await browser.close();
}

const report = {
  schema: "qingzhou.article-extraction-tree-dp-training-export.v2",
  corpus,
  labels,
  output,
  requestedSplits: [...splits].sort(),
  purpose: validationEvaluation ? "locked-validation-evaluation" : "training",
  testOpened: false,
  snapshotExecution: "disabled-by-csp",
  snapshotMotion: "disabled-by-injected-style",
  selectedSamples: samples.length,
  exported,
  failures,
  splitCounts,
  statusCounts,
  totalNodes,
  totalTokens,
  goldUnknownTokenNodes,
  forcedTreeUnavailable,
  sourceSha256,
};
if (failures.length || exported !== samples.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} else {
  writeJsonAtomic(join(output, "export-report.json"), report);
  console.log(JSON.stringify(report, null, 2));
}
