import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  auditDiversity,
  canonicalizeUrl,
  evaluateDiversityPolicy,
  formatGateFailure,
  normalizeSnapshotText,
  registrableDomain,
  simhash64,
} from "../benchmarks/article-extraction/corpus-diversity-audit.mjs";

test("diversity audit uses stable URL, domain, text, and fingerprint normalization", () => {
  assert.equal(canonicalizeUrl("https://example.com/a?utm_source=x&k=1#part"), "https://example.com/a?k=1");
  assert.equal(registrableDomain("https://aiqicha.baidu.com/company"), "baidu.com");
  assert.equal(registrableDomain("news.example.com.cn"), "example.com.cn");
  assert.equal(registrableDomain("https://service.beijing.gov.cn/a"), "beijing.gov.cn");
  assert.equal(normalizeSnapshotText("<head><title>noise</title></head><p>正文&nbsp; A</p><script>x</script>"), "正文 A");
  assert.equal(simhash64("相同的中文正文".repeat(80)), simhash64("相同的中文正文".repeat(80)));
});

test("diversity audit detects duplicate evidence, site-family leakage, and weak concentration", () => {
  const root = mkdtempSync(join(tmpdir(), "qingzhou-diversity-"));
  const snapshots = join(root, "snapshots");
  mkdirSync(snapshots);
  const common = Array.from({ length: 120 }, (_, index) => `第${index}段包含不同编号和上下文，用于验证抽取语料的近重复检测能力。`).join("");
  const pages = [
    `<html><body><main><h1>标题甲</h1><p>${common}</p></main></body></html>`,
    `<html><body><main><h1>标题乙</h1><p>${common}</p></main></body></html>`,
    `<html><body><article><h1>独立标题</h1><p>${"完全不同的页面正文和页面结构。".repeat(30)}</p></article></body></html>`,
  ];
  pages.forEach((html, index) => writeFileSync(join(snapshots, `${index}.html`), html));
  const manifestPath = join(root, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    samples: [
      {
        id: "a", siteId: "alpha-main", siteFamily: "alpha", evaluationSplit: "train", vertical: "本地生活", type: "home",
        finalUrl: "https://alpha.example.com/page?utm_source=x", inputSha256: "a".repeat(64),
        captureEvidence: { frozenDomSha256: "f".repeat(64) }, snapshot: "snapshots/0.html",
      },
      {
        id: "b", siteId: "alpha-mobile", siteFamily: "alpha", evaluationSplit: "test", vertical: "本地生活", type: "detail",
        finalUrl: "https://alpha.example.com/page", inputSha256: "a".repeat(64),
        captureEvidence: { frozenDomSha256: "f".repeat(64) }, snapshot: "snapshots/1.html",
      },
      {
        id: "c", siteId: "beta", siteFamily: "beta", evaluationSplit: "test", vertical: "企业工商", type: "search",
        finalUrl: "https://beta.com.cn/record", inputSha256: "c".repeat(64),
        captureEvidence: { frozenDomSha256: "c".repeat(64) }, snapshot: "snapshots/2.html",
      },
    ],
  }));

  const policy = {
    minSamples: 4,
    minSites: 4,
    minRegistrableDomains: 3,
    minVerticals: 3,
    minPageTypes: 4,
    maxPagesPerSiteFamily: 1,
    maxCanonicalUrlDuplicateExcess: 0,
    maxDomDuplicateExcess: 0,
    maxNearDuplicatePairs: 0,
    requireSnapshots: true,
    requireAssignedSplits: true,
    requireSplitIsolation: true,
  };
  const report = auditDiversity({ manifestPaths: [manifestPath], policy });
  assert.equal(report.corpus.samples, 3);
  assert.equal(report.corpus.sites, 3);
  assert.equal(report.corpus.registrableDomains, 2);
  assert.equal(report.corpus.duplicates.canonicalUrl.length, 1);
  assert.equal(report.corpus.duplicates.inputDom.length, 1);
  assert.equal(report.corpus.duplicates.frozenDom.length, 1);
  assert.ok(report.corpus.duplicates.nearNormalizedText.some(pair => pair.left.id === "a" && pair.right.id === "b"));
  assert.equal(report.corpus.nearDuplicateSplitLeakage.length, 1);
  assert.equal(report.corpus.nearDuplicateSplitLeakage[0].crossSplit, true);
  assert.deepEqual(report.corpus.splitLeakage, [{ siteFamily: "alpha", splits: ["test", "train"] }]);
  assert.equal(report.gate.ok, false);
  assert.ok(report.gate.failures.some(value => value.startsWith("site-family split leakage")));
  assert.ok(report.gate.failures.some(value => value.startsWith("near-duplicate split leakage")));
  assert.match(formatGateFailure(report.gate), /^Article-extraction diversity gate failed \(\d+\):/);
  assert.match(formatGateFailure(report.gate), /JSON report above lists each duplicate URL/);

  const relaxed = evaluateDiversityPolicy(report, { minSamples: 3, maxCanonicalUrlDuplicateExcess: 1, maxDomDuplicateExcess: 1 });
  assert.equal(relaxed.ok, true);
});

test("diversity audit validates the declared plan independently of captured pages", () => {
  const root = mkdtempSync(join(tmpdir(), "qingzhou-diversity-plan-"));
  const configPath = join(root, "plan.json");
  writeFileSync(configPath, JSON.stringify({
    sampleTarget: 4,
    sites: [
      {
        id: "one", siteFamily: "family-one", evaluationSplit: "train", vertical: "企业工商", quota: 2,
        hosts: ["one.com.cn"], seeds: [{ type: "search", url: "https://one.com.cn/search" }],
      },
      {
        id: "two", siteFamily: "family-two", evaluationSplit: "test", vertical: "本地生活", quota: 2,
        hosts: ["two.cn"], seeds: [{ type: "detail", url: "https://two.cn/detail/1" }],
      },
    ],
  }));
  const report = auditDiversity({
    configPaths: [configPath],
    policy: {
      minSamples: 4,
      minSites: 2,
      minRegistrableDomains: 2,
      minVerticals: 2,
      minPageTypes: 2,
      maxPagesPerSite: 2,
      maxPagesPerSiteFamily: 2,
      maxCanonicalUrlDuplicateExcess: 0,
      requireAssignedSplits: true,
      requireSplitIsolation: true,
    },
  });
  assert.equal(report.plan.quotaTotal, 4);
  assert.equal(report.plan.registrableDomains, 2);
  assert.deepEqual(report.plan.counts.siteQuota, { one: 2, two: 2 });
  assert.equal(report.plan.duplicateSeedUrls.length, 0);
  assert.equal(report.gate.ok, true);

  const insufficientQuota = structuredClone(report);
  insufficientQuota.plan.quotaTotal = 3;
  const quotaGate = evaluateDiversityPolicy(insufficientQuota, { minSamples: 4 });
  assert.equal(quotaGate.ok, false);
  assert.ok(quotaGate.failures.includes("planned quota total: 3 < 4"));
});
