import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INTERNAL_CANDIDATE_KEYS } from "../benchmarks/article-extraction/instrument-extractor.mjs";

import {
  fastCaptureSettleArgs,
  core,
  increment,
  upstreamComparisonRunner,
  realworldRunner,
  manualAnnotateRunner,
  digest,
  writeFixtureCorpus,
  runAsync,
} from "../support/article-extraction-benchmark.mjs";

test("upstream parity language strata use the parsed frozen root declaration and preserve per-group metrics", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-upstream-language-strata-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const upstream = join(fixtureRoot, "upstream");
  const cache = join(upstream, "tests", "cache");
  const output = join(fixtureRoot, "comparison.json");
  const upstreamOutput = join(fixtureRoot, "python-results.json");
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(upstream, "trafilatura"), { recursive: true });

  const fixtures = [
    ["english", "<!-- <html lang='de'> --><html lang='EN_us'><body><article><p>English frozen main text.</p></article></body></html>"],
    ["german", "<html lang='de-DE'><body><article><p>German frozen main text.</p></article></body></html>"],
    ["french", "<html lang='fr'><body><article><p>French frozen main text.</p></article></body></html>"],
    ["missing", "<html><body><article><p>Missing frozen main text.</p></article></body></html>"],
  ];
  const annotations = {};
  for (const [name, html] of fixtures) {
    const file = `${name}.html`;
    writeFileSync(join(cache, file), html);
    annotations[`https://example.com/${name}`] = {
      file,
      with: [`${name[0].toUpperCase()}${name.slice(1)} frozen main text.`],
      without: [],
    };
  }
  writeFileSync(join(upstream, "tests", "evaldata.json"), `${JSON.stringify(annotations, null, 2)}\n`);
  writeFileSync(join(upstream, "trafilatura", "__init__.py"), `
__version__ = "fixture"

def extract(payload, **_kwargs):
    text = payload.decode("utf-8")
    start = text.index("<p>") + 3
    end = text.index("</p>", start)
    return text[start:end]
`);

  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("python3 is unavailable");
  const result = spawnSync(process.execPath, [
    upstreamComparisonRunner,
    "--upstream", upstream,
    "--python", "python3",
    "--output", output,
    "--upstream-output", upstreamOutput,
    "--refresh-upstream",
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const report = JSON.parse(readFileSync(output));
  assert.equal(report.schema, "qingzhou.article-extraction-upstream.v3");
  assert.equal(report.corpus.documents, 4);
  assert.equal(report.languageStrata.documents, report.corpus.documents);
  const groups = report.languageStrata.groups;
  assert.equal(groups["declared-English"].documents, 1, "a commented fake root must not override the parsed root language");
  assert.deepEqual(groups["declared-English"].declarations, { "en-us": 1 });
  assert.equal(groups["declared-German"].documents, 1);
  assert.deepEqual(groups["declared-German"].declarations, { "de-de": 1 });
  assert.equal(groups["other/unknown"].documents, 2);
  assert.deepEqual(groups["other/unknown"].declarations, { "(missing)": 1, fr: 1 });
  assert.equal(Object.values(groups).reduce((sum, group) => sum + group.documents, 0), report.corpus.documents);
  for (const group of Object.values(groups)) {
    assert.equal(group.algorithms["trafilatura-python"].f1, 1, "language-group scoring must use only that group's documents");
    for (const algorithm of ["legacy-readability", "qingzhou-current", "trafilatura-python"]) {
      const metrics = group.algorithms[algorithm];
      assert.equal(metrics.timing.samples, group.documents);
      for (const key of ["precision", "recall", "f1"]) assert.ok(Number.isFinite(metrics[key]), `${algorithm} ${key} is missing`);
    }
  }

  const treedpOutput = join(fixtureRoot, "comparison-treedp.json");
  const treedpResult = spawnSync(process.execPath, [
    upstreamComparisonRunner,
    "--upstream", upstream,
    "--python", "python3",
    "--output", treedpOutput,
    "--upstream-output", upstreamOutput,
    "--treedp",
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(treedpResult.status, 0, treedpResult.stderr || treedpResult.stdout);
  const treedpReport = JSON.parse(readFileSync(treedpOutput));
  assert.equal(treedpReport.provenance.treedpCandidate, true);
  assert.equal(typeof treedpReport.provenance.sourceSha256.instrumentExtractor, "string");
  assert.equal(treedpReport.algorithms["qingzhou-treedp"].timing.samples, fixtures.length);
  assert.deepEqual(Object.keys(treedpReport.headToHead).filter(key => key.includes("qingzhou-treedp")).sort(), [
    "legacy-readability_vs_qingzhou-treedp",
    "qingzhou-current_vs_qingzhou-treedp",
    "qingzhou-treedp_vs_trafilatura-python",
  ]);

  const defuddleBundle = join(fixtureRoot, "defuddle-fixture.js");
  writeFileSync(defuddleBundle, `
globalThis.Defuddle = class Defuddle {
  constructor(documentInput) { this.documentInput = documentInput; }
  parse() {
    const root = this.documentInput.querySelector("article") || this.documentInput.body;
    return { content: root ? root.outerHTML : "", extractorType: "fixture-extractor" };
  }
};
`);
  const defuddleOutput = join(fixtureRoot, "comparison-defuddle.json");
  const defuddleResult = spawnSync(process.execPath, [
    upstreamComparisonRunner,
    "--upstream", upstream,
    "--python", "python3",
    "--output", defuddleOutput,
    "--upstream-output", upstreamOutput,
    "--defuddle-bundle", defuddleBundle,
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(defuddleResult.status, 0, defuddleResult.stderr || defuddleResult.stdout);
  const defuddleReport = JSON.parse(readFileSync(defuddleOutput));
  assert.equal(defuddleReport.algorithms.defuddle.f1, 1);
  assert.equal(defuddleReport.algorithms.defuddle.strategies["fixture-extractor"], fixtures.length);
  assert.deepEqual(Object.keys(defuddleReport.headToHead).filter(key => key.endsWith("_vs_defuddle")).sort(), [
    "legacy-readability_vs_defuddle",
    "qingzhou-current_vs_defuddle",
    "trafilatura-python_vs_defuddle",
  ]);
  assert.equal(defuddleReport.languageStrata.groups["declared-English"].algorithms.defuddle.f1, 1);
  assert.equal(defuddleReport.provenance.sourceSha256.defuddle, digest(readFileSync(defuddleBundle)));
});

test("capture resume verifies checkpoint provenance and assets before skipping completed sites", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-resume-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const requests = new Map();
  const server = createServer((request, response) => {
    requests.set(request.url, (requests.get(request.url) || 0) + 1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<html><head><title>待续采站点</title></head><body><article>${"断点之后只采集尚未完成的站点。".repeat(30)}</article></body></html>`);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configPath = join(fixtureRoot, "config.json");
  const config = {
    schema: "qingzhou.article-extraction-sites.v1",
    sampleTarget: 2,
    strictSiteQuotas: true,
    sites: [{
      id: "completed",
      name: "Completed",
      vertical: "test",
      quota: 1,
      evaluationSplit: "train",
      siteFamily: "completed-family",
      discoveredType: "detail",
      hosts: ["127.0.0.1"],
      seeds: [{ type: "detail", url: `${origin}/must-not-run` }],
      detailPatterns: [],
    }, {
      id: "pending",
      name: "Pending",
      vertical: "test",
      quota: 1,
      evaluationSplit: "test",
      siteFamily: "pending-family",
      discoveredType: "detail",
      hosts: ["127.0.0.1"],
      seeds: [{ type: "detail", url: `${origin}/pending` }],
      detailPatterns: [],
    }],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const createCheckpoint = (output, snapshotBytes = Buffer.from("<html><body>已完成站点的冻结正文</body></html>")) => {
    mkdirSync(join(output, "snapshots"), { recursive: true });
    mkdirSync(join(output, "screenshots"), { recursive: true });
    const inputSha256 = digest(snapshotBytes);
    const screenshotBytes = Buffer.from("completed-site-audit-jpeg");
    const snapshot = `snapshots/${inputSha256}.html`;
    const screenshot = `screenshots/${digest(screenshotBytes)}.jpg`;
    writeFileSync(join(output, snapshot), snapshotBytes);
    writeFileSync(join(output, screenshot), screenshotBytes);
    const sample = {
      type: "detail",
      url: `${origin}/must-not-run`,
      siteId: "completed",
      siteName: "Completed",
      vertical: "test",
      evaluationSplit: "train",
      siteFamily: "completed-family",
      discoveredType: "detail",
      requestedUrl: `${origin}/must-not-run`,
      finalUrl: `${origin}/completed-final`,
      ok: true,
      inputSha256,
      snapshot,
      screenshot,
      screenshotSha256: digest(screenshotBytes),
      discoveredLinks: [],
      reference: { confidence: "high", requiredBlocks: ["已完成站点的冻结正文"] },
    };
    const checkpoint = {
      schema: "qingzhou.article-extraction-capture-checkpoint.v1",
      suite: "core",
      configSha256: digest(readFileSync(configPath)),
      effectivePlanSha256: digest(JSON.stringify(config)),
      screenshots: true,
      startedAt: "2026-08-14T00:00:00.000Z",
      completedSites: [{
        siteIndex: 0,
        siteId: "completed",
        sitePlanSha256: digest(JSON.stringify(config.sites[0])),
        result: {
          site: config.sites[0],
          quota: 1,
          successes: [sample],
          failures: [],
          reserveUrls: [],
        },
      }],
    };
    writeFileSync(join(output, ".capture-checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
    return { snapshot };
  };

  const output = join(fixtureRoot, "capture");
  createCheckpoint(output);
  const resumed = await runAsync(process.execPath, [
    realworldRunner,
    "capture",
    "--config", configPath,
    "--output", output,
    "--workers", "1",
    "--screenshots",
    "--resume",
    ...fastCaptureSettleArgs,
  ]);
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.deepEqual(manifest.samples.map(sample => sample.siteId), ["completed", "pending"]);
  assert.deepEqual(manifest.samples.map(sample => sample.evaluationSplit), ["train", "test"]);
  assert.deepEqual(manifest.samples.map(sample => sample.discoveredType), ["detail", "detail"]);
  assert.deepEqual(manifest.replacementPlan, {
    dimensions: ["evaluationSplit", "vertical", "discoveredType"],
    cells: [
      { evaluationSplit: "test", vertical: "test", discoveredType: "detail", quota: 1 },
      { evaluationSplit: "train", vertical: "test", discoveredType: "detail", quota: 1 },
    ],
  });
  assert.equal(requests.get("/must-not-run") || 0, 0, "a validated completed site must not be fetched again");
  assert.equal(requests.get("/pending"), 1);
  assert.equal(existsSync(join(output, ".capture-checkpoint.json")), false);
  assert.deepEqual(readdirSync(output).filter(name => name.includes(".tmp-")), []);

  const tamperedOutput = join(fixtureRoot, "tampered");
  const { snapshot } = createCheckpoint(tamperedOutput);
  writeFileSync(join(tamperedOutput, snapshot), "tampered snapshot bytes");
  const rejected = await runAsync(process.execPath, [
    realworldRunner,
    "capture",
    "--config", configPath,
    "--output", tamperedOutput,
    "--workers", "1",
    "--screenshots",
    "--resume",
    ...fastCaptureSettleArgs,
  ]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /snapshot digest mismatch/);
  assert.equal(requests.get("/pending"), 1, "invalid checkpoint assets must fail before any live page is fetched");
  assert.equal(existsSync(join(tamperedOutput, ".capture-checkpoint.json")), true, "a failed resume must preserve its checkpoint for diagnosis or repair");
});

test("DeepSeek seed labeling sends text-only DOM and text drafts without screenshot payloads", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-manual-label-text-only-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const corpus = join(fixtureRoot, "corpus");
  const candidates = join(fixtureRoot, "candidates");
  const output = join(fixtureRoot, "labels");
  const keyFile = join(fixtureRoot, "dpsk");
  mkdirSync(join(corpus, "snapshots"), { recursive: true });
  mkdirSync(join(corpus, "screenshots"), { recursive: true });
  const hiddenNoise = "冻结前由页面 CSS 隐藏的调试文本不得进入标注";
  const commentNoise = "internal-template-id-5bd54bdea3101a87ca8ff5f0";
  const html = Buffer.from(`<html><head><title>测试正文</title></head><body><main><article><h1>测试正文</h1><p>这是冻结 DOM 中足够长的中心正文内容，用于验证纯文本标注请求。正文继续提供稳定且明确的语义，使文章区域超过索引阈值。</p><figure><figcaption>短视频</figcaption></figure><aside hidden>${hiddenNoise}</aside><!--${commentNoise}--></article><article><h2>第二段中心内容</h2><p>并列中心区域应按页面顺序进入最终金标，而不是服从模型数组顺序。</p></article></main><nav><p>导航</p></nav></body></html>`);
  const inputSha256 = digest(html);
  const excludedHtml = Buffer.from("<html><head><title>登录</title></head><body><main>请登录</main></body></html>");
  const excludedSha256 = digest(excludedHtml);
  const screenshotBytes = Buffer.from("not-a-real-image");
  const screenshotPath = `screenshots/${digest(screenshotBytes)}.jpg`;
  writeFileSync(join(corpus, "snapshots", `${inputSha256}.html`), html);
  writeFileSync(join(corpus, "snapshots", `${excludedSha256}.html`), excludedHtml);
  writeFileSync(join(corpus, screenshotPath), screenshotBytes);
  writeFixtureCorpus(corpus, {
    schema: "qingzhou.article-extraction-corpus.v1",
    target: 2,
    captured: 2,
    samples: [{
      id: "core-0001",
      siteId: "fixture",
      siteName: "Fixture",
      vertical: "test",
      type: "detail",
      requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      title: "测试正文",
      inputSha256,
      snapshot: `snapshots/${inputSha256}.html`,
      screenshot: screenshotPath,
    }, {
      id: "core-0002",
      siteId: "fixture-excluded",
      siteName: "Fixture excluded",
      vertical: "test",
      type: "detail",
      requestedUrl: "https://example.com/login",
      finalUrl: "https://example.com/login",
      title: "登录",
      inputSha256: excludedSha256,
      snapshot: `snapshots/${excludedSha256}.html`,
      screenshot: "",
    }],
    failures: [],
  });
  for (const algorithm of ["legacy-readability", "qingzhou-current", "trafilatura-python"]) {
    const directory = join(candidates, "outputs", algorithm);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "core-0001.json"), `${JSON.stringify({
      mode: "article",
      text: `纯文本候选 ${algorithm}`,
      markdown: `![不应发送](data:image/png;base64,AAAA)\n\n纯文本候选 ${algorithm}`,
    })}\n`);
    writeFileSync(join(directory, "core-0002.json"), `${JSON.stringify({ mode: "", text: "" })}\n`);
  }
  writeFileSync(keyFile, "fixture-key\n");

  const requests = [];
  const attempts = new Map();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      requests.push(JSON.parse(body));
      const packet = JSON.parse(requests.at(-1).messages.find(message => message.role === "user").content);
      const attempt = (attempts.get(packet.sample.id) || 0) + 1;
      attempts.set(packet.sample.id, attempt);
      let label;
      if (packet.sample.id === "core-0001" && attempt === 1) {
        label = {
          status: "extract", includeRegionIds: ["R0003"], excludeRegionIds: ["R0006"],
          requiredBlockIds: ["B0001"], forbiddenBlockIds: [], bestDraft: "A", confidence: "high",
          rationale: "非法跨区域排除", visualReviewNeeded: true, excludeReason: "",
        };
      } else if (packet.sample.id === "core-0001" && attempt === 2) {
        label = {
          status: "extract", includeRegionIds: ["R0003", "R0005"], excludeRegionIds: [],
          requiredBlockIds: ["B0001", "B0004"], forbiddenBlockIds: ["B0001"], bestDraft: "A", confidence: "high",
          rationale: "非法短负例", visualReviewNeeded: true, excludeReason: "",
        };
      } else if (packet.sample.id === "core-0001") {
        label = {
          status: "extract", includeRegionIds: ["R0005", "R0003"], excludeRegionIds: [],
          requiredBlockIds: ["B0001", "B0004"], forbiddenBlockIds: [], bestDraft: "A", confidence: "high",
          rationale: "article 是中心正文", visualReviewNeeded: true, excludeReason: "",
        };
      } else if (attempt === 1) {
        label = {
          status: "skip", includeRegionIds: [], excludeRegionIds: [], requiredBlockIds: [], forbiddenBlockIds: [],
          bestDraft: "none", confidence: "high", rationale: "非法状态", visualReviewNeeded: true, excludeReason: "登录墙",
        };
      } else if (attempt === 2) {
        label = {
          status: "exclude", includeRegionIds: ["R0001"], excludeRegionIds: [], requiredBlockIds: [], forbiddenBlockIds: [],
          bestDraft: "none", confidence: "high", rationale: "非法排除选择", visualReviewNeeded: true, excludeReason: "登录墙",
        };
      } else {
        label = {
          status: "exclude", includeRegionIds: [], excludeRegionIds: [], requiredBlockIds: [], forbiddenBlockIds: [],
          bestDraft: "none", confidence: "high", rationale: "中心内容不存在", visualReviewNeeded: true, excludeReason: "登录墙",
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(label) } }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/completions`;
  const result = await runAsync(process.execPath, [
    manualAnnotateRunner,
    "seed",
    "--corpus", corpus,
    "--candidates", candidates,
    "--output", output,
    "--key-file", keyFile,
    "--endpoint", endpoint,
    "--workers", "1",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(requests.length, 6);
  assert.deepEqual(Object.fromEntries(attempts), { "core-0001": 3, "core-0002": 3 });
  assert.match(JSON.parse(requests[1].messages.find(message => message.role === "user").content).validationError, /strict descendants/);
  assert.match(JSON.parse(requests[2].messages.find(message => message.role === "user").content).validationError, /forbidden block/);
  assert.match(JSON.parse(requests[4].messages.find(message => message.role === "user").content).validationError, /invalid label status/);
  assert.match(JSON.parse(requests[5].messages.find(message => message.role === "user").content).validationError, /empty region and block selections/);
  assert.ok(requests[0].messages.every(message => typeof message.content === "string"));
  assert.match(requests[0].messages[0].content, /thread\/discussion.+主帖.+有序回复/s);
  assert.match(requests[0].messages[0].content, /entity\/product\/service\/company\/place\/job.+核心属性.+列表和表格/s);
  assert.match(requests[0].messages[0].content, /高链接密度本身不代表导航/);
  assert.doesNotMatch(JSON.stringify(requests[0]), /data:image|image_url|screenshotAvailable|audit\.jpg/i);
  const packet = JSON.parse(requests[0].messages.find(message => message.role === "user").content);
  assert.equal(packet.sample.id, "core-0001");
  assert.match(JSON.stringify(packet.dom), /冻结 DOM 中足够长的中心正文内容/, "static replay must preserve hydrated DOM content");
  assert.doesNotMatch(JSON.stringify(packet.dom), new RegExp(`${hiddenNoise}|${commentNoise}`), "review packets must contain only visible page text");
  assert.ok(packet.dom.regions.some(region => region.tag === "figure" && region.text === "短视频"), "short media regions must remain selectable");
  assert.ok(packet.dom.regions.some(region => region.tag === "nav" && region.text === "导航"), "short standard page chrome must remain excludable");
  assert.ok(packet.dom.regions.every(region => (
    Number.isInteger(region.directChildren)
    && region.childTags && typeof region.childTags === "object"
    && Number.isInteger(region.repeatedSiblings)
    && Number.isInteger(region.listItems)
    && Number.isInteger(region.tableRows)
  )), "review regions must expose neutral collection structure");
  assert.equal(Object.hasOwn(packet.sample, "screenshot"), false);
  assert.equal(Object.hasOwn(packet.sample, "screenshotAvailable"), false);
  assert.ok(Object.values(packet.anonymousDrafts).every(draft => /^纯文本候选 /.test(draft.content)));
  assert.equal(JSON.parse(readFileSync(join(output, "manifest.json"))).modality, "text");

  const invalidDecisionsPath = join(fixtureRoot, "invalid-decisions.json");
  const invalidFinalOutput = join(fixtureRoot, "invalid-gold");
  writeFileSync(invalidDecisionsPath, `${JSON.stringify({
    schema: "qingzhou.article-extraction-manual-decisions.v1",
    corpusDigest: digest(readFileSync(join(corpus, "manifest.json"))),
    reviewer: "fixture-reviewer",
    samples: [{
      id: "core-0001",
      source: "manual",
      status: "extract",
      selection: {
        includeRegionIds: ["R0002", "R0003"],
        excludeRegionIds: [],
        requiredBlockIds: ["B0001"],
        forbiddenBlockIds: [],
      },
      domReviewed: true,
      screenshotReviewed: true,
      notes: "故意提交嵌套区域以验证终审拒绝。",
    }, {
      id: "core-0002",
      source: "v4",
      domReviewed: true,
      screenshotReviewed: false,
      notes: "登录墙。",
    }],
  }, null, 2)}\n`);
  const invalidFinalized = await runAsync(process.execPath, [
    manualAnnotateRunner,
    "finalize",
    "--corpus", corpus,
    "--candidates", candidates,
    "--decisions", invalidDecisionsPath,
    "--source-v4", output,
    "--output", invalidFinalOutput,
  ]);
  assert.notEqual(invalidFinalized.status, 0, "finalize must reject nested include regions");
  assert.match(invalidFinalized.stderr, /included regions must not contain one another/);
  assert.equal(existsSync(invalidFinalOutput), false);

  const decisionsPath = join(fixtureRoot, "decisions.json");
  const finalOutput = join(fixtureRoot, "gold");
  writeFileSync(decisionsPath, `${JSON.stringify({
    schema: "qingzhou.article-extraction-manual-decisions.v1",
    corpusDigest: digest(readFileSync(join(corpus, "manifest.json"))),
    reviewer: "fixture-reviewer",
    reviewedAt: "2026-08-14T00:00:00.000Z",
    samples: [{
      id: "core-0001",
      source: "v4",
      domReviewed: true,
      screenshotReviewed: true,
      notes: "人工检查冻结 DOM 和截图后确认正文区域。",
    }, {
      id: "core-0002",
      source: "v4",
      domReviewed: true,
      screenshotReviewed: false,
      notes: "人工检查冻结 DOM 后确认登录墙没有中心内容。",
    }],
  }, null, 2)}\n`);
  const finalized = await runAsync(process.execPath, [
    manualAnnotateRunner,
    "finalize",
    "--corpus", corpus,
    "--candidates", candidates,
    "--decisions", decisionsPath,
    "--source-v4", output,
    "--output", finalOutput,
  ]);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  const finalManifest = JSON.parse(readFileSync(join(finalOutput, "manifest.json")));
  const finalLabel = JSON.parse(readFileSync(join(finalOutput, "labels", "core-0001.json")));
  assert.equal(finalManifest.pendingHumanReview, 0);
  assert.deepEqual(finalManifest.status, { extract: 1, exclude: 1 });
  assert.equal(finalLabel.reference.method, "human-reviewed-frozen-dom");
  assert.equal(finalLabel.review.status, "approved");
  assert.equal(finalLabel.review.domReviewed, true);
  assert.equal(finalLabel.review.screenshotReviewed, true);
  assert.equal(finalLabel.reference.excludeReason, "");
  assert.deepEqual(finalLabel.selection.includeRegionIds, ["R0003", "R0005"], "parallel include regions must be materialized in DOM order");
  assert.ok(finalLabel.reference.mainText.indexOf("测试正文") < finalLabel.reference.mainText.indexOf("第二段中心内容"));
  assert.doesNotMatch(finalLabel.reference.mainText, new RegExp(`${hiddenNoise}|${commentNoise}`), "gold text must exclude frozen hidden roots and HTML comments");
  const excludedLabel = JSON.parse(readFileSync(join(finalOutput, "labels", "core-0002.json")));
  assert.equal(excludedLabel.status, "exclude");
  assert.equal(excludedLabel.reference.excludeReason, "登录墙");
  assert.equal(excludedLabel.seed.excludeReason, "登录墙");

  rmSync(finalOutput, { recursive: true, force: true });
  writeFileSync(join(corpus, screenshotPath), Buffer.from("overwritten-review-image"));
  const overwrittenScreenshot = await runAsync(process.execPath, [
    manualAnnotateRunner,
    "finalize",
    "--corpus", corpus,
    "--candidates", candidates,
    "--decisions", decisionsPath,
    "--source-v4", output,
    "--output", finalOutput,
  ]);
  assert.notEqual(overwrittenScreenshot.status, 0);
  assert.match(overwrittenScreenshot.stderr, /core-0001 screenshot is not the content-addressed review image/);
});

test("real-world runner scores approved gold extracts and excludes in separate base and increment shards", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-gold-score-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const corpus = join(fixtureRoot, "corpus");
  const labels = join(fixtureRoot, "manual-labels-final-v1");
  const output = join(fixtureRoot, "report");
  const upstream = join(fixtureRoot, "upstream");
  mkdirSync(join(corpus, "snapshots"), { recursive: true });
  mkdirSync(join(corpus, "screenshots"), { recursive: true });
  mkdirSync(join(labels, "labels"), { recursive: true });
  mkdirSync(join(upstream, "trafilatura"), { recursive: true });
  const screenshotBytes = Buffer.from("human-review-screenshot");
  const screenshot = `screenshots/${digest(screenshotBytes)}.jpg`;
  writeFileSync(join(corpus, screenshot), screenshotBytes);

  const internalOracleGold = "结构化正文是该页面唯一应当保留的中心内容，内部 baseline 候选可以完整恢复。".repeat(8);
  const internalOracleNoise = "页面可见但与人工金标无关的冗长占位内容会被当前启发式选中。".repeat(14);
  const markdownQualityGold = "人工金标正文保持完整".repeat(4);
  const fixtures = [
    ["core-0001", "extract", `<html><head><meta name="fixture" content="MARKDOWN_QUALITY_FIXTURE"></head><body><article>${markdownQualityGold}<img src="https://cdn.example.com/placeholder.jpg" data-src="https://cdn.example.com/product.jpg" alt=""></article></body></html>`, markdownQualityGold],
    ["core-0301", "exclude", "<html><body><main>NONEMPTY_EXCLUDE</main></body></html>", ""],
    ["core-0302", "exclude", "<html><body>EXCLUDE_EMPTY</body></html>", ""],
    ["core-0303", "exclude", "<html><body>PY_ERROR</body></html>", ""],
    ["core-0304", "extract", `<html><head><meta name="fixture" content="INTERNAL_ORACLE_FIXTURE"><script type="application/ld+json">${JSON.stringify({
      "@type": "Article",
      articleBody: internalOracleGold,
    })}</script></head><body><article><p>${internalOracleNoise}</p></article></body></html>`, internalOracleGold],
  ];
  const samples = fixtures.map(([id, , html]) => {
    const bytes = Buffer.from(html);
    const inputSha256 = digest(bytes);
    const snapshot = `snapshots/${inputSha256}.html`;
    writeFileSync(join(corpus, snapshot), bytes);
    return {
      id,
      siteId: "fixture",
      type: id === "core-0304" ? "channel" : "detail",
      vertical: "test",
      requestedUrl: `https://example.com/${id}`,
      finalUrl: `https://example.com/${id}`,
      inputSha256,
      snapshot,
      screenshot: id === "core-0001" ? screenshot : "",
    };
  });
  writeFixtureCorpus(corpus, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: samples.length,
    captured: samples.length,
    samples,
    failures: [],
    provenance: {
      kind: "composed-corpus",
      sources: [
        { role: "base", target: 2 },
        { role: "increment", target: 3 },
      ],
    },
  });
  fixtures.forEach(([id, status, , mainText], index) => {
    writeFileSync(join(labels, "labels", `${id}.json`), `${JSON.stringify({
      schema: "qingzhou.article-extraction-manual-label.v1",
      sampleId: id,
      inputSha256: samples[index].inputSha256,
      status,
      reference: {
        method: "human-reviewed-frozen-dom",
        confidence: "high",
        mainText,
        requiredBlocks: mainText ? [mainText] : [],
        noiseBlocks: [],
        structures: { headings: 0, lists: 0, tables: 0, codeBlocks: 0 },
      },
      review: { status: "approved", domReviewed: true, screenshotReviewed: Boolean(samples[index].screenshot) },
    }, null, 2)}\n`);
  });
  const labelManifest = {
    schema: "qingzhou.article-extraction-manual-label-set.v1",
    corpus: join(corpus, "manifest.json"),
    corpusDigest: digest(readFileSync(join(corpus, "manifest.json"))),
    method: "human-reviewed-frozen-dom",
    samples: samples.length,
    status: { extract: 2, exclude: 3 },
    pendingHumanReview: 0,
  };
  writeFileSync(join(labels, "manifest.json"), `${JSON.stringify(labelManifest, null, 2)}\n`);
  writeFileSync(join(upstream, "trafilatura", "__init__.py"), `
def extract(payload, **kwargs):
    text = payload.decode("utf-8")
    if "PY_ERROR" in text:
        raise RuntimeError("fixture failure")
    if "EXCLUDE_EMPTY" in text:
        return None
    if "NONEMPTY_EXCLUDE" in text:
        return "NONEMPTY_EXCLUDE"
    if "INTERNAL_ORACLE_FIXTURE" in text:
        return ${JSON.stringify(internalOracleGold)}
    if "MARKDOWN_QUALITY_FIXTURE" in text and kwargs.get("output_format") == "markdown":
        return ${JSON.stringify(`${markdownQualityGold}\n\n~~~~js\nconst broken = true;`)}
    return ${JSON.stringify(markdownQualityGold)}
`);
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("python3 is unavailable");
  const run = (target, extraArgs = []) => spawnSync(process.execPath, [
    realworldRunner,
    "run",
    "--corpus", corpus,
    "--labels", labels,
    "--output", target,
    "--upstream", upstream,
    "--python", "python3",
    "--workers", "1",
    ...extraArgs,
  ], { encoding: "utf8" });
  const result = run(output);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(readFileSync(join(output, "report.json")));
  assert.equal(report.schema, "qingzhou.article-extraction-report.v4");
  assert.deepEqual(report.provenance.candidateProvenance, { enabled: false });
  assert.equal(report.corpus.labelMethod, "human-reviewed-frozen-dom");
  assert.deepEqual(report.corpus.labelStatus, { extract: 2, exclude: 3 });
  const scored = report.algorithms["trafilatura-python"].gold;
  assert.equal(scored.base.extract.samples, 1);
  assert.equal(scored.base.extract.mainNgramF1, 1);
  assert.deepEqual(scored.base.exclude, {
    samples: 1,
    errors: 0,
    empty: 0,
    falsePositive: 1,
  }, "composed provenance must define the shard boundary instead of the legacy core-0300 cutoff");
  assert.equal(scored.increment.extract.samples, 1);
  assert.equal(scored.increment.extract.mainNgramF1, 1);
  assert.deepEqual(scored.increment.exclude, {
    samples: 2,
    errors: 1,
    empty: 1,
    falsePositive: 0,
  });
  assert.equal(scored.combined.extract.samples, 2, "exclude pages must not enter text F1");
  assert.equal(scored.base.extract.markdownQuality.syntaxDefects, 1, "the real runner must aggregate AST-backed Markdown diagnostics");
  assert.equal(scored.base.extract.markdownQuality.parserErrors, 0);
  assert.equal(scored.base.extract.markdownQuality.roundTripPrecisionDrifts, 1);
  assert.equal(scored.base.extract.markdownQuality.roundTripDrifts, 1);
  const markdownQualitySample = report.perSample["trafilatura-python"].find(item => item.id === "core-0001");
  assert.equal(markdownQualitySample.metrics.markdown.syntax.unclosedFences, 1);
  assert.equal(markdownQualitySample.metrics.markdown.roundTrip.materialPrecisionDrift, true);

  assert.deepEqual(report.crossExtractorOracle.extractors, [
    "qingzhou-current",
    "legacy-readability",
    "trafilatura-python",
  ]);
  assert.equal(report.crossExtractorOracle.baseline, "qingzhou-current");
  assert.deepEqual(report.crossExtractorOracle.gold.base, {
    samples: 1,
    noExtractorOutput: 0,
    upperBound: { mainNgramPrecision: 1, mainNgramRecall: 1, mainNgramF1: 1 },
    baseline: { algorithm: "qingzhou-current", mainNgramF1: 1 },
    selectionLoss: { mainNgramF1: 0, improvableSamples: 0 },
    selectedExtractorCounts: {
      "qingzhou-current": 1,
      "legacy-readability": 0,
      "trafilatura-python": 0,
    },
  }, "exact ties should stay with the current extractor");
  assert.deepEqual(report.crossExtractorOracle.gold.increment, {
    samples: 1,
    noExtractorOutput: 0,
    upperBound: { mainNgramPrecision: 1, mainNgramRecall: 1, mainNgramF1: 1 },
    baseline: { algorithm: "qingzhou-current", mainNgramF1: 0 },
    selectionLoss: { mainNgramF1: 1, improvableSamples: 1 },
    selectedExtractorCounts: {
      "qingzhou-current": 0,
      "legacy-readability": 0,
      "trafilatura-python": 1,
    },
  });
  assert.equal(report.crossExtractorOracle.gold.combined.upperBound.mainNgramF1, 1);
  assert.equal(report.crossExtractorOracle.gold.combined.baseline.mainNgramF1, 0.5);
  assert.equal(report.crossExtractorOracle.gold.combined.selectionLoss.mainNgramF1, 0.5);
  assert.equal(report.crossExtractorOracle.gold.combined.selectionLoss.improvableSamples, 1);
  assert.equal(report.crossExtractorOracle.byType.detail.samples, 1);
  assert.equal(report.crossExtractorOracle.byType.channel.samples, 1);
  assert.equal(report.crossExtractorOracle.byType.channel.selectionLoss.mainNgramF1, 1);

  assert.deepEqual(report.internalCandidateOracle.candidates, INTERNAL_CANDIDATE_KEYS);
  assert.equal(report.internalCandidateOracle.baseline, "qingzhou-current");
  assert.equal(report.internalCandidateOracle.contentCapChars, 80_000);
  assert.deepEqual(report.internalCandidateOracle.gold.base, {
    samples: 1,
    noCandidateOutput: 0,
    upperBound: { mainNgramPrecision: 1, mainNgramRecall: 1, mainNgramF1: 1 },
    baseline: { algorithm: "qingzhou-current", mainNgramF1: 1 },
    selectionLoss: { mainNgramF1: 0, improvableSamples: 0 },
    selectedCandidateCounts: {
      rules: 0,
      readability: 1,
      paragraph: 0,
      baseline: 0,
      recall: 0,
      treedp: 0,
    },
  }, "the oracle must select the first available best candidate");
  assert.deepEqual(report.internalCandidateOracle.gold.increment, {
    samples: 1,
    noCandidateOutput: 0,
    upperBound: { mainNgramPrecision: 1, mainNgramRecall: 1, mainNgramF1: 1 },
    baseline: { algorithm: "qingzhou-current", mainNgramF1: 0 },
    selectionLoss: { mainNgramF1: 1, improvableSamples: 1 },
    selectedCandidateCounts: {
      rules: 0,
      readability: 0,
      paragraph: 0,
      baseline: 1,
      recall: 0,
      treedp: 0,
    },
  });
  assert.equal(report.internalCandidateOracle.gold.combined.upperBound.mainNgramF1, 1);
  assert.equal(report.internalCandidateOracle.gold.combined.baseline.mainNgramF1, 0.5);
  assert.equal(report.internalCandidateOracle.gold.combined.selectionLoss.mainNgramF1, 0.5);
  const diagnosticLines = readFileSync(join(output, "internal-candidates.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(diagnosticLines.length, fixtures.length);
  assert.ok(diagnosticLines.every(item => item.schema === "qingzhou.article-extraction-internal-candidates.v3"));
  assert.ok(diagnosticLines.every(item => item.benchmarkDiagnostics?.schema === "qingzhou.article-extraction-benchmark-diagnostics.v1"));
  assert.ok(diagnosticLines.every(item => item.candidateProvenance?.enabled === false));
  assert.ok(diagnosticLines.every(item => item.benchmarkDiagnostics?.candidateProvenanceEnabled === false));
  assert.ok(diagnosticLines.every(item => !("provenance" in item.benchmarkDiagnostics)));
  assert.ok(diagnosticLines.every(item => item.productCurrent?.available === true));
  assert.equal(diagnosticLines.find(item => item.id === "core-0001").productCurrent.metrics.mainNgramF1, 1);
  assert.equal(diagnosticLines.find(item => item.id === "core-0304").productCurrent.metrics.mainNgramF1, 0);
  assert.ok(diagnosticLines.every(item => item.candidates.length === INTERNAL_CANDIDATE_KEYS.length));
  assert.ok(diagnosticLines.flatMap(item => item.candidates).every(candidate => (
    !candidate.output || (candidate.output.text.length <= 80_000 && candidate.output.markdown.length <= 80_000)
  )));
  const internalFixture = JSON.parse(readFileSync(join(output, "outputs", "qingzhou-internal", "core-0304.json")));
  assert.equal(internalFixture.candidates.find(candidate => candidate.key === "baseline").metrics.mainNgramF1, 1);
  assert.equal(internalFixture.candidates.find(candidate => candidate.key === "rules").metrics.mainNgramF1, 0);
  const markdownReport = readFileSync(join(output, "report.md"), "utf8");
  assert.match(markdownReport, /Cross-extractor ensemble oracle/);
  assert.match(markdownReport, /Qingzhou internal candidate oracle/);
  assert.match(markdownReport, /Candidate provenance: disabled\./);
  assert.match(markdownReport, /\| type:channel \| 1 \| 1\.0000 \| 0\.0000 \| 1\.0000 \|/);

  const defuddleBundle = join(fixtureRoot, "defuddle-fixture.js");
  writeFileSync(defuddleBundle, `
globalThis.Defuddle = class Defuddle {
  constructor(documentInput) { this.documentInput = documentInput; }
  parse() {
    const root = this.documentInput.querySelector("article,main") || this.documentInput.body;
    const content = this.documentInput.querySelector('meta[content="INTERNAL_ORACLE_FIXTURE"]')
      ? '<iframe src="https://example.com/embed"></iframe>'
      : (root ? root.outerHTML : "");
    return {
      content,
      contentMarkdown: globalThis.Defuddle.createMarkdownContent(content),
      extractorType: "fixture-extractor",
      parseTime: 1,
    };
  }
};
globalThis.Defuddle.createMarkdownContent = content => {
  if (content.includes("<iframe")) return content;
  const documentInput = new DOMParser().parseFromString(content, "text/html");
  return documentInput.body?.textContent || "";
};
`);
  const defuddleOutput = join(fixtureRoot, "report-defuddle");
  const defuddleRun = run(defuddleOutput, [
    "--defuddle-bundle", defuddleBundle,
    "--defuddle-markdown", "both",
    "--candidate-provenance",
  ]);
  assert.equal(defuddleRun.status, 0, defuddleRun.stderr || defuddleRun.stdout);
  const defuddleReport = JSON.parse(readFileSync(join(defuddleOutput, "report.json")));
  assert.ok(defuddleReport.algorithms["defuddle-shared"]);
  assert.ok(defuddleReport.algorithms["defuddle-native"]);
  assert.deepEqual(defuddleReport.crossExtractorOracle.extractors, [
    "qingzhou-current",
    "legacy-readability",
    "trafilatura-python",
    "defuddle-shared",
  ]);
  assert.deepEqual(defuddleReport.algorithms["defuddle-shared"].gold.combined.extract.modes, {
    "fixture-extractor": 2,
  });
  assert.equal(defuddleReport.algorithms["defuddle-shared"].gold.combined.extract.markdownQuality.roundTripDrifts, 0);
  assert.equal(defuddleReport.algorithms["defuddle-shared"].gold.combined.extract.markdownQuality.paginationSemanticDrifts, 0);
  assert.equal(defuddleReport.provenance.defuddle.serializer, "both");
  assert.deepEqual(defuddleReport.provenance.candidateProvenance, { enabled: true });
  assert.equal(defuddleReport.provenance.defuddle.bundleSha256, digest(readFileSync(defuddleBundle)));
  const defuddleDiagnostics = readFileSync(join(defuddleOutput, "internal-candidates.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(defuddleDiagnostics.every(item => item.candidateProvenance?.enabled === true));
  assert.ok(defuddleDiagnostics.every(item => item.benchmarkDiagnostics?.candidateProvenanceEnabled === true));
  assert.ok(defuddleDiagnostics.every(item => (
    item.benchmarkDiagnostics?.provenance?.schema === "qingzhou.article-extraction-provenance.v1"
      && item.benchmarkDiagnostics.provenance.sourceTree.treeElements.length > 0
  )));
  const defuddleSharedFixture = JSON.parse(readFileSync(join(defuddleOutput, "outputs", "defuddle-shared", "core-0001.json")));
  assert.match(defuddleSharedFixture.markdown, /https:\/\/cdn\.example\.com\/product\.jpg/);
  assert.doesNotMatch(defuddleSharedFixture.markdown, /placeholder\.jpg/, "shared mode must use the Qingzhou product serializer, not bare Turndown");

  labelManifest.pendingHumanReview = 1;
  writeFileSync(join(labels, "manifest.json"), `${JSON.stringify(labelManifest, null, 2)}\n`);
  const rejected = run(join(fixtureRoot, "rejected-pending"));
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /pending human reviews/);

  labelManifest.pendingHumanReview = 0;
  writeFileSync(join(labels, "manifest.json"), `${JSON.stringify(labelManifest, null, 2)}\n`);
  const firstLabelPath = join(labels, "labels", "core-0001.json");
  const firstLabel = JSON.parse(readFileSync(firstLabelPath));
  firstLabel.inputSha256 = "0".repeat(64);
  writeFileSync(firstLabelPath, `${JSON.stringify(firstLabel, null, 2)}\n`);
  const mismatched = run(join(fixtureRoot, "rejected-digest"));
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /core-0001 gold label does not match inputSha256/);

  firstLabel.inputSha256 = samples[0].inputSha256;
  writeFileSync(firstLabelPath, `${JSON.stringify(firstLabel, null, 2)}\n`);
  writeFileSync(join(labels, "labels", "unknown.json"), "{}\n");
  const unknown = run(join(fixtureRoot, "rejected-ids"));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /gold label ids do not match corpus ids/);

  rmSync(join(labels, "labels", "unknown.json"));
  writeFileSync(join(corpus, screenshot), Buffer.from("overwritten-review-screenshot"));
  const overwrittenScreenshot = run(join(fixtureRoot, "rejected-screenshot"));
  assert.notEqual(overwrittenScreenshot.status, 0);
  assert.match(overwrittenScreenshot.stderr, /core-0001 screenshot is not the content-addressed review image/);
});
