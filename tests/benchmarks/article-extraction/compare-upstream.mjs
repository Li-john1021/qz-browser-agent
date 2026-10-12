import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { instrumentArticleExtractorSource } from "./instrument-extractor.mjs";
import { ensureTestExtension } from "../../support/extension-build.mjs";
import { prepareUpstreamArticleAssets } from "../../support/upstream-article-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const languageStratumNames = ["declared-English", "declared-German", "other/unknown"];

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

const defuddleBundle = option("--defuddle-bundle");
if (defuddleBundle && !existsSync(defuddleBundle)) {
  throw new Error(`Defuddle bundle does not exist: ${defuddleBundle}`);
}
const includeTreedp = process.argv.includes("--treedp");
const browserAlgorithmNames = [
  "legacy-readability",
  "qingzhou-current",
  ...(includeTreedp ? ["qingzhou-treedp"] : []),
  ...(defuddleBundle ? ["defuddle"] : []),
];
const algorithmNames = [...browserAlgorithmNames, "trafilatura-python"];
const algorithmPairs = [
  ["legacy-readability", "qingzhou-current"],
  ["legacy-readability", "trafilatura-python"],
  ["qingzhou-current", "trafilatura-python"],
];
if (includeTreedp) {
  algorithmPairs.push(
    ["qingzhou-current", "qingzhou-treedp"],
    ["legacy-readability", "qingzhou-treedp"],
    ["qingzhou-treedp", "trafilatura-python"],
  );
}
if (defuddleBundle) {
  for (const name of algorithmNames) {
    if (name !== "defuddle") algorithmPairs.push([name, "defuddle"]);
  }
}

const upstream = resolve(option("--upstream", "/tmp/qingzhou-trafilatura-source"));
const python = option("--python", "python3");
const output = resolve(option(
  "--output",
  join(root, "tests/results/article-extraction/upstream-comparison.json"),
));
const upstreamOutput = resolve(option(
  "--upstream-output",
  join(root, "tests/results/article-extraction/upstream-results.json"),
));

function commandOutput(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
  } catch (_error) {
    return "";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function normalized(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function countItem(item, result) {
  const value = normalized(result);
  const tp = item.with.filter(chunk => value.includes(normalized(chunk))).length;
  const fp = item.without.filter(chunk => value.includes(normalized(chunk))).length;
  return { tp, fp, fn: item.with.length - tp, tn: item.without.length - fp };
}

function auditItem(item, outputValue) {
  const value = normalized(outputValue?.text);
  const counts = countItem(item, value);
  return {
    strategy: outputValue?.strategy || "",
    error: outputValue?.error || "",
    timingMs: Number.isFinite(outputValue?.timingMs) ? outputValue.timingMs : null,
    ...counts,
    f1: itemF1(counts),
    missedPositiveChunks: item.with.filter(chunk => !value.includes(normalized(chunk))),
    includedNegativeChunks: item.without.filter(chunk => value.includes(normalized(chunk))),
  };
}

function add(matrix, counts) {
  for (const key of ["tp", "fp", "fn", "tn"]) matrix[key] += counts[key];
}

function scores(matrix) {
  const { tp, fp, fn, tn } = matrix;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const accuracy = tp + fp + fn + tn ? (tp + tn) / (tp + fp + fn + tn) : 0;
  const f1 = 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 0;
  return { precision, recall, accuracy, f1 };
}

function itemF1(counts) {
  return 2 * counts.tp + counts.fp + counts.fn
    ? (2 * counts.tp) / (2 * counts.tp + counts.fp + counts.fn)
    : 0;
}

function timingSummary(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = ratio => {
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * ratio;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return {
    kind: "extract-only",
    samples: sorted.length,
    meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
  };
}

function normalizedLanguageDeclaration(value) {
  const declaration = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  const primary = declaration.match(/^([a-z]{2,8})(?:-|$)/)?.[1] || "";
  return {
    declaration: declaration || "(missing)",
    stratum: primary === "en"
      ? "declared-English"
      : primary === "de"
        ? "declared-German"
        : "other/unknown",
  };
}

function languageAccumulator() {
  return {
    documents: 0,
    positiveChunks: 0,
    negativeChunks: 0,
    declarations: {},
    algorithms: Object.fromEntries(algorithmNames.map(name => [name, {
      matrix: { tp: 0, fp: 0, fn: 0, tn: 0 },
      errors: 0,
      timings: [],
    }])),
  };
}

function languageStrataReport(accumulators) {
  return {
    basis: "DOMParser documentElement lang attribute from each exact frozen HTML document",
    normalization: "trim, lowercase, replace underscore with hyphen, then group primary subtag en/de; all other, missing, and malformed declarations are other/unknown",
    documents: languageStratumNames.reduce((sum, name) => sum + accumulators[name].documents, 0),
    groups: Object.fromEntries(languageStratumNames.map(name => {
      const accumulator = accumulators[name];
      return [name, {
        documents: accumulator.documents,
        positiveChunks: accumulator.positiveChunks,
        negativeChunks: accumulator.negativeChunks,
        declarations: Object.fromEntries(Object.entries(accumulator.declarations)
          .sort(([left], [right]) => left.localeCompare(right))),
        algorithms: Object.fromEntries(algorithmNames.map(algorithm => {
          const result = accumulator.algorithms[algorithm];
          return [algorithm, {
            ...result.matrix,
            ...scores(result.matrix),
            errors: result.errors,
            timing: timingSummary(result.timings),
          }];
        })),
      }];
    })),
  };
}

function decodeHtml(buffer) {
  const prefix = buffer.subarray(0, 16_384).toString("latin1");
  const label = prefix.match(/<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1]
    || prefix.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';]+)/i)?.[1]
    || "utf-8";
  try {
    return new TextDecoder(label).decode(buffer);
  } catch (_error) {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function corpusPath(testsDir, file) {
  for (const folder of ["cache", "eval"]) {
    const path = join(testsDir, folder, file);
    if (existsSync(path)) return path;
  }
  return "";
}

function loadCorpus(testsDir, annotations, annotationsBytes) {
  const documents = new Map();
  const digest = createHash("sha256");
  digest.update(annotationsBytes);
  for (const url of Object.keys(annotations).sort()) {
    const item = annotations[url];
    const path = corpusPath(testsDir, item.file);
    if (!path) throw new Error(`missing corpus file: ${item.file}`);
    const bytes = readFileSync(path);
    const relativePath = relative(testsDir, path).replaceAll("\\", "/");
    digest.update(relativePath);
    digest.update(bytes);
    documents.set(url, { path, relativePath, bytes });
  }
  return { documents, combinedSha256: digest.digest("hex") };
}

function upstreamCacheIsCurrent(payload, expected) {
  return payload
    && payload.upstreamCommit === expected.upstreamCommit
    && payload.corpusSha256 === expected.corpusSha256
    && payload.runnerSha256 === expected.runnerSha256
    && Object.keys(payload.results || {}).length === expected.documents
    && Object.keys(payload.timingsMs || {}).length === expected.documents;
}

async function runBrowserAlgorithms(page, source, url = "") {
  return page.evaluate(({ html, pageUrl, includeDefuddle, includeTreedpFlag }) => {
    const documentInput = new DOMParser().parseFromString(html, "text/html");
    const declaredLanguage = documentInput.documentElement?.getAttribute("lang") || "";
    const errorText = error => `${error?.name || "Error"}: ${error?.message || error}`;
    const parseReadability = () => {
      try {
        return new Readability(documentInput.cloneNode(true), {
          charThreshold: 0,
          keepClasses: false,
        }).parse();
      } catch (_error) {
        return null;
      }
    };

    const legacyStarted = performance.now();
    let legacy = { text: "", strategy: "", error: "" };
    try {
      const parsed = parseReadability();
      if (parsed && String(parsed.textContent || "").trim()) {
        legacy = { text: parsed.textContent || "", strategy: "readability", error: "" };
      } else {
        const root = documentInput.querySelector("main,article,[role='main']") || documentInput.body;
        const clone = root?.cloneNode(true);
        clone?.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,form,button")
          .forEach(element => element.remove());
        legacy = {
          text: clone?.innerText || clone?.textContent || "",
          strategy: "body-fallback",
          error: "",
        };
      }
    } catch (error) {
      legacy = { text: "", strategy: "", error: errorText(error) };
    }
    legacy.timingMs = performance.now() - legacyStarted;

    const currentStarted = performance.now();
    let current = { text: "", strategy: "", error: "" };
    try {
      const readability = parseReadability();
      const candidate = globalThis.QingzhouArticleExtractor.extract(documentInput, { readability });
      current = {
        text: candidate?.text || "",
        strategy: candidate?.name || "",
        error: "",
      };
    } catch (error) {
      current = { text: "", strategy: "", error: errorText(error) };
    }
    current.timingMs = performance.now() - currentStarted;

    let treedp = null;
    if (includeTreedpFlag) {
      // Candidate body timing comes from the probe's own attempt measurement so
      // the shared prepareDocument/collect overhead is not billed to tree-DP.
      const treedpStarted = performance.now();
      let summary = null;
      try {
        summary = globalThis.__qingzhouArticleBenchmark.collect(documentInput);
        globalThis.__qingzhouArticleBenchmark.force("treedp");
        const candidate = globalThis.QingzhouArticleExtractor.extract(documentInput);
        treedp = {
          text: candidate?.text || "",
          strategy: candidate?.name || "",
          error: "",
        };
      } catch (error) {
        treedp = { text: "", strategy: "", error: errorText(error) };
      } finally {
        try { globalThis.__qingzhouArticleBenchmark.clear(); } catch (_error) { /* ignore */ }
      }
      const descriptor = summary?.candidates?.find?.(entry => entry.key === "treedp");
      treedp.timingMs = Number.isFinite(descriptor?.elapsedMs)
        ? descriptor.elapsedMs
        : performance.now() - treedpStarted;
    }

    let defuddle = null;
    if (includeDefuddle) {
      const defuddleStarted = performance.now();
      try {
        const parsed = new globalThis.Defuddle(documentInput.cloneNode(true), {
          url: pageUrl,
          useAsync: false,
        }).parse();
        const content = String(parsed?.content || "");
        const parsedContent = new DOMParser().parseFromString(content, "text/html");
        defuddle = {
          text: parsedContent.body?.innerText || parsedContent.body?.textContent || "",
          strategy: parsed?.extractorType || "generic",
          error: "",
        };
      } catch (error) {
        defuddle = { text: "", strategy: "", error: errorText(error) };
      }
      defuddle.timingMs = performance.now() - defuddleStarted;
    }
    return {
      declaredLanguage,
      algorithms: {
        "legacy-readability": legacy,
        "qingzhou-current": current,
        ...(treedp ? { "qingzhou-treedp": treedp } : {}),
        ...(defuddle ? { defuddle } : {}),
      },
    };
  }, {
    html: source,
    pageUrl: url,
    includeDefuddle: Boolean(defuddleBundle),
    includeTreedpFlag: includeTreedp,
  });
}

function comparisonKey(left, right) {
  return `${left}_vs_${right}`;
}

function disagreementFingerprint(result) {
  return JSON.stringify({
    error: result.error,
    tp: result.tp,
    fp: result.fp,
    fn: result.fn,
    tn: result.tn,
    missedPositiveChunks: result.missedPositiveChunks,
    includedNegativeChunks: result.includedNegativeChunks,
  });
}

const testsDir = join(upstream, "tests");
const annotationsPath = join(testsDir, "evaldata.json");
const annotationsBytes = readFileSync(annotationsPath);
const annotations = JSON.parse(annotationsBytes.toString("utf8"));
const { documents, combinedSha256 } = loadCorpus(testsDir, annotations, annotationsBytes);
const upstreamRunnerPath = join(here, "upstream-runner.py");
const upstreamRunnerSha256 = fileSha256(upstreamRunnerPath);
const expectedUpstream = {
  upstreamCommit: commandOutput("git", ["-C", upstream, "rev-parse", "HEAD"]),
  corpusSha256: combinedSha256,
  runnerSha256: upstreamRunnerSha256,
  documents: Object.keys(annotations).length,
};

let upstreamPayload = null;
if (existsSync(upstreamOutput)) {
  try {
    upstreamPayload = JSON.parse(readFileSync(upstreamOutput, "utf8"));
  } catch (_error) {}
}
const refreshUpstream = process.argv.includes("--refresh-upstream")
  || !upstreamCacheIsCurrent(upstreamPayload, expectedUpstream);

mkdirSync(dirname(output), { recursive: true });
if (refreshUpstream) {
  execFileSync(python, [
    upstreamRunnerPath,
    "--upstream", upstream,
    "--output", upstreamOutput,
    "--corpus-sha256", combinedSha256,
    "--runner-sha256", upstreamRunnerSha256,
  ], { stdio: "inherit" });
  upstreamPayload = JSON.parse(readFileSync(upstreamOutput, "utf8"));
}
if (!upstreamCacheIsCurrent(upstreamPayload, expectedUpstream)) {
  throw new Error("upstream result provenance does not match the current runner and frozen corpus");
}

const extensionDir = await ensureTestExtension();
const readabilityPath = (await prepareUpstreamArticleAssets()).readability;
const articleExtractorPath = join(extensionDir, "content/article-extractor.js");
const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const page = await browser.newPage({ javaScriptEnabled: true });
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: readabilityPath });
if (includeTreedp) {
  // The tree-DP candidate lives in the benchmark probe; inject the same
  // instrumented source the Chinese real-world harness uses.
  await page.addScriptTag({
    content: instrumentArticleExtractorSource(readFileSync(articleExtractorPath, "utf8")),
  });
  if (await page.evaluate(() => typeof globalThis.__qingzhouArticleBenchmark?.collect) !== "function") {
    throw new Error("instrumented extractor did not expose the benchmark probe");
  }
} else {
  await page.addScriptTag({ path: articleExtractorPath });
}
if (defuddleBundle) await page.addScriptTag({ path: resolve(defuddleBundle) });
if (defuddleBundle && await page.evaluate(() => typeof globalThis.Defuddle) !== "function") {
  throw new Error("Defuddle bundle did not expose globalThis.Defuddle");
}
await runBrowserAlgorithms(page, "<!doctype html><article><p>Benchmark warm-up article text.</p></article>");

const matrices = Object.fromEntries(algorithmNames.map(name => [name, { tp: 0, fp: 0, fn: 0, tn: 0 }]));
const errors = Object.fromEntries(algorithmNames.map(name => [name, 0]));
const timings = Object.fromEntries(algorithmNames.map(name => [name, []]));
const strategies = Object.fromEntries(algorithmNames.map(name => [name, {}]));
const headToHead = Object.fromEntries(algorithmPairs.map(([left, right]) => [comparisonKey(left, right), {
  left,
  right,
  leftWins: 0,
  ties: 0,
  rightWins: 0,
}]));
const disagreements = [];
const languageAccumulators = Object.fromEntries(languageStratumNames.map(name => [name, languageAccumulator()]));
const browserLoopStarted = performance.now();

for (const [index, [url, item]] of Object.entries(annotations).entries()) {
  const document = documents.get(url);
  const source = decodeHtml(document.bytes);
  let browserOutputs;
  let language = normalizedLanguageDeclaration("");
  try {
    const browserResult = await runBrowserAlgorithms(page, source, url);
    browserOutputs = browserResult.algorithms;
    language = normalizedLanguageDeclaration(browserResult.declaredLanguage);
  } catch (error) {
    const message = `${error?.name || "Error"}: ${error?.message || error}`;
    browserOutputs = Object.fromEntries(browserAlgorithmNames.map(name => [name, {
      text: "", strategy: "", error: message, timingMs: null,
    }]));
  }
  const outputs = {
    ...browserOutputs,
    "trafilatura-python": {
      text: upstreamPayload.results[url] || "",
      strategy: "standard",
      error: upstreamPayload.errors[url] || "",
      timingMs: upstreamPayload.timingsMs[url],
    },
  };
  const audited = {};
  const languageGroup = languageAccumulators[language.stratum];
  languageGroup.documents += 1;
  languageGroup.positiveChunks += item.with.length;
  languageGroup.negativeChunks += item.without.length;
  languageGroup.declarations[language.declaration] = (languageGroup.declarations[language.declaration] || 0) + 1;
  for (const name of algorithmNames) {
    const result = auditItem(item, outputs[name]);
    audited[name] = result;
    add(matrices[name], result);
    if (result.error) errors[name] += 1;
    if (Number.isFinite(result.timingMs)) timings[name].push(result.timingMs);
    const strategy = result.strategy || "unknown";
    strategies[name][strategy] = (strategies[name][strategy] || 0) + 1;
    const languageAlgorithm = languageGroup.algorithms[name];
    add(languageAlgorithm.matrix, result);
    if (result.error) languageAlgorithm.errors += 1;
    if (Number.isFinite(result.timingMs)) languageAlgorithm.timings.push(result.timingMs);
  }
  for (const [left, right] of algorithmPairs) {
    const comparison = headToHead[comparisonKey(left, right)];
    if (audited[left].f1 > audited[right].f1) comparison.leftWins += 1;
    else if (audited[left].f1 < audited[right].f1) comparison.rightWins += 1;
    else comparison.ties += 1;
  }
  if (new Set(algorithmNames.map(name => disagreementFingerprint(audited[name]))).size > 1) {
    disagreements.push({ url, file: item.file, algorithms: audited });
  }
  if ((index + 1) % 100 === 0) console.log(`extractors ${index + 1}/${Object.keys(annotations).length}`);
}

const browserLoopElapsedSeconds = (performance.now() - browserLoopStarted) / 1000;
await browser.close();

const gitStatus = commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
const playwrightPackage = JSON.parse(readFileSync(join(root, "node_modules/playwright/package.json"), "utf8"));
const report = {
  schema: "qingzhou.article-extraction-upstream.v3",
  corpus: {
    upstream,
    upstreamCommit: expectedUpstream.upstreamCommit,
    combinedSha256,
    evaldataSha256: sha256(annotationsBytes),
    documents: Object.keys(annotations).length,
    positiveChunks: Object.values(annotations).reduce((sum, item) => sum + item.with.length, 0),
    negativeChunks: Object.values(annotations).reduce((sum, item) => sum + item.without.length, 0),
  },
  configuration: {
    includeComments: false,
    includeTables: true,
    includeFormatting: false,
    scoring: "whitespace-normalized substring classification",
    timing: "one warm-up followed by one extract-only measurement per document; DOMParser, disk I/O, process startup, and Playwright transport are excluded from browser timings",
    ...(includeTreedp ? {
      treedp: {
        mode: "ungated shipped candidate",
        timing: "isolated Tree-DP candidate body; benchmark diagnostic replay is excluded",
      },
    } : {}),
    ...(defuddleBundle ? {
      defuddle: {
        bundle: resolve(defuddleBundle),
        serializer: "not measured by the upstream text benchmark",
        useAsync: false,
      },
    } : {}),
  },
  algorithms: Object.fromEntries(algorithmNames.map(name => [name, {
    ...matrices[name],
    ...scores(matrices[name]),
    errors: errors[name],
    strategies: strategies[name],
    timing: timingSummary(timings[name]),
  }])),
  languageStrata: languageStrataReport(languageAccumulators),
  execution: {
    browserLoopElapsedSeconds,
    pythonLoopElapsedSeconds: upstreamPayload.elapsedSeconds,
  },
  headToHead,
  disagreements,
  provenance: {
    qingzhouGitCommit: commandOutput("git", ["rev-parse", "HEAD"], { cwd: root }),
    qingzhouGitDirty: Boolean(gitStatus),
    qingzhouGitStatusSha256: sha256(gitStatus),
    treedpCandidate: includeTreedp,
    sourceSha256: {
      readability: fileSha256(readabilityPath),
      articleExtractor: fileSha256(articleExtractorPath),
      comparisonRunner: fileSha256(fileURLToPath(import.meta.url)),
      upstreamRunner: upstreamRunnerSha256,
      ...(includeTreedp ? {
        instrumentExtractor: fileSha256(join(here, "instrument-extractor.mjs")),
      } : {}),
      ...(defuddleBundle ? { defuddle: fileSha256(resolve(defuddleBundle)) } : {}),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      playwright: playwrightPackage.version,
      chromium: browserVersion,
      python: upstreamPayload.python,
      trafilatura: upstreamPayload.trafilaturaVersion,
    },
  },
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  corpus: report.corpus,
  algorithms: report.algorithms,
  languageStrata: report.languageStrata,
  headToHead: report.headToHead,
  disagreements: report.disagreements.length,
  output,
}, null, 2));
