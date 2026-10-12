#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMON_COMPOUND_SUFFIXES = new Set([
  "ac.cn", "com.cn", "edu.cn", "gov.cn", "mil.cn", "net.cn", "org.cn",
  "ah.cn", "bj.cn", "cq.cn", "fj.cn", "gd.cn", "gs.cn", "gx.cn", "gz.cn",
  "ha.cn", "hb.cn", "he.cn", "hi.cn", "hk.cn", "hl.cn", "hn.cn", "jl.cn",
  "js.cn", "jx.cn", "ln.cn", "mo.cn", "nm.cn", "nx.cn", "qh.cn", "sc.cn",
  "sd.cn", "sh.cn", "sn.cn", "sx.cn", "tj.cn", "tw.cn", "xj.cn", "xz.cn",
  "yn.cn", "zj.cn", "com.hk", "edu.hk", "gov.hk", "net.hk", "org.hk",
  "com.mo", "edu.mo", "gov.mo", "net.mo", "org.mo", "com.tw", "edu.tw",
  "gov.tw", "idv.tw", "net.tw", "org.tw", "co.jp", "co.kr", "com.sg",
  "com.au", "co.uk", "org.uk",
]);

const TRACKING_PARAM = /^(?:utm_|spm$|from$|source$|src$|track|share_|timestamp$)/i;
const SHA256 = value => createHash("sha256").update(value).digest("hex");

function orderedCounts(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const key = String(value || "(unassigned)");
      counts.set(key, (counts.get(key) || 0) + 1);
      return counts;
    }, new Map())].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN")),
  );
}

function duplicateGroups(items, keyOf, fields = []) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(Object.fromEntries(["id", ...fields].map(field => [field, item[field] ?? ""])));
    groups.set(key, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, samples]) => ({ key, count: samples.length, samples }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch (_error) {
    return "";
  }
}

export function registrableDomain(value) {
  let hostname = String(value || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  } catch (_error) {
    // Accept a hostname directly.
  }
  if (!hostname || hostname === "localhost" || /^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(":")) return hostname;
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;
  const suffix = labels.slice(-2).join(".");
  return labels.slice(COMMON_COMPOUND_SUFFIXES.has(suffix) ? -3 : -2).join(".");
}

function decodeEntities(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));/gi, (match, numeric, name) => {
    if (numeric) {
      const codePoint = Number.parseInt(numeric[0].toLowerCase() === "x" ? numeric.slice(1) : numeric, numeric[0].toLowerCase() === "x" ? 16 : 10);
      try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match; } catch (_error) { return match; }
    }
    return named[String(name || "").toLowerCase()] ?? " ";
  });
}

export function normalizeSnapshotText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:head|script|style|template|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/(?:head|script|style|template|noscript|svg|canvas)>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedTagSequence(html) {
  const body = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:head|script|style|template|noscript|svg)\b[^>]*>[\s\S]*?<\/(?:head|script|style|template|noscript|svg)>/gi, "");
  return [...body.matchAll(/<\/?\s*([a-z][a-z0-9-]*)\b[^>]*>/gi)]
    .map(match => `${match[0].startsWith("</") ? "/" : ""}${match[1].toLowerCase()}`)
    .join(" ");
}

function sampledShingles(value, width = 5, limit = 768) {
  const compact = String(value || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  const count = Math.max(0, compact.length - width + 1);
  if (!count) return compact ? [compact] : [];
  const step = Math.max(1, Math.floor(count / limit));
  const result = [];
  for (let index = 0; index < count && result.length < limit; index += step) result.push(compact.slice(index, index + width));
  return result;
}

function bottomShingleHashes(value, width = 5, limit = 1024) {
  const compact = String(value || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  const selected = new Set();
  let ceiling = 0xffffffff;
  for (let index = 0; index <= compact.length - width; index += 1) {
    const hash = hash32(compact.slice(index, index + width), 0x85ebca6b);
    if (hash > ceiling || selected.has(hash)) continue;
    selected.add(hash);
    if (selected.size <= limit * 2) continue;
    const retained = [...selected].sort((left, right) => left - right).slice(0, limit);
    selected.clear();
    retained.forEach(value => selected.add(value));
    ceiling = retained.at(-1) ?? ceiling;
  }
  if (selected.size <= limit) return selected;
  return new Set([...selected].sort((left, right) => left - right).slice(0, limit));
}

function hash32(value, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function simhash64(value) {
  const weights = new Int32Array(64);
  for (const shingle of sampledShingles(value)) {
    const low = hash32(shingle, 0x811c9dc5);
    const high = hash32(shingle, 0x9e3779b9);
    for (let bit = 0; bit < 32; bit += 1) {
      weights[bit] += (low >>> bit) & 1 ? 1 : -1;
      weights[bit + 32] += (high >>> bit) & 1 ? 1 : -1;
    }
  }
  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (weights[bit] >= 0) low = (low | (1 << bit)) >>> 0;
    if (weights[bit + 32] >= 0) high = (high | (1 << bit)) >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
}

function hammingHex(left, right) {
  let distance = 0;
  for (let index = 0; index < 16; index += 2) {
    let value = Number.parseInt(left.slice(index, index + 2), 16) ^ Number.parseInt(right.slice(index, index + 2), 16);
    while (value) {
      distance += 1;
      value &= value - 1;
    }
  }
  return distance;
}

function findNearDuplicatePairs(records, maximumDistance = 3) {
  const buckets = new Map();
  const candidatePairs = new Set();
  records.forEach((record, index) => {
    for (let segment = 0; segment < 4; segment += 1) {
      const key = `${segment}:${record.simhash.slice(segment * 4, segment * 4 + 4)}`;
      const bucket = buckets.get(key) || [];
      for (const prior of bucket) candidatePairs.add(`${prior}:${index}`);
      bucket.push(index);
      buckets.set(key, bucket);
    }
  });
  const pairs = [];
  for (const key of candidatePairs) {
    const [leftIndex, rightIndex] = key.split(":").map(Number);
    const left = records[leftIndex];
    const right = records[rightIndex];
    if (left.textDigest === right.textDigest) continue;
    const lengthRatio = Math.min(left.textLength, right.textLength) / Math.max(left.textLength, right.textLength);
    if (lengthRatio < 0.78) continue;
    const distance = hammingHex(left.simhash, right.simhash);
    if (distance > maximumDistance) continue;
    let overlap = 0;
    for (const shingle of left.shingleHashes) if (right.shingleHashes.has(shingle)) overlap += 1;
    const textSimilarity = overlap / Math.max(1, left.shingleHashes.size + right.shingleHashes.size - overlap);
    if (textSimilarity < 0.9) continue;
    const describe = record => ({
      id: record.id,
      siteId: record.siteId,
      siteFamily: record.siteFamily,
      evaluationSplit: record.split,
      type: record.type || record.pageType || "",
      finalUrl: record.finalUrl || record.requestedUrl || record.url || "",
    });
    pairs.push({
      left: describe(left),
      right: describe(right),
      distance,
      lengthRatio: Number(lengthRatio.toFixed(4)),
      textSimilarity: Number(textSimilarity.toFixed(4)),
      crossSiteFamily: left.siteFamily !== right.siteFamily,
      crossSplit: left.split !== "(unassigned)" && right.split !== "(unassigned)" && left.split !== right.split,
    });
  }
  return pairs.sort((left, right) => left.distance - right.distance || right.lengthRatio - left.lengthRatio);
}

function resolveSnapshot(manifestPath, snapshot) {
  if (!snapshot) return "";
  return isAbsolute(snapshot) ? snapshot : join(dirname(manifestPath), snapshot);
}

function siteMetadata(configs) {
  const byId = new Map();
  for (const { value } of configs) {
    for (const site of value.sites || []) byId.set(site.id, site);
  }
  return byId;
}

function sampleFamily(sample, site) {
  return sample.siteFamily || site?.siteFamily || registrableDomain(sample.finalUrl || sample.requestedUrl || sample.url) || sample.siteId || "(unknown)";
}

function sampleSplit(sample, site) {
  return sample.evaluationSplit
    || site?.evaluationSplit
    || sample.split
    || sample.datasetSplit
    || sample.goldSplit
    || site?.split
    || "(unassigned)";
}

function auditPlan(configs) {
  const sites = configs.flatMap(({ value }) => (value.sites || []).map(site => ({
    ...site,
    __quota: Number(site.quota ?? value.samplesPerSite ?? 0),
  })));
  const seeds = sites.flatMap(site => (site.seeds || []).map(seed => ({ ...seed, siteId: site.id })));
  const families = sites.map(site => site.siteFamily || registrableDomain(site.hosts?.[0] || site.seeds?.[0]?.url) || site.id);
  const splitFamilies = new Map();
  const familyQuota = new Map();
  sites.forEach((site, index) => {
    const split = site.evaluationSplit || site.split || "(unassigned)";
    const family = families[index];
    const splits = splitFamilies.get(family) || new Set();
    splits.add(split);
    splitFamilies.set(family, splits);
    familyQuota.set(family, (familyQuota.get(family) || 0) + site.__quota);
  });
  return {
    declaredTarget: configs.reduce((total, { value }) => total + Number(value.sampleTarget || value.target || 0), 0),
    quotaTotal: sites.reduce((total, site) => total + site.__quota, 0),
    sites: sites.length,
    registrableDomains: new Set(sites.map(site => (
      site.registrableDomain
      || registrableDomain(site.hosts?.[0] || site.seeds?.[0]?.url)
    )).filter(Boolean)).size,
    counts: {
      vertical: orderedCounts(sites.map(site => site.vertical)),
      pageTypeSeeds: orderedCounts(seeds.map(seed => seed.type)),
      splitSites: orderedCounts(sites.map(site => site.evaluationSplit || site.split)),
      splitQuota: orderedCounts(sites.flatMap(site => Array.from({ length: site.__quota }, () => site.evaluationSplit || site.split))),
      siteFamily: orderedCounts(families),
      siteQuota: Object.fromEntries(sites.map(site => [site.id, site.__quota]).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
      siteFamilyQuota: Object.fromEntries([...familyQuota].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))),
    },
    duplicateSeedUrls: duplicateGroups(seeds, seed => canonicalizeUrl(seed.url), ["siteId", "url"]),
    splitLeakage: [...splitFamilies.entries()]
      .filter(([, splits]) => [...splits].filter(split => split !== "(unassigned)").length > 1)
      .map(([siteFamily, splits]) => ({ siteFamily, splits: [...splits].sort() })),
  };
}

function auditSamples(manifests, configs) {
  const metadata = siteMetadata(configs);
  const samples = manifests.flatMap(({ path, value }, sourceIndex) => (value.samples || []).map((sample, sampleIndex) => ({
    ...sample,
    __manifestPath: path,
    __recordKey: `${sourceIndex}:${sample.id || sampleIndex}`,
    canonicalUrl: canonicalizeUrl(sample.finalUrl || sample.requestedUrl || sample.url),
  })));
  const records = [];
  for (const sample of samples) {
    const snapshotPath = resolveSnapshot(sample.__manifestPath, sample.snapshot);
    let html = "";
    if (snapshotPath && existsSync(snapshotPath)) html = readFileSync(snapshotPath, "utf8");
    const text = html ? normalizeSnapshotText(html) : "";
    records.push({
      recordKey: sample.__recordKey,
      id: sample.id,
      textDigest: text ? SHA256(text) : "",
      textLength: text.length,
      simhash: text.length >= 200 ? simhash64(text) : "",
      shingleHashes: text.length >= 200 ? bottomShingleHashes(text) : new Set(),
      templateDigest: html ? SHA256(normalizedTagSequence(html)) : "",
    });
  }
  const recordById = new Map(records.map(record => [record.recordKey, record]));
  const enriched = samples.map(sample => {
    const site = metadata.get(sample.siteId);
    const record = recordById.get(sample.__recordKey) || {};
    return {
      ...sample,
      registrableDomain: registrableDomain(sample.canonicalUrl),
      siteFamily: sampleFamily(sample, site),
      split: sampleSplit(sample, site),
      ...record,
    };
  });
  const splitFamilies = new Map();
  for (const sample of enriched) {
    const splits = splitFamilies.get(sample.siteFamily) || new Set();
    splits.add(sample.split);
    splitFamilies.set(sample.siteFamily, splits);
  }
  const nearRecords = enriched.filter(sample => sample.simhash);
  const templateGroups = duplicateGroups(enriched, sample => sample.templateDigest, ["siteId", "type", "finalUrl"]);
  const nearDuplicatePairs = findNearDuplicatePairs(nearRecords);
  return {
    samples: enriched.length,
    sites: new Set(enriched.map(sample => sample.siteId).filter(Boolean)).size,
    registrableDomains: new Set(enriched.map(sample => sample.registrableDomain).filter(Boolean)).size,
    siteFamilies: new Set(enriched.map(sample => sample.siteFamily).filter(Boolean)).size,
    counts: {
      site: orderedCounts(enriched.map(sample => sample.siteId)),
      registrableDomain: orderedCounts(enriched.map(sample => sample.registrableDomain)),
      siteFamily: orderedCounts(enriched.map(sample => sample.siteFamily)),
      vertical: orderedCounts(enriched.map(sample => sample.vertical)),
      pageType: orderedCounts(enriched.map(sample => sample.type || sample.pageType)),
      split: orderedCounts(enriched.map(sample => sample.split)),
    },
    duplicates: {
      canonicalUrl: duplicateGroups(enriched, sample => sample.canonicalUrl, ["siteId", "type", "finalUrl"]),
      inputDom: duplicateGroups(enriched, sample => sample.inputSha256, ["siteId", "type", "finalUrl"]),
      frozenDom: duplicateGroups(enriched, sample => sample.captureEvidence?.frozenDomSha256, ["siteId", "type", "finalUrl"]),
      normalizedText: duplicateGroups(enriched, sample => sample.textDigest, ["siteId", "type", "finalUrl"]),
      nearNormalizedText: nearDuplicatePairs,
      templateFingerprint: templateGroups,
    },
    snapshotCoverage: {
      available: records.filter(record => record.textDigest).length,
      missing: records.filter(record => !record.textDigest).map(record => record.id),
    },
    splitLeakage: [...splitFamilies.entries()]
      .filter(([, splits]) => [...splits].filter(split => split !== "(unassigned)").length > 1)
      .map(([siteFamily, splits]) => ({ siteFamily, splits: [...splits].sort() })),
    nearDuplicateSplitLeakage: nearDuplicatePairs.filter(pair => pair.crossSplit),
  };
}

const duplicateExcess = groups => groups.reduce((total, group) => total + group.count - 1, 0);
const maximumCount = counts => Math.max(0, ...Object.values(counts || {}));

export function evaluateDiversityPolicy(report, policy = {}) {
  const failures = [];
  const assertAtLeast = (label, actual, expected) => {
    if (expected != null && actual < expected) failures.push(`${label}: ${actual} < ${expected}`);
  };
  const assertAtMost = (label, actual, expected) => {
    if (expected != null && actual > expected) failures.push(`${label}: ${actual} > ${expected}`);
  };
  const corpus = report.corpus;
  const plan = report.plan;
  if (corpus) {
    assertAtLeast("samples", corpus.samples, policy.minSamples);
    assertAtLeast("sites", corpus.sites, policy.minSites);
    assertAtLeast("registrable domains", corpus.registrableDomains, policy.minRegistrableDomains);
    assertAtLeast("verticals", Object.keys(corpus.counts.vertical).length, policy.minVerticals);
    assertAtLeast("page types", Object.keys(corpus.counts.pageType).length, policy.minPageTypes);
    assertAtMost("pages per site", maximumCount(corpus.counts.site), policy.maxPagesPerSite);
    assertAtMost("pages per site family", maximumCount(corpus.counts.siteFamily), policy.maxPagesPerSiteFamily);
    assertAtMost("canonical URL duplicate excess", duplicateExcess(corpus.duplicates.canonicalUrl), policy.maxCanonicalUrlDuplicateExcess);
    assertAtMost("DOM duplicate excess", duplicateExcess(corpus.duplicates.inputDom), policy.maxDomDuplicateExcess);
    assertAtMost("normalized-text duplicate excess", duplicateExcess(corpus.duplicates.normalizedText), policy.maxTextDuplicateExcess);
    assertAtMost("near-duplicate pairs", corpus.duplicates.nearNormalizedText.length, policy.maxNearDuplicatePairs);
    assertAtMost("template cluster size", Math.max(1, ...corpus.duplicates.templateFingerprint.map(group => group.count)), policy.maxTemplateClusterSize);
    if (policy.requireSnapshots && corpus.snapshotCoverage.available !== corpus.samples) failures.push(`snapshot coverage: ${corpus.snapshotCoverage.available}/${corpus.samples}`);
    if (policy.requireAssignedSplits && corpus.counts.split["(unassigned)"]) failures.push(`unassigned splits: ${corpus.counts.split["(unassigned)"]}`);
    if (policy.requireSplitIsolation && corpus.splitLeakage.length) failures.push(`site-family split leakage: ${corpus.splitLeakage.length}`);
    if (policy.requireSplitIsolation && corpus.nearDuplicateSplitLeakage.length) failures.push(`near-duplicate split leakage: ${corpus.nearDuplicateSplitLeakage.length}`);
  }
  if (plan) {
    assertAtLeast("planned declared target", plan.declaredTarget, policy.minSamples);
    assertAtLeast("planned quota total", plan.quotaTotal, policy.minSamples);
    assertAtLeast("planned sites", plan.sites, policy.minSites);
    assertAtLeast("planned registrable domains", plan.registrableDomains, policy.minRegistrableDomains);
    assertAtLeast("planned verticals", Object.keys(plan.counts.vertical).length, policy.minVerticals);
    assertAtLeast("planned page types", Object.keys(plan.counts.pageTypeSeeds).length, policy.minPageTypes);
    assertAtMost("planned pages per site", maximumCount(plan.counts.siteQuota), policy.maxPagesPerSite);
    assertAtMost("planned pages per site family", maximumCount(plan.counts.siteFamilyQuota), policy.maxPagesPerSiteFamily);
    assertAtMost("planned seed URL duplicate excess", duplicateExcess(plan.duplicateSeedUrls), policy.maxCanonicalUrlDuplicateExcess);
    if (policy.requireAssignedSplits && plan.counts.splitSites["(unassigned)"]) failures.push(`planned sites without split: ${plan.counts.splitSites["(unassigned)"]}`);
    if (policy.requireSplitIsolation && plan.splitLeakage.length) failures.push(`planned site-family split leakage: ${plan.splitLeakage.length}`);
  }
  return { ok: failures.length === 0, failures };
}

export function formatGateFailure(gate, reportPath = "") {
  if (gate?.ok !== false) return "";
  const lines = [`Article-extraction diversity gate failed (${gate.failures.length}):`];
  gate.failures.forEach(failure => lines.push(`- ${failure}`));
  if (reportPath) lines.push(`Report: ${resolve(reportPath)}`);
  else lines.push("The JSON report above lists each duplicate URL and its site/sample identities.");
  return lines.join("\n");
}

function readJson(path) {
  return { path: resolve(path), value: JSON.parse(readFileSync(path, "utf8")) };
}

export function auditDiversity({ manifestPaths = [], configPaths = [], policy = {} }) {
  const manifests = manifestPaths.map(readJson);
  const configs = configPaths.map(readJson);
  const report = {
    schema: "qingzhou.article-extraction-diversity-audit.v1",
    generatedAt: new Date().toISOString(),
    sources: { manifests: manifests.map(item => item.path), configs: configs.map(item => item.path) },
    ...(configs.length ? { plan: auditPlan(configs) } : {}),
    ...(manifests.length ? { corpus: auditSamples(manifests, configs) } : {}),
  };
  report.gate = evaluateDiversityPolicy(report, policy);
  return report;
}

function parseCli(argv) {
  const options = { manifestPaths: [], configPaths: [], policyPath: "", output: "", failOnGate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--manifest") options.manifestPaths.push(argv[++index]);
    else if (value === "--config") options.configPaths.push(argv[++index]);
    else if (value === "--policy") options.policyPath = argv[++index];
    else if (value === "--output") options.output = argv[++index];
    else if (value === "--fail-on-gate") options.failOnGate = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.manifestPaths.length && !options.configPaths.length) throw new Error("provide --manifest and/or --config");
  return options;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const policy = options.policyPath ? JSON.parse(readFileSync(options.policyPath, "utf8")) : {};
  const report = auditDiversity({ manifestPaths: options.manifestPaths, configPaths: options.configPaths, policy });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) writeFileSync(options.output, json);
  else process.stdout.write(json);
  if (options.failOnGate && !report.gate.ok) {
    console.error(formatGateFailure(report.gate, options.output));
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
