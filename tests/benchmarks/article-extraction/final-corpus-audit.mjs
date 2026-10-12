#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditDiversity,
  canonicalizeUrl,
  registrableDomain,
} from "./corpus-diversity-audit.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");

function readCorpus(value, label) {
  const corpusDir = resolve(value);
  const manifestPath = join(corpusDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${label} has no manifest.json: ${corpusDir}`);
  const bytes = readFileSync(manifestPath);
  return {
    corpusDir,
    manifestPath,
    manifestSha256: sha256(bytes),
    manifest: JSON.parse(bytes.toString("utf8")),
  };
}

function assetPath(corpusDir, value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is missing`);
  const path = isAbsolute(value) ? resolve(value) : resolve(corpusDir, value);
  if (path !== corpusDir && !path.startsWith(`${corpusDir}${sep}`)) {
    throw new Error(`${label} escapes its corpus directory`);
  }
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${value}`);
  return path;
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function duplicateExcess(groups) {
  return (groups || []).reduce((total, group) => total + group.count - 1, 0);
}

function sampleIdentity(sample) {
  return {
    canonicalUrl: canonicalizeUrl(sample.finalUrl || sample.requestedUrl || sample.url || ""),
    inputSha256: String(sample.inputSha256 || "").toLowerCase(),
    frozenDomSha256: String(sample.captureEvidence?.frozenDomSha256 || "").toLowerCase(),
    siteId: String(sample.siteId || ""),
    type: String(sample.type || sample.pageType || ""),
    vertical: String(sample.vertical || ""),
  };
}

function cellKey(value) {
  return JSON.stringify([
    String(value?.evaluationSplit || ""),
    String(value?.vertical || ""),
    String(value?.discoveredType || ""),
  ]);
}

function validateAssets(corpus, samples, policy, failures) {
  let snapshots = 0;
  let screenshots = 0;
  for (const [index, sample] of samples.entries()) {
    const id = sample.id || `sample-${index + 1}`;
    const inputSha256 = String(sample.inputSha256 || "").toLowerCase();
    const frozenDomSha256 = String(sample.captureEvidence?.frozenDomSha256 || "").toLowerCase();
    if (!SHA256_PATTERN.test(inputSha256)) failures.push(`${id}: invalid inputSha256`);
    if (!SHA256_PATTERN.test(frozenDomSha256)) failures.push(`${id}: invalid frozenDomSha256`);
    try {
      const snapshot = assetPath(corpus.corpusDir, sample.snapshot, `${id} snapshot`);
      const digest = sha256(readFileSync(snapshot));
      if (digest !== inputSha256) failures.push(`${id}: snapshot digest does not match inputSha256`);
      if (policy.requireContentAddressedAssets
        && basename(snapshot, extname(snapshot)).toLowerCase() !== inputSha256) {
        failures.push(`${id}: snapshot filename is not content-addressed`);
      }
      snapshots += 1;
    } catch (error) {
      failures.push(error.message);
    }
    if (!sample.screenshot) {
      if (policy.requireScreenshots) failures.push(`${id}: screenshot is missing`);
      continue;
    }
    try {
      const screenshot = assetPath(corpus.corpusDir, sample.screenshot, `${id} screenshot`);
      const digest = sha256(readFileSync(screenshot));
      const pathDigest = basename(screenshot, extname(screenshot)).toLowerCase();
      if (!SHA256_PATTERN.test(pathDigest) || digest !== pathDigest) {
        failures.push(`${id}: screenshot is not content-addressed`);
      }
      if (sample.screenshotSha256 && String(sample.screenshotSha256).toLowerCase() !== digest) {
        failures.push(`${id}: screenshotSha256 does not match screenshot bytes`);
      }
      screenshots += 1;
    } catch (error) {
      failures.push(error.message);
    }
  }
  return { snapshots, screenshots };
}

function validateSourceProvenance(corpus, base, sources, policy, failures) {
  const provenance = corpus.manifest.provenance;
  if (provenance?.kind !== "composed-corpus") failures.push("provenance.kind is not composed-corpus");
  if (provenance?.identity !== "canonical-final-url") failures.push("provenance.identity is not canonical-final-url");
  const declared = Array.isArray(provenance?.sources) ? provenance.sources : [];
  if (!declared.length) failures.push("provenance.sources is missing");

  const supplied = [...new Map([base, ...sources].map(source => [source.manifestSha256, source])).values()];
  const suppliedByDigest = new Map(supplied.map(source => [source.manifestSha256, source]));
  const declaredDigests = new Set();
  for (const source of declared) {
    const digest = String(source.manifestSha256 || "").toLowerCase();
    if (!SHA256_PATTERN.test(digest)) {
      failures.push(`provenance source ${source.role || "(unknown)"} has an invalid manifestSha256`);
      continue;
    }
    if (declaredDigests.has(digest)) failures.push(`provenance repeats source manifest ${digest}`);
    declaredDigests.add(digest);
    const suppliedSource = suppliedByDigest.get(digest);
    if (!suppliedSource) {
      if (policy.requireAllSourceManifests) failures.push(`provenance source manifest was not supplied: ${digest}`);
      continue;
    }
    for (const [field, actual] of [
      ["schema", suppliedSource.manifest.schema],
      ["suite", suppliedSource.manifest.suite],
      ["target", suppliedSource.manifest.target],
      ["captured", suppliedSource.manifest.samples?.length],
    ]) {
      if (source[field] !== actual) failures.push(`provenance source ${source.role || digest} has mismatched ${field}`);
    }
  }
  if (policy.requireAllSourceManifests) {
    for (const digest of suppliedByDigest.keys()) {
      if (!declaredDigests.has(digest)) failures.push(`supplied source is absent from provenance: ${digest}`);
    }
  }

  const baseSources = declared.filter(source => source.role === "base");
  if (baseSources.length !== 1) failures.push(`provenance must declare exactly one base source, found ${baseSources.length}`);
  else {
    const source = baseSources[0];
    if (source.manifestSha256 !== base.manifestSha256) failures.push("base provenance digest does not match the supplied base manifest");
    if (source.target !== policy.exactBaseSamples) failures.push(`base provenance target: ${source.target} != ${policy.exactBaseSamples}`);
  }
  const incrementSources = declared.filter(source => source.role === "increment");
  if (incrementSources.length !== 1) failures.push(`provenance must declare exactly one increment source, found ${incrementSources.length}`);
  return { declared, baseSource: baseSources[0], incrementSource: incrementSources[0] };
}

function validateBasePreservation(corpus, base, count, failures) {
  const finalSamples = corpus.manifest.samples || [];
  const baseSamples = base.manifest.samples || [];
  if (baseSamples.length < count) {
    failures.push(`base manifest contains ${baseSamples.length} samples, expected at least ${count}`);
    return;
  }
  for (let index = 0; index < count && index < finalSamples.length; index += 1) {
    const expected = baseSamples[index];
    const actual = finalSamples[index];
    const expectedIdentity = sampleIdentity(expected);
    const actualIdentity = sampleIdentity(actual);
    for (const field of Object.keys(expectedIdentity)) {
      if (actualIdentity[field] !== expectedIdentity[field]) {
        failures.push(`base sample ${index + 1} changed ${field}`);
      }
    }
    try {
      const expectedSnapshot = assetPath(base.corpusDir, expected.snapshot, `base sample ${index + 1} snapshot`);
      if (sha256(readFileSync(expectedSnapshot)) !== expectedIdentity.inputSha256) {
        failures.push(`base sample ${index + 1} snapshot digest does not match its manifest`);
      }
    } catch (error) {
      failures.push(error.message);
    }
    try {
      const expectedScreenshot = assetPath(base.corpusDir, expected.screenshot, `base sample ${index + 1} screenshot`);
      const actualScreenshot = assetPath(corpus.corpusDir, actual.screenshot, `final base sample ${index + 1} screenshot`);
      if (sha256(readFileSync(actualScreenshot)) !== sha256(readFileSync(expectedScreenshot))) {
        failures.push(`base sample ${index + 1} changed screenshot bytes`);
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
}

function effectiveSplitAudit(samples, baseSamples, nearDuplicatePairs) {
  const splitById = new Map();
  const familySplits = new Map();
  for (const [index, sample] of samples.entries()) {
    const split = index < baseSamples ? "train" : String(sample.evaluationSplit || "(unassigned)");
    const family = String(sample.siteFamily || registrableDomain(sample.finalUrl || sample.requestedUrl || sample.url) || sample.siteId || "(unknown)");
    splitById.set(sample.id, split);
    const splits = familySplits.get(family) || new Set();
    splits.add(split);
    familySplits.set(family, splits);
  }
  return {
    siteFamily: [...familySplits]
      .filter(([, splits]) => splits.size > 1)
      .map(([siteFamily, splits]) => ({ siteFamily, splits: [...splits].sort() })),
    nearDuplicate: nearDuplicatePairs
      .map(pair => ({
        ...pair,
        effectiveLeftSplit: splitById.get(pair.left.id) || "(unassigned)",
        effectiveRightSplit: splitById.get(pair.right.id) || "(unassigned)",
      }))
      .filter(pair => pair.effectiveLeftSplit !== pair.effectiveRightSplit),
  };
}

function validateIncrement(corpus, provenance, policy, failures) {
  const samples = (corpus.manifest.samples || []).slice(policy.exactBaseSamples);
  const splitCounts = {};
  for (const sample of samples) incrementCount(splitCounts, String(sample.evaluationSplit || "(unassigned)"));
  const expectedSplits = policy.exactIncrementSplitCounts || {};
  const splitNames = new Set([...Object.keys(splitCounts), ...Object.keys(expectedSplits)]);
  for (const split of [...splitNames].sort()) {
    if ((splitCounts[split] || 0) !== (expectedSplits[split] || 0)) {
      failures.push(`increment split ${split}: ${splitCounts[split] || 0} != ${expectedSplits[split] || 0}`);
    }
  }

  const replacementPlan = provenance.incrementSource?.replacementPlan;
  if (!replacementPlan || !Array.isArray(replacementPlan.cells)) {
    failures.push("increment provenance has no replacementPlan");
  } else {
    if (JSON.stringify(replacementPlan.dimensions) !== JSON.stringify(["evaluationSplit", "vertical", "discoveredType"])) {
      failures.push("increment replacementPlan dimensions are invalid");
    }
    const expectedCells = new Map();
    let expectedTotal = 0;
    for (const cell of replacementPlan.cells) {
      const key = cellKey(cell);
      const quota = Number(cell.quota);
      const hasIdentity = [cell.evaluationSplit, cell.vertical, cell.discoveredType]
        .every(value => String(value || "").trim());
      if (!hasIdentity || !Number.isInteger(quota) || quota <= 0 || expectedCells.has(key)) {
        failures.push(`increment replacementPlan has an invalid or duplicate cell: ${key}`);
        continue;
      }
      expectedCells.set(key, quota);
      expectedTotal += quota;
    }
    if (expectedTotal !== samples.length) {
      failures.push(`increment replacementPlan total: ${expectedTotal} != ${samples.length}`);
    }
    const actualCells = new Map();
    for (const sample of samples) actualCells.set(cellKey(sample), (actualCells.get(cellKey(sample)) || 0) + 1);
    for (const key of new Set([...expectedCells.keys(), ...actualCells.keys()])) {
      if ((actualCells.get(key) || 0) !== (expectedCells.get(key) || 0)) {
        failures.push(`increment replacement cell ${key}: ${actualCells.get(key) || 0} != ${expectedCells.get(key) || 0}`);
      }
    }
  }

  const selection = corpus.manifest.provenance?.selection;
  if (selection?.mode !== "replacement-cell") failures.push("provenance.selection.mode is not replacement-cell");
  if (JSON.stringify(selection?.dimensions) !== JSON.stringify(["evaluationSplit", "vertical", "discoveredType"])) {
    failures.push("provenance.selection.dimensions is invalid");
  }
  const selectedTotal = Object.values(selection?.selectedBySource || {}).reduce((total, value) => total + Number(value || 0), 0);
  if (selectedTotal !== samples.length) failures.push(`provenance selectedBySource total: ${selectedTotal} != ${samples.length}`);
  return { samples: samples.length, splitCounts };
}

export function auditFinalCorpus({ corpusDir, baseDir, sourceDirs = [], policy }) {
  const corpus = readCorpus(corpusDir, "final corpus");
  const base = readCorpus(baseDir, "base corpus");
  const sources = sourceDirs.map((value, index) => readCorpus(value, `source #${index + 1}`));
  const failures = [];
  const samples = Array.isArray(corpus.manifest.samples) ? corpus.manifest.samples : [];
  const expectedIncrementSamples = Object.values(policy.exactIncrementSplitCounts || {})
    .reduce((total, value) => total + Number(value || 0), 0);
  if (policy.exactBaseSamples + expectedIncrementSamples !== policy.exactSamples) {
    failures.push("audit policy base and increment counts do not sum to exactSamples");
  }
  if (!Array.isArray(corpus.manifest.samples)) failures.push("final manifest has no samples array");
  if (corpus.manifest.target !== policy.exactSamples) failures.push(`target: ${corpus.manifest.target} != ${policy.exactSamples}`);
  if (corpus.manifest.captured !== policy.exactSamples) failures.push(`captured: ${corpus.manifest.captured} != ${policy.exactSamples}`);
  if (samples.length !== policy.exactSamples) failures.push(`samples: ${samples.length} != ${policy.exactSamples}`);
  if (corpus.manifest.schema !== base.manifest.schema) failures.push("final schema does not match base schema");
  if (corpus.manifest.suite !== base.manifest.suite) failures.push("final suite does not match base suite");
  const ids = new Set(samples.map(sample => sample.id));
  if (ids.size !== samples.length || ids.has(undefined) || ids.has("")) failures.push("sample ids are missing or duplicated");

  const provenance = validateSourceProvenance(corpus, base, sources, policy, failures);
  validateBasePreservation(corpus, base, policy.exactBaseSamples, failures);
  const increment = validateIncrement(corpus, provenance, policy, failures);
  const assets = validateAssets(corpus, samples, policy, failures);

  const diversity = auditDiversity({ manifestPaths: [corpus.manifestPath] });
  const corpusDiversity = diversity.corpus;
  const exactDuplicateExcess = {
    canonicalUrl: duplicateExcess(corpusDiversity.duplicates.canonicalUrl),
    inputDom: duplicateExcess(corpusDiversity.duplicates.inputDom),
    frozenDom: duplicateExcess(corpusDiversity.duplicates.frozenDom),
    normalizedText: duplicateExcess(corpusDiversity.duplicates.normalizedText),
  };
  if (corpusDiversity.snapshotCoverage.available !== samples.length) {
    failures.push(`normalized snapshot text coverage: ${corpusDiversity.snapshotCoverage.available}/${samples.length}`);
  }
  for (const [name, actual] of Object.entries(exactDuplicateExcess)) {
    if (actual !== 0) failures.push(`${name} duplicate excess: ${actual} != 0`);
  }
  if (corpusDiversity.registrableDomains < policy.minRegistrableDomains) {
    failures.push(`registrable domains: ${corpusDiversity.registrableDomains} < ${policy.minRegistrableDomains}`);
  }
  if (Object.keys(corpusDiversity.counts.vertical).length < policy.minVerticals) {
    failures.push(`verticals: ${Object.keys(corpusDiversity.counts.vertical).length} < ${policy.minVerticals}`);
  }
  if (Object.keys(corpusDiversity.counts.pageType).length < policy.minPageTypes) {
    failures.push(`page types: ${Object.keys(corpusDiversity.counts.pageType).length} < ${policy.minPageTypes}`);
  }
  const splitLeakage = effectiveSplitAudit(samples, policy.exactBaseSamples, corpusDiversity.duplicates.nearNormalizedText);
  if (splitLeakage.siteFamily.length) failures.push(`site-family split leakage: ${splitLeakage.siteFamily.length}`);
  if (splitLeakage.nearDuplicate.length) {
    failures.push(`near-duplicate split leakage: ${splitLeakage.nearDuplicate.length}`);
  }

  return {
    schema: "qingzhou.article-extraction-final-corpus-audit.v1",
    generatedAt: new Date().toISOString(),
    corpus: {
      directory: corpus.corpusDir,
      manifestSha256: corpus.manifestSha256,
      samples: samples.length,
      baseSamples: policy.exactBaseSamples,
      increment,
      assets,
    },
    provenance: {
      declaredSources: provenance.declared.length,
      suppliedSources: new Set([base.manifestSha256, ...sources.map(source => source.manifestSha256)]).size,
    },
    diversity: {
      registrableDomains: corpusDiversity.registrableDomains,
      verticals: Object.keys(corpusDiversity.counts.vertical).length,
      pageTypes: Object.keys(corpusDiversity.counts.pageType).length,
      exactDuplicateExcess,
      siteFamilySplitLeakage: splitLeakage.siteFamily,
      nearDuplicateSplitLeakage: splitLeakage.nearDuplicate,
    },
    gate: { ok: failures.length === 0, failures },
  };
}

function parseCli(argv) {
  const options = { corpusDir: "", baseDir: "", sourceDirs: [], policyPath: "", output: "", failOnGate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--corpus") options.corpusDir = argv[++index];
    else if (value === "--base") options.baseDir = argv[++index];
    else if (value === "--source") options.sourceDirs.push(argv[++index]);
    else if (value === "--policy") options.policyPath = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--fail-on-gate") options.failOnGate = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.corpusDir || !options.baseDir || !options.policyPath) {
    throw new Error("provide --corpus, --base, and --policy");
  }
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const policy = JSON.parse(readFileSync(resolve(options.policyPath), "utf8"));
  const report = auditFinalCorpus({
    corpusDir: options.corpusDir,
    baseDir: options.baseDir,
    sourceDirs: options.sourceDirs,
    policy,
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(resolve(options.output), body);
  else process.stdout.write(body);
  if (options.failOnGate && !report.gate.ok) {
    console.error(`Final corpus audit failed (${report.gate.failures.length}):\n${report.gate.failures.map(value => `- ${value}`).join("\n")}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
