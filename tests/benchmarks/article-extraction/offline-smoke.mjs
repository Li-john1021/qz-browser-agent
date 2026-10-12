#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { ensureTestExtension } from "../../support/extension-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: {
  baseline: { type: "string" },
  output: { type: "string", default: "tests/results/article-extraction/offline-smoke.json" },
  samples: { type: "string", default: "30" },
} });
const samples = Number(values.samples);
assert.ok(Number.isInteger(samples) && samples >= 10 && samples <= 200, "samples must be an integer from 10 to 200");
const warmups = 5;
const digest = value => createHash("sha256").update(value).digest("hex");
const paragraph = index => `第 ${index} 段观测记录说明海洋采样的时间、地点、仪器校准和数据复核流程。研究人员公开结果，逐项解释误差来源，并保留后续验证所需的原始记录。`;
const fixtures = [
  {
    id: "article",
    body: `<header><nav>辅助导航</nav></header><article><h1>海洋观测报告</h1>${Array.from({ length: 15 }, (_, i) => `<p>${paragraph(i + 1)}</p>`).join("")}</article><footer>站点版权</footer>`,
    includes: ["# 海洋观测报告", paragraph(1), paragraph(15)],
    excludes: ["辅助导航", "站点版权"],
  },
  {
    id: "collection",
    body: `<header><nav>辅助导航</nav></header><main>${Array.from({ length: 10 }, (_, i) => `<article><h2>观测条目 ${i + 1}</h2><p>${paragraph(i + 1).repeat(5)}</p></article>`).join("")}</main><footer>站点版权</footer>`,
    includes: Array.from({ length: 10 }, (_, i) => `观测条目 ${i + 1}`),
    excludes: ["辅助导航", "站点版权"],
  },
  {
    id: "structured",
    body: `<article><h1>Structured report</h1><p>${"The report preserves measured results and reproducible procedures. ".repeat(12)}</p><h2>Steps</h2><ul><li>Calibrate equipment</li><li>Record observations</li></ul><h2>Results</h2><table><thead><tr><th>Station</th><th>Samples</th></tr></thead><tbody><tr><td>Alpha</td><td>42</td></tr></tbody></table><pre><code>const answer = 42;</code></pre></article>`,
    includes: ["# Structured report", "-   Calibrate equipment", "-   Record observations", "| Station | Samples |", "| Alpha | 42 |", "```\nconst answer = 42;\n```"],
  },
  { id: "empty", body: "<main></main>", includes: [], empty: true },
].map(fixture => ({ ...fixture, html: `<!doctype html><html lang="${fixture.id === "structured" ? "en" : "zh"}"><head><title>Offline ${fixture.id}</title><base href="https://fixture.invalid/"></head><body>${fixture.body}</body></html>` }));

const extension = await ensureTestExtension();
const scriptPaths = [
  "content/article-extractor.js", "content/content-script.js",
];
const currentSources = await Promise.all(scriptPaths.map(path => readFile(resolve(extension, path), "utf8")));
const variants = [{ id: "current", paths: scriptPaths, sources: currentSources, source: "development build" }];
if (values.baseline) {
  const commit = execFileSync("git", ["rev-parse", "--verify", `${values.baseline}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  const manifest = JSON.parse(execFileSync("git", ["show", `${commit}:extension/manifest.json`], { cwd: root, encoding: "utf8" }));
  const paths = manifest.content_scripts.find(entry => entry.js?.includes("content/content-script.js")).js;
  const sources = paths.map(path => execFileSync("git", ["show", `${commit}:extension/${path}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  variants.unshift({ id: "baseline", paths, sources, source: commit });
}
const browser = await chromium.launch({ headless: true });
let blockedRequests = 0;
const report = {
  schema: "qingzhou.article-extraction-offline-smoke.v1",
  scope: "Synthetic correctness and timing smoke; not a real-world corpus quality score or a performance budget.",
  environment: { node: process.version, chromium: browser.version(), os: platform(), arch: arch(), cpu: cpus()[0]?.model },
  measurement: { warmups, samples, methods: ["extract", "readArticle"], unit: "ms", includes: "In-page extraction only; readArticle also includes serialization. Build, injection, DOM setup and protocol transfer are excluded." },
  variants: variants.map(variant => ({ id: variant.id, source: variant.source, scripts: Object.fromEntries(variant.paths.map((path, i) => [path, digest(variant.sources[i])])) })),
  fixtures: [],
};

function summarize(timings) {
  const sorted = timings.toSorted((a, b) => a - b);
  return { p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], samples: timings };
}

try {
  for (const fixture of fixtures) {
    const runs = [];
    for (const variant of variants) {
      const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: "block" });
      await context.route("**/*", route => { blockedRequests++; return route.abort(); });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(error.message));
      await page.setContent(fixture.html);
      await page.evaluate(() => {
        let listener;
        Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime: {
          getManifest: () => ({ name: "Offline extraction fixture", version: "0.0.0" }),
          onMessage: { addListener(value) { listener = value; } },
          sendMessage: async () => ({ ok: true }),
        } } });
        globalThis.__offlineReadArticle = () => new Promise(resolve => listener({ action: "readArticle", source: "auto", limit: 20_000 }, {}, resolve));
      });
      for (const source of variant.sources) await page.addScriptTag({ content: source });
      runs.push({ variant, context, page, pageErrors, timings: { extract: [], readArticle: [] }, outputs: {} });
    }
    for (let iteration = -warmups; iteration < samples; iteration++) {
      // Alternate old/new execution order to reduce systematic warm-cache bias.
      for (const run of iteration % 2 ? runs.toReversed() : runs) {
        for (const method of ["extract", "readArticle"]) {
          const { elapsed, result } = await run.page.evaluate(async method => {
            const started = performance.now();
            const value = method === "extract"
              ? globalThis.QingzhouArticleExtractor.extract(document, { complete: true })
              : await globalThis.__offlineReadArticle();
            const elapsed = performance.now() - started;
            const result = method === "extract" && value
              ? { name: value.name, content: value.content, text: value.text, length: value.length }
              : value;
            return { elapsed, result };
          }, method);
          if (iteration === -warmups) run.outputs[method] = result;
          else assert.deepEqual(result, run.outputs[method], `${fixture.id}/${run.variant.id}/${method}: unstable output`);
          if (iteration >= 0) run.timings[method].push(elapsed);
        }
      }
    }
    const output = { id: fixture.id, inputSha256: digest(fixture.html), variants: {} };
    for (const run of runs) {
      const article = run.outputs.readArticle;
      assert.deepEqual(run.pageErrors, [], `${fixture.id}/${run.variant.id}: page errors`);
      assert.equal(article.error, undefined);
      assert.equal(article.hasMore, false, `${fixture.id}: fixture must fit one canonical page`);
      assert.equal(article.totalChars, article.text.length);
      for (const text of fixture.includes) assert.ok(article.text.includes(text), `${fixture.id}: missing ${text}\n${article.text}`);
      for (const text of fixture.excludes || []) assert.ok(!article.text.includes(text), `${fixture.id}: retained noise ${text}`);
      if (fixture.empty) assert.equal(article.text, "", "empty page must not invent content");
      assert.deepEqual(run.outputs, runs[0].outputs, `${fixture.id}: baseline/current output changed`);
      output.variants[run.variant.id] = {
        outputSha256: digest(JSON.stringify(run.outputs)),
        chars: article.text.length,
        candidate: run.outputs.extract?.name || null,
        extract: summarize(run.timings.extract),
        readArticle: summarize(run.timings.readArticle),
      };
      await run.context.close();
    }
    report.fixtures.push(output);
  }
} finally {
  await browser.close();
}
report.blockedRequests = blockedRequests;
const outputPath = resolve(root, values.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ report: outputPath, fixtures: report.fixtures.map(({ id, variants }) => ({ id, variants: Object.fromEntries(Object.entries(variants).map(([name, value]) => [name, { chars: value.chars, extractP50: value.extract.p50, extractP95: value.extract.p95, readArticleP50: value.readArticle.p50, readArticleP95: value.readArticle.p95 }])) })), blockedRequests }, null, 2));
