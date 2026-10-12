import assert from "node:assert/strict";
import test from "node:test";

import { createSkillDocumentResourceService } from "../../src/background/skills/skill-document-resources.js";
import { createDocumentBytes } from "../../src/shared/documents/document-codecs.js";
import { encodeSkillResourceBytes } from "../../src/shared/skills/skill-utils.js";

function documentResource(path, bytes) {
  return {
    path,
    type: "asset",
    encoding: "base64",
    size: bytes.byteLength,
    content: encodeSkillResourceBytes(bytes),
  };
}

function createHarness(options = {}) {
  const files = [];
  const models = new Map();
  const parses = [];
  const service = createSkillDocumentResourceService({
    async getModel(id) { return models.get(id) || null; },
    async saveFile(file) {
      files.push(file);
      return { fileId: file.id };
    },
    async saveModel(model) {
      models.set(model.id, { ...model });
      return { docModelId: model.id };
    },
    async parseBytes(_bytes, { filename }) {
      parses.push(filename);
      if (filename.endsWith(".xlsx")) {
        return {
          type: "xlsx",
          title: "Workbook",
          blocks: [],
          chunks: [],
          outline: [],
          warnings: [],
          sheets: [
            { name: "Apps", columns: ["name", "status"], rows: [{ name: "A", status: "ok" }] },
            { name: "Owners", columns: ["name"], rows: [{ name: "Qingzhou" }] },
          ],
        };
      }
      const type = filename.endsWith(".pdf") ? "pdf" : "docx";
      const blocks = [
        { type: "heading", level: 1, text: `${type} title` },
        { type: "paragraph", text: type === "docx" ? `${type} body ${"x".repeat(1100)}` : `${type} body` },
      ];
      return {
        type,
        title: `${type} title`,
        chunkSize: 1000,
        blocks,
        sheets: [],
        chunks: type === "docx"
          ? [
              { chunkIndex: 0, startBlock: 0, endBlock: 0, chars: 10 },
              { chunkIndex: 1, startBlock: 1, endBlock: 1, chars: 9 },
            ]
          : [{ chunkIndex: 0, startBlock: 0, endBlock: 1, chars: 19 }],
        outline: [{ level: 1, text: `${type} title`, blockIndex: 0 }],
        warnings: [],
      };
    },
    ...options,
  });
  return { service, files, models, parses };
}

test("Skill DOCX/PDF resources use the document model pipeline and reuse the cached model", async () => {
  const harness = createHarness();
  const context = { sessionId: "session-docs", runId: "run-1", toolCallId: "tool-1" };
  const docx = documentResource("references/guide.docx", new Uint8Array([0x50, 0x4b, 1, 2]));
  const first = await harness.service.load({
    skill: { name: "office-skill", displayName: "Office Skill" },
    resource: docx,
  }, { context });

  assert.equal(first.format, "docx");
  assert.match(first.content, /docx title/);
  assert.equal(first.contentFormat, "markdown");
  assert.equal(Object.hasOwn(first, "blocks"), false);
  assert.equal(first.document.docModelId.startsWith("model_skill_"), true);
  assert.equal(first.next.loadSkill, "qingzhou-documents");
  assert.equal(first.next.tool, "qingzhou_documents__document_read_chunk");
  assert.deepEqual(first.next.args, { docModelId: first.document.docModelId, chunkIndex: 1 });
  assert.equal(harness.files[0].sourceTool, "load_skill_resource");
  assert.equal(harness.files[0].sessionId, "session-docs");

  const cached = await harness.service.load({ skill: { name: "office-skill" }, resource: docx }, { context });
  assert.equal(cached.document.docModelId, first.document.docModelId);
  assert.deepEqual(harness.parses, ["references/guide.docx"]);

  const otherSession = await harness.service.load(
    { skill: { name: "office-skill" }, resource: docx },
    { context: { sessionId: "session-docs-2", runId: "run-1" } },
  );
  assert.notEqual(otherSession.document.docModelId, first.document.docModelId);
  assert.equal(harness.files[1].sessionId, "session-docs-2");

  const pdf = await harness.service.load({
    skill: { name: "office-skill" },
    resource: documentResource("references/manual.pdf", new TextEncoder().encode("%PDF fixture")),
  }, { context });
  assert.equal(pdf.format, "pdf");
  assert.match(pdf.content, /pdf body/);
  assert.equal(Object.hasOwn(pdf, "next"), false);
});

test("Skill XLSX resources return a structured first-sheet preview and the next sheet cursor", async () => {
  const harness = createHarness();
  const result = await harness.service.load({
    skill: { name: "sheet-skill" },
    resource: documentResource("references/apps.xlsx", new Uint8Array([0x50, 0x4b, 3, 4])),
  }, { context: { sessionId: "session-sheets" } });

  assert.equal(result.format, "xlsx");
  assert.equal(result.sheetName, "Apps");
  assert.equal(result.tableId, "sheet:0");
  assert.equal(result.contentFormat, "tsv");
  assert.deepEqual(result.columns, ["name", "status"]);
  assert.deepEqual(result.rows, [{ name: "A", status: "ok" }]);
  assert.match(result.content, /name\tstatus/);
  assert.deepEqual(result.next.args, {
    docModelId: result.document.docModelId,
    sheetName: "Owners",
    offset: 0,
    limit: 50,
  });
});

test("Skill document continuation follows the registered reader and handles its absence", async () => {
  const requests = [];
  const harness = createHarness({
    resolveSkillTool(name) {
      requests.push(name);
      return { skillName: "custom-reader", toolName: "custom_reader__next" };
    },
  });
  const input = {
    skill: { name: "office-skill" },
    resource: documentResource("references/guide.docx", new Uint8Array([0x50, 0x4b, 1, 2])),
  };
  const runtime = { context: { sessionId: "session-reader" } };
  const result = await harness.service.load(input, runtime);
  assert.deepEqual(requests, ["document_read_chunk"]);
  assert.deepEqual(result.next, {
    loadSkill: "custom-reader",
    tool: "custom_reader__next",
    args: { docModelId: result.document.docModelId, chunkIndex: 1 },
  });
  assert.match(result.note, /custom-reader.*custom_reader__next/);

  const withoutReader = createHarness({ resolveSkillTool: () => null });
  const unavailable = await withoutReader.service.load(input, runtime);
  assert.equal(unavailable.truncated, true);
  assert.equal(Object.hasOwn(unavailable, "next"), false);
  assert.equal(unavailable.document.docModelId, result.document.docModelId);
  assert.equal(unavailable.content, result.content);
  assert.equal(withoutReader.models.size, 1);
  assert.match(unavailable.note, /没有提供分页阅读/);
});

test("Skill document loading preserves cancellation and rejects malformed binary data", async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => harness.service.load({
      skill: { name: "cancelled" },
      resource: documentResource("references/cancelled.pdf", new Uint8Array([1])),
    }, { signal: controller.signal }),
    error => error?.code === "OPERATION_ABORTED",
  );
  const midParseController = new AbortController();
  const persistedAfterAbort = [];
  const midParseService = createSkillDocumentResourceService({
    async getModel() { return null; },
    async parseBytes() {
      midParseController.abort();
      return {
        type: "pdf",
        title: "Cancelled",
        blocks: [{ type: "paragraph", text: "late" }],
        sheets: [],
        chunks: [{ chunkIndex: 0, startBlock: 0, endBlock: 0, chars: 4 }],
        outline: [],
        warnings: [],
      };
    },
    async saveFile(file) { persistedAfterAbort.push(file); },
    async saveModel(model) { persistedAfterAbort.push(model); },
  });
  await assert.rejects(
    () => midParseService.load({
      skill: { name: "cancelled-during-parse" },
      resource: documentResource("references/cancelled-during-parse.pdf", new Uint8Array([1])),
    }, {
      signal: midParseController.signal,
      context: { sessionId: "session-cancelled-during-parse" },
    }),
    error => error?.code === "OPERATION_ABORTED",
  );
  assert.deepEqual(persistedAfterAbort, []);
  await assert.rejects(
    () => harness.service.load({
      skill: { name: "unowned" },
      resource: documentResource("references/unowned.pdf", new Uint8Array([1])),
    }),
    error => error?.code === "SKILL_DOCUMENT_SESSION_REQUIRED",
  );
  await assert.rejects(
    () => harness.service.load({
      skill: { name: "invalid" },
      resource: { path: "references/invalid.pdf", encoding: "base64", content: "%%%" },
    }, { context: { sessionId: "session-invalid" } }),
    error => error?.code === "SKILL_DOCUMENT_BINARY_INVALID",
  );
  assert.deepEqual(harness.parses, []);
});

test("bundled DOCX, XLSX and PDF bytes are accepted by the real document parsers", async () => {
  const models = new Map();
  const service = createSkillDocumentResourceService({
    async getModel(id) { return models.get(id) || null; },
    async saveFile(file) { return { fileId: file.id }; },
    async saveModel(model) {
      models.set(model.id, { ...model });
      return { docModelId: model.id };
    },
  });
  const docxBytes = await createDocumentBytes({
    format: "docx",
    title: "Bundled guide",
    blocks: [{ type: "paragraph", text: "Read the bundled Word instructions." }],
  });
  const xlsxBytes = await createDocumentBytes({
    format: "xlsx",
    title: "Bundled workbook",
    sheets: [{ name: "Data", columns: ["name"], rows: [{ name: "Qingzhou" }] }],
  });
  const pdfBytes = new TextEncoder().encode("%PDF-1.4\n/Type /Page\n(Bundled PDF reference content is readable.) Tj\n%%EOF");

  const originalWarn = console.warn;
  console.warn = () => {};
  let docx;
  let xlsx;
  let pdf;
  try {
    [docx, xlsx, pdf] = await Promise.all([
      service.load(
        { skill: { name: "real-docs" }, resource: documentResource("references/guide.docx", docxBytes) },
        { context: { sessionId: "session-real-docx" } },
      ),
      service.load(
        { skill: { name: "real-docs" }, resource: documentResource("references/data.xlsx", xlsxBytes) },
        { context: { sessionId: "session-real-xlsx" } },
      ),
      service.load(
        { skill: { name: "real-docs" }, resource: documentResource("references/manual.pdf", pdfBytes) },
        { context: { sessionId: "session-real-pdf" } },
      ),
    ]);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(docx.content, /Word instructions/);
  assert.deepEqual(xlsx.rows, [{ name: "Qingzhou" }]);
  assert.match(pdf.content, /Bundled PDF reference content/);
});
