import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  criticPacket,
  RESPONSE_SCHEMA,
  createZipArtifact,
  defaultMarkdownInstruction,
  formatPlanFor,
  normalizeTeacherResult,
  parseCsv,
  splitPages,
  trainingDeliveryErrors,
  trainingDeliveryRow,
  trainingPrompt,
  validateCriticResult,
  validateTeacherResult,
} from "../benchmarks/article-extraction/generate-training-variations.mjs";
import { sha256, writeJsonlAtomic } from "../benchmarks/article-extraction/training-variation-pack-integrity.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qz-training-zip-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("variation format plans are deterministic and always use two distinct formats", () => {
  const first = formatPlanFor("core-0001");
  assert.deepEqual(first, formatPlanFor("core-0001"));
  assert.equal(first.length, 2);
  assert.notEqual(first[0].outputFormat, first[1].outputFormat);
  assert.deepEqual(first.map(item => item.slot), [1, 2]);

  const prompt = trainingPrompt("抽取标题", "https://example.com/a", "<html><title>A</title></html>");
  assert.equal(prompt, "抽取标题\n\n页面 URL：https://example.com/a\n\nHTML：\n<html><title>A</title></html>");
});

test("delivery rows contain exactly seven fields, full HTML, direct output, and varied Chinese instructions", () => {
  const t0 = trainingDeliveryRow({
    sample_id: "core-0001__t0",
    page_id: "core-0001",
    url: "https://example.com/a",
    task_idx: 0,
    task_type: "md",
    instruction: "旧指令",
    output: "# 正文\n",
  }, "<!doctype html><html><body>正文</body></html>");
  assert.deepEqual(Object.keys(t0), ["sample_id", "page_id", "url", "task_type", "instruction", "html", "output"]);
  assert.equal(t0.html, "<!doctype html><html><body>正文</body></html>");
  assert.equal(t0.output, "# 正文\n");
  assert.equal(t0.instruction, defaultMarkdownInstruction("core-0001"));
  assert.deepEqual(trainingDeliveryErrors(t0), []);
  assert.ok(new Set(Array.from({ length: 100 }, (_, index) => defaultMarkdownInstruction(`core-${index}`))).size > 10);

  const custom = trainingDeliveryRow({
    sample_id: "core-0001__t1",
    page_id: "core-0001",
    url: "https://example.com/a",
    task_idx: 1,
    task_type: "title_only",
    instruction: "请抽取页面标题。",
    output: "标题",
  }, "<html>标题</html>");
  assert.equal(custom.instruction, "请抽取页面标题。");
  assert.deepEqual(trainingDeliveryErrors(custom), []);
  assert.match(trainingDeliveryErrors({ ...custom, output: "```text\n标题\n```" }).join("\n"), /code fence/);
});

test("critic is bound to the full-page request and cannot accept with hidden errors", () => {
  const teacher = { variations: [{ slot: 1 }, { slot: 2 }] };
  const packet = criticPacket("core-critic", teacher, { pageText: "完整页面", pageHtml: "<main>完整页面</main>" });
  assert.equal(packet.pageEvidence.pageText, "完整页面");
  const result = {
    schema: "qingzhou.web-extraction-variation-critic.v2",
    sampleId: "core-critic",
    requestSha256: packet.requestSha256,
    teacherResultSha256: packet.teacherResultSha256,
    accepted: true,
    verdicts: [
      { slot: 1, accepted: true, errors: [] },
      { slot: 2, accepted: true, errors: [] },
    ],
  };
  assert.deepEqual(validateCriticResult(result, "core-critic", packet), []);
  result.verdicts[0].errors.push("遗漏一项");
  assert.match(validateCriticResult(result, "core-critic", packet).join("\n"), /accepted with non-empty errors/);
  result.verdicts[0].errors = [];
  result.requestSha256 = "stale";
  assert.match(validateCriticResult(result, "core-critic", packet).join("\n"), /request digest mismatch/);
});

test("teacher normalization replaces contextless numeric evidence with identifying page context", () => {
  const result = normalizeTeacherResult({
    schema: RESPONSE_SCHEMA,
    sampleId: "core-numeric",
    variations: [{
      slot: 1,
      outputFormat: "plain_text",
      output: "点赞数：82\n收藏数：129\n评论数：6",
      answerMode: "structured_verbatim",
      evidenceQuotes: [
        { source: "page_text", quote: "82" },
        { source: "page_text", quote: "129" },
        { source: "page_text", quote: "6" },
      ],
    }],
  }, {
    page_html: '<meta property="og:xhs:note_like" content="82"><meta property="og:xhs:note_collect" content="129"><meta property="og:xhs:note_comment" content="6">',
    page_text: "82 129 6",
  });
  const variation = result.variations[0];
  assert.ok(variation.evidenceQuotes.every(item => !/^[\s\d.,:%+-]+$/.test(item.quote)));
  assert.equal(variation.claimMappings.length, 3);
  assert.ok(variation.claimMappings.every(item => item.evidenceIndexes.length > 0));
});

test("teacher normalization does not guess numeric entity context for structured rows", () => {
  const result = normalizeTeacherResult({
    schema: RESPONSE_SCHEMA,
    sampleId: "core-row",
    variations: [{
      slot: 1,
      outputFormat: "json_array",
      output: '[{"name":"A","count":"20"}]',
      answerMode: "structured_verbatim",
      evidenceQuotes: [
        { source: "page_text", quote: "A" },
        { source: "page_text", quote: "20" },
      ],
    }],
  }, { page_text: "A 数量 20；B 数量 20" });
  assert.ok(result.variations[0].evidenceQuotes.some(item => item.quote === "20"));
});

test("teacher normalization safely wraps a nested_json top-level array", () => {
  const result = normalizeTeacherResult({
    schema: RESPONSE_SCHEMA,
    sampleId: "core-nested",
    variations: [{
      slot: 1,
      outputFormat: "nested_json",
      output: '[{"title":"第一条"}]',
      answerMode: "structured_verbatim",
      evidenceQuotes: [{ source: "page_text", quote: "第一条" }],
    }],
  }, { page_text: "第一条" });
  assert.deepEqual(JSON.parse(result.variations[0].output), { items: [{ title: "第一条" }] });
  assert.deepEqual(result.variations[0].claimMappings, [
    { path: "$/items/0/title", value: "第一条", evidenceIndexes: [0] },
  ]);
});

test("teacher normalization never downgrades ungrounded verbatim values", () => {
  const teacher = {
    schema: RESPONSE_SCHEMA,
    sampleId: "core-derived",
    variations: [{
      slot: 1,
      outputFormat: "json_object",
      output: '{"place":"融咖啡","activity":"喝咖啡"}',
      answerMode: "structured_verbatim",
      negative: false,
      evidenceQuotes: [
        { source: "main_text", quote: "融咖啡" },
        { source: "main_text", quote: "我常去邻家小厨，吃一碗面回家" },
      ],
      derivation: "",
    }],
  };
  const sources = { main_text: "融咖啡；我常去邻家小厨，吃一碗面回家" };
  const strict = normalizeTeacherResult(teacher, sources, { allowDerivedRescue: true });
  assert.equal(strict.variations[0].answerMode, "structured_verbatim");
  assert.equal(strict.variations[0].claimMappings[1].evidenceIndexes.length, 0);
});

test("teacher response validation enforces formats, evidence, URLs, and distinct capabilities", () => {
  const assignedSlots = [
    { slot: 1, outputFormat: "json_array", capabilityHint: "facts" },
    { slot: 2, outputFormat: "markdown", capabilityHint: "section" },
  ];
  const context = {
    sampleId: "core-0001",
    assignedSlots,
    finalUrl: "https://example.com/page",
    allowedUrls: new Set(["https://example.com/page", "https://example.com/detail"]),
    sources: {
      page_text: "页面标题 第一条事实 第二条事实 查看详情",
      main_text: "第一条事实 第二条事实",
      main_markdown: "# 页面标题\n\n第一条事实。第二条事实。\n",
      head_metadata: '{"title":"页面标题"}',
    },
  };
  const valid = {
    schema: RESPONSE_SCHEMA,
    sampleId: "core-0001",
    variations: [
      {
        slot: 1,
        capability: "facts",
        taskType: "fact_list",
        outputFormat: "json_array",
        instruction: "抽取正文中的两条事实，输出 JSON 数组。",
        output: '["第一条事实","第二条事实"]',
        answerMode: "structured_verbatim",
        negative: false,
        scope: "main_content",
        evidenceQuotes: [{ source: "main_text", quote: "第一条事实 第二条事实" }],
        evidenceUrls: [],
        derivation: "保序抽取",
        claimMappings: [
          { path: "$/0", value: "第一条事实", evidenceIndexes: [0] },
          { path: "$/1", value: "第二条事实", evidenceIndexes: [0] },
        ],
        negativeProof: null,
      },
      {
        slot: 2,
        capability: "section",
        taskType: "section_markdown",
        outputFormat: "markdown",
        instruction: "只提取“页面标题”这一节并输出 Markdown。",
        output: "# 页面标题\n\n第一条事实。第二条事实。",
        answerMode: "verbatim",
        negative: false,
        scope: "main_content",
        evidenceQuotes: [
          { source: "main_markdown", quote: "页面标题" },
          { source: "main_markdown", quote: "第一条事实。第二条事实。" },
        ],
        evidenceUrls: ["https://example.com/detail"],
        derivation: "",
        claimMappings: [
          { path: "line[1]", value: "页面标题", evidenceIndexes: [0] },
          { path: "line[3]", value: "第一条事实。第二条事实。", evidenceIndexes: [1] },
        ],
        negativeProof: null,
      },
    ],
  };
  assert.deepEqual(validateTeacherResult(valid, context), []);

  const invalid = structuredClone(valid);
  invalid.variations[0].output = "not json";
  invalid.variations[0].evidenceQuotes[0].quote = "模型编造的事实";
  invalid.variations[1].evidenceUrls = ["https://evil.example/hallucinated"];
  const errors = validateTeacherResult(invalid, context).join("\n");
  assert.match(errors, /json_array parse failed/);
  assert.match(errors, /evidenceQuotes\[0\] quote is not found/);
  assert.match(errors, /URL is not present/);

  const derived = structuredClone(valid);
  derived.variations[0].answerMode = "derived_summary";
  derived.variations[0].claimMappings = [];
  derived.variations[0].derivation = "根据证据归纳";
  derived.variations[0].evidenceQuotes.push({ source: "main_text", quote: "第一条事实" });
  assert.match(validateTeacherResult(derived, context).join("\n"), /disabled for the high-fidelity training pack/);
});

test("CSV parser is RFC-style and site groups never leak across splits", () => {
  assert.deepEqual(parseCsv('name,url\r\n"A, B",https://example.com\r\n'), [
    ["name", "url"],
    ["A, B", "https://example.com"],
  ]);
  assert.throws(() => parseCsv('a,b\n"broken'), /unclosed/);

  const samples = Array.from({ length: 30 }, (_, index) => ({
    id: `core-${String(index + 1).padStart(4, "0")}`,
    siteId: `site-${Math.floor(index / 3)}`,
    finalUrl: `https://site-${Math.floor(index / 3)}.example/${index}`,
  }));
  const result = splitPages(samples);
  assert.equal(Object.keys(result.assignment).filter(key => !key.startsWith("@group:")).length, 30);
  const siteSplits = new Map();
  for (const sample of samples) {
    if (!siteSplits.has(sample.siteId)) siteSplits.set(sample.siteId, new Set());
    siteSplits.get(sample.siteId).add(result.assignment[sample.id]);
  }
  assert.ok([...siteSplits.values()].every(splits => splits.size === 1));
  assert.equal(Object.values(result.counts).reduce((sum, value) => sum + value, 0), 30);
});

test("ZIP is built from the exact artifact allowlist, tested, and accompanied by a digest sidecar", async () => {
  const root = fixture();
  const pack = join(root, "raw_samples");
  mkdirSync(pack);
  const readme = "pack\n";
  writeFileSync(join(pack, "README.md"), readme);
  const artifact = await writeJsonlAtomic(join(pack, "artifact_manifest.jsonl"), [{
    path: "README.md", bytes: Buffer.byteLength(readme), sha256: sha256(readme),
  }]);
  writeFileSync(join(pack, "manifest.json"), `${JSON.stringify({
    schema: "qingzhou.web-extraction-training-pack.v1",
    complete: true,
    artifacts: {
      files: 1,
      bytes: Buffer.byteLength(readme),
      manifest: { bytes: artifact.bytes, sha256: artifact.sha256 },
    },
    files: { "artifact_manifest.jsonl": { bytes: artifact.bytes, sha256: artifact.sha256 } },
  })}\n`);
  const zip = await createZipArtifact(pack, join(root, "pack.zip"));
  assert.equal(zip.entries, 3);
  assert.equal(zip.sha256, sha256(readFileSync(zip.path)));
  const sidecar = JSON.parse(readFileSync(zip.sidecarPath, "utf8"));
  assert.equal(sidecar.sha256, zip.sha256);
  assert.equal(sidecar.entries, 3);

  writeFileSync(join(pack, "stale.tmp"), "partial");
  await assert.rejects(createZipArtifact(pack, join(root, "bad.zip")), /unexpected artifacts|integrity audit/i);
});
