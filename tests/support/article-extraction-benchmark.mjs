import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTestExtension } from "./extension-build.mjs";
import { prepareUpstreamArticleAssets } from "./upstream-article-assets.mjs";

const extensionDir = await ensureTestExtension();

export const core = JSON.parse(readFileSync(new URL("../benchmarks/article-extraction/chinese-realworld-sites.json", import.meta.url)));
export const increment = JSON.parse(readFileSync(new URL("../benchmarks/article-extraction/chinese-realworld-increment-v2.json", import.meta.url)));
export const expansion = JSON.parse(readFileSync(new URL("../benchmarks/article-extraction/chinese-realworld-expansion-v3.json", import.meta.url)));
export const expansionSupplement = JSON.parse(readFileSync(new URL("../benchmarks/article-extraction/chinese-realworld-expansion-v3-supplement.json", import.meta.url)));
export const upstreamComparison = readFileSync(new URL("../benchmarks/article-extraction/compare-upstream.mjs", import.meta.url), "utf8");
export const upstreamComparisonRunner = fileURLToPath(new URL("../benchmarks/article-extraction/compare-upstream.mjs", import.meta.url));
export const upstreamRunner = readFileSync(new URL("../benchmarks/article-extraction/upstream-runner.py", import.meta.url), "utf8");
export const rerankerEvaluator = fileURLToPath(new URL("../benchmarks/article-extraction/evaluate-reranker.py", import.meta.url));
export const realworldRunner = fileURLToPath(new URL("../benchmarks/article-extraction/realworld.mjs", import.meta.url));
export const manualAnnotateRunner = fileURLToPath(new URL("../benchmarks/article-extraction/manual-annotate.mjs", import.meta.url));
export const readabilityScript = (await prepareUpstreamArticleAssets()).readability;
export const articleExtractorScript = join(extensionDir, "content/article-extractor.js");
export const contentScript = join(extensionDir, "content/content-script.js");
export const fastCaptureSettleArgs = Object.freeze([
  "--settle-scroll-ms", "50",
  "--settle-sample-ms", "35",
  "--settle-min-ms", "300",
  "--settle-max-ms", "700",
]);

export function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function writeFixtureCorpus(directory, manifest) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function fixtureSample(corpus, name, url, options = {}) {
  const html = Buffer.from(options.html || `<html><body>${name}</body></html>`);
  const inputSha256 = digest(html);
  const snapshot = `source/${name}.html`;
  mkdirSync(join(corpus, "source"), { recursive: true });
  writeFileSync(join(corpus, snapshot), html);
  let screenshot = "";
  if (options.screenshot) {
    screenshot = `audit/${name}.jpeg`;
    mkdirSync(join(corpus, "audit"), { recursive: true });
    writeFileSync(join(corpus, screenshot), options.screenshot);
  }
  return {
    id: `old-${name}`,
    siteId: name,
    type: "detail",
    url,
    finalUrl: url,
    inputSha256,
    snapshot,
    screenshot,
    reference: { confidence: "high", requiredBlocks: [`reference-${name}`] },
    captureEvidence: { source: "fixture-live-dom", liveDomSha256: `live-${name}` },
    ...(options.metadata || {}),
  };
}

export function runCompose(base, incrementDirectory, output, supplements = []) {
  const args = [
    realworldRunner,
    "compose",
    "--base",
    base,
    "--increment",
    incrementDirectory,
  ];
  for (const supplement of supplements) args.push("--supplement", supplement);
  args.push(
    "--output",
    output,
  );
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

export function runAsync(command, commandArgs, options = {}) {
  return new Promise(resolvePromise => {
    const child = spawn(command, commandArgs, { encoding: "utf8", ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", value => { stdout += value; });
    child.stderr?.on("data", value => { stderr += value; });
    child.on("close", status => resolvePromise({ status, stdout, stderr }));
  });
}
