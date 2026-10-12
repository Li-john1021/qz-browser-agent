import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditFinalCorpus } from "../benchmarks/article-extraction/final-corpus-audit.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function materializeSample(corpusDir, value) {
  const html = Buffer.from(`<html><body><main><h1>${value.title}</h1><p>${value.body.repeat(30)}</p></main></body></html>`);
  const screenshot = Buffer.from(`jpeg:${value.title}`);
  const inputSha256 = sha256(html);
  const screenshotSha256 = sha256(screenshot);
  mkdirSync(join(corpusDir, "snapshots"), { recursive: true });
  mkdirSync(join(corpusDir, "screenshots"), { recursive: true });
  writeFileSync(join(corpusDir, "snapshots", `${inputSha256}.html`), html);
  writeFileSync(join(corpusDir, "screenshots", `${screenshotSha256}.jpg`), screenshot);
  return {
    id: value.id,
    siteId: value.siteId,
    siteFamily: value.siteFamily,
    evaluationSplit: value.evaluationSplit,
    vertical: value.vertical,
    type: value.type,
    discoveredType: value.discoveredType,
    finalUrl: value.finalUrl,
    inputSha256,
    captureEvidence: { frozenDomSha256: sha256(`frozen:${value.title}`) },
    snapshot: `snapshots/${inputSha256}.html`,
    screenshot: `screenshots/${screenshotSha256}.jpg`,
    screenshotSha256,
  };
}

test("final corpus audit proves preservation, split, provenance, assets, and diversity contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "qingzhou-final-corpus-audit-"));
  const baseDir = join(root, "base");
  const incrementDir = join(root, "increment");
  const finalDir = join(root, "final");
  [baseDir, incrementDir, finalDir].forEach(path => mkdirSync(path, { recursive: true }));

  const baseSample = materializeSample(baseDir, {
    id: "core-0001", siteId: "base", siteFamily: "base.example.com", vertical: "综合资讯", type: "home",
    finalUrl: "https://base.example.com/", title: "基础页面", body: "这是基础语料的独立正文。",
  });
  const baseManifest = { schema: "corpus.v1", suite: "core", target: 1, captured: 1, samples: [baseSample] };
  writeJson(join(baseDir, "manifest.json"), baseManifest);

  const train = {
    id: "captured-train", siteId: "train", siteFamily: "train.example.net", evaluationSplit: "train",
    vertical: "内容社区", type: "detail", discoveredType: "detail", finalUrl: "https://train.example.net/a",
  };
  const validation = {
    id: "captured-validation", siteId: "validation", siteFamily: "validation.example.org", evaluationSplit: "validation",
    vertical: "电商商品", type: "product", discoveredType: "product", finalUrl: "https://validation.example.org/b",
  };
  const incrementManifest = {
    schema: "corpus.v1",
    suite: "core",
    target: 2,
    captured: 2,
    samples: [train, validation],
    replacementPlan: {
      dimensions: ["evaluationSplit", "vertical", "discoveredType"],
      cells: [
        { evaluationSplit: "train", vertical: "内容社区", discoveredType: "detail", quota: 1 },
        { evaluationSplit: "validation", vertical: "电商商品", discoveredType: "product", quota: 1 },
      ],
    },
  };
  writeJson(join(incrementDir, "manifest.json"), incrementManifest);

  const finalBase = materializeSample(finalDir, {
    id: "core-0001", siteId: "base", siteFamily: "base.example.com", vertical: "综合资讯", type: "home",
    finalUrl: "https://base.example.com/", title: "基础页面", body: "这是基础语料的独立正文。",
  });
  const finalTrain = materializeSample(finalDir, {
    ...train, id: "core-0002", title: "训练页面", body: "训练页面提供社区讨论的独立正文。",
  });
  const finalValidation = materializeSample(finalDir, {
    ...validation, id: "core-0003", title: "验证页面", body: "验证页面提供商品资料的独立正文。",
  });
  const baseDigest = sha256(readFileSync(join(baseDir, "manifest.json")));
  const incrementDigest = sha256(readFileSync(join(incrementDir, "manifest.json")));
  const finalManifest = {
    schema: "corpus.v1",
    suite: "core",
    target: 3,
    captured: 3,
    samples: [finalBase, finalTrain, finalValidation],
    provenance: {
      kind: "composed-corpus",
      identity: "canonical-final-url",
      sources: [
        { role: "base", manifestSha256: baseDigest, schema: "corpus.v1", suite: "core", target: 1, captured: 1 },
        {
          role: "increment", manifestSha256: incrementDigest, schema: "corpus.v1", suite: "core", target: 2, captured: 2,
          replacementPlan: incrementManifest.replacementPlan,
        },
      ],
      selection: {
        mode: "replacement-cell",
        dimensions: ["evaluationSplit", "vertical", "discoveredType"],
        selectedBySource: { increment: 2 },
      },
    },
  };
  writeJson(join(finalDir, "manifest.json"), finalManifest);

  const policy = {
    exactSamples: 3,
    exactBaseSamples: 1,
    exactIncrementSplitCounts: { train: 1, validation: 1, test: 0 },
    minRegistrableDomains: 3,
    minVerticals: 3,
    minPageTypes: 3,
    requireScreenshots: true,
    requireContentAddressedAssets: true,
    requireAllSourceManifests: true,
  };
  const report = auditFinalCorpus({ corpusDir: finalDir, baseDir, sourceDirs: [incrementDir], policy });
  assert.equal(report.gate.ok, true, report.gate.failures.join("\n"));
  assert.deepEqual(report.corpus.increment.splitCounts, { train: 1, validation: 1 });
  assert.deepEqual(report.diversity.exactDuplicateExcess, {
    canonicalUrl: 0, inputDom: 0, frozenDom: 0, normalizedText: 0,
  });

  writeFileSync(join(finalDir, finalTrain.screenshot), "tampered");
  const tampered = auditFinalCorpus({ corpusDir: finalDir, baseDir, sourceDirs: [incrementDir], policy });
  assert.equal(tampered.gate.ok, false);
  assert.ok(tampered.gate.failures.some(value => value.includes("screenshot is not content-addressed")));

  writeFileSync(join(finalDir, finalTrain.screenshot), Buffer.from("jpeg:训练页面"));
  const leakingManifest = JSON.parse(readFileSync(join(finalDir, "manifest.json"), "utf8"));
  leakingManifest.samples[2].siteFamily = "base.example.com";
  writeJson(join(finalDir, "manifest.json"), leakingManifest);
  const leaking = auditFinalCorpus({ corpusDir: finalDir, baseDir, sourceDirs: [incrementDir], policy });
  assert.equal(leaking.gate.ok, false);
  assert.ok(leaking.gate.failures.includes("site-family split leakage: 1"));
});
