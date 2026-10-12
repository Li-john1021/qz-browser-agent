import assert from "node:assert/strict";
import test from "node:test";

import {
  DocumentReadProjectionError,
  buildDocumentContentChunks,
  projectDocumentRead,
} from "../../src/shared/documents/document-read-projection.js";
import { createDocumentBytes, parseDocumentBytes } from "../../src/shared/documents/document-codecs.js";

test("narrative reads return one Markdown projection without duplicating blocks", () => {
  const model = {
    id: "model-narrative",
    type: "docx",
    title: "Guide",
    chunkSize: 6000,
    sheets: [],
    blocks: [
      { type: "heading", level: 1, text: "Guide" },
      { type: "paragraph", text: "Use *literal* <markup> safely." },
      { type: "list", ordered: false, items: [{ text: "First", children: [{ text: "Nested" }] }] },
      { type: "code", language: "js", text: "const answer = 42;" },
      { type: "link", text: "Reference", url: "https://example.test/a b" },
      {
        type: "table",
        name: "Scores",
        columns: ["name", "score"],
        rows: [{ name: "hidden-row-value", score: 10 }],
      },
    ],
  };

  const result = projectDocumentRead(model, { chunkIndex: 0 });
  assert.equal(result.mode, "content");
  assert.equal(result.contentFormat, "markdown");
  assert.match(result.content, /^# Guide/m);
  assert.match(result.content, /\\\*literal\\\*/);
  assert.match(result.content, /&lt;markup&gt;/);
  assert.match(result.content, /- First\n  - Nested/);
  assert.match(result.content, /```js\nconst answer = 42;\n```/);
  assert.match(result.content, /\[Reference\]\(<https:\/\/example\.test\/a%20b>\)/);
  assert.match(result.content, /`table:5`/);
  assert.doesNotMatch(result.content, /hidden-row-value/);
  assert.deepEqual(result.tables, [{
    tableId: "table:5",
    name: "Scores",
    columns: ["name", "score"],
    columnCount: 2,
    totalRows: 1,
  }]);
  assert.equal(Object.hasOwn(result, "blocks"), false);
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("oversized paragraphs and code are split into stable bounded chunks", () => {
  const blocks = [
    { type: "paragraph", text: "A".repeat(2300) },
    { type: "code", language: "txt", text: "B".repeat(1700) },
  ];
  const chunks = buildDocumentContentChunks(blocks, { chunkSize: 1000 });
  assert.ok(chunks.length >= 5);
  assert.ok(chunks.every(chunk => chunk.content.length <= 1000));
  assert.equal(chunks.map(chunk => chunk.index).join(","), chunks.map((_, index) => index).join(","));
  assert.equal(chunks.map(chunk => chunk.content).join("").replace(/```txt|```/g, "").replace(/\s/g, ""), `${"A".repeat(2300)}${"B".repeat(1700)}`);

  const legacyModel = {
    id: "legacy-model",
    type: "txt",
    title: "Legacy",
    blocks: [{ type: "paragraph", text: "C".repeat(2500) }],
    chunks: [{ chunkIndex: 0, startBlock: 0, endBlock: 0, chars: 2500 }],
    chunkSize: 1000,
  };
  const first = projectDocumentRead(legacyModel, { chunkIndex: 0 });
  const second = projectDocumentRead(legacyModel, first.next);
  assert.equal(first.chunk.total, 3);
  assert.equal(second.chunk.index, 1);
  assert.ok(first.content.length <= 1000 && second.content.length <= 1000);
});

test("large Word tables stay out of narrative chunks and page losslessly", () => {
  const rows = Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 1),
    value: `row-${index + 1}`,
  }));
  const model = {
    id: "model-table",
    type: "docx",
    title: "Large table",
    chunkSize: 1200,
    sheets: [],
    blocks: [
      { type: "paragraph", text: "Before table." },
      { type: "table", name: "Rows", columns: ["id", "value"], rows },
      { type: "paragraph", text: "After table." },
    ],
  };
  const narrative = projectDocumentRead(model, { chunkIndex: 0 });
  assert.match(narrative.content, /table:1/);
  assert.doesNotMatch(narrative.content, /row-500/);
  assert.ok(JSON.stringify(narrative).length < 5000);

  const collected = [];
  let query = { tableId: "table:1", offset: 0, limit: 37 };
  while (query) {
    const page = projectDocumentRead(model, query);
    assert.equal(page.mode, "table");
    assert.equal(Object.hasOwn(page, "content"), false);
    assert.equal(Object.hasOwn(page, "blocks"), false);
    collected.push(...page.rows);
    query = page.next || null;
  }
  assert.deepEqual(collected, rows);
});

test("XLSX defaults to its first sheet, supports legacy sheetName, and ignores mirrored blocks", () => {
  const model = {
    id: "model-sheet",
    type: "xlsx",
    title: "Workbook",
    sheets: [
      { name: "Apps", columns: ["name"], rows: [{ name: "A" }, { name: "B" }] },
      { name: "Owners", columns: ["owner"], rows: [{ owner: "Qingzhou" }] },
    ],
    blocks: [
      { type: "heading", level: 2, text: "Apps" },
      { type: "table", columns: ["name"], rows: [{ name: "duplicated" }] },
    ],
  };
  const first = projectDocumentRead(model, {});
  assert.equal(first.mode, "table");
  assert.equal(first.tableId, "sheet:0");
  assert.equal(first.sheetName, "Apps");
  assert.deepEqual(first.rows, [{ name: "A" }, { name: "B" }]);

  const owners = projectDocumentRead(model, { sheetName: "owners" });
  assert.equal(owners.tableId, "sheet:1");
  assert.deepEqual(owners.rows, [{ owner: "Qingzhou" }]);
});

test("table pages shrink to the result budget without losing the continuation cursor", () => {
  const payload = "x".repeat(12000);
  const model = {
    id: "model-budget",
    type: "xlsx",
    title: "Budget",
    blocks: [],
    sheets: [{
      name: "Data",
      columns: ["value"],
      rows: Array.from({ length: 50 }, (_, index) => ({ value: `${index}:${payload}` })),
    }],
  };
  const first = projectDocumentRead(model, { limit: 50 });
  assert.ok(first.rows.length > 0 && first.rows.length < 50);
  assert.ok(JSON.stringify(first).length < 130000);
  assert.deepEqual(first.next, { tableId: "sheet:0", offset: first.rows.length, limit: 50 });
  const second = projectDocumentRead(model, first.next);
  assert.equal(second.offset, first.rows.length);
});

test("invalid chunk and table cursors fail explicitly instead of repeating the first page", () => {
  const model = {
    id: "model-errors",
    type: "docx",
    title: "Errors",
    chunkSize: 1000,
    blocks: [{ type: "paragraph", text: "hello" }],
    sheets: [],
  };
  assert.throws(
    () => projectDocumentRead(model, { chunkIndex: 9 }),
    error => error instanceof DocumentReadProjectionError && error.code === "DOCUMENT_CHUNK_NOT_FOUND",
  );
  assert.throws(
    () => projectDocumentRead(model, { tableId: "table:9" }),
    error => error instanceof DocumentReadProjectionError && error.code === "DOCUMENT_TABLE_NOT_FOUND",
  );
  assert.throws(
    () => projectDocumentRead(model, { sheetName: "missing" }),
    error => error instanceof DocumentReadProjectionError && error.code === "DOCUMENT_SHEET_NOT_FOUND",
  );
});

test("CSV/XLSX parsing keeps tables structured and makes duplicate headers addressable", async () => {
  const csv = await parseDocumentBytes(
    new TextEncoder().encode("name,name,\nA,B,C\n"),
    { filename: "duplicates.csv", chunkSize: 999999 },
  );
  assert.equal(csv.chunkSize, 50000);
  assert.deepEqual(csv.blocks, []);
  assert.deepEqual(csv.sheets[0].columns, ["name", "name 2", "Column 3"]);
  assert.deepEqual(csv.sheets[0].rows, [{ name: "A", "name 2": "B", "Column 3": "C" }]);

  const xlsxBytes = await createDocumentBytes({
    format: "xlsx",
    title: "Roundtrip",
    sheets: [{ name: "Data", columns: ["name", "name", ""], rows: [["A", "B", "C"]] }],
  });
  const xlsx = await parseDocumentBytes(xlsxBytes, { filename: "roundtrip.xlsx" });
  assert.deepEqual(xlsx.blocks, []);
  assert.deepEqual(xlsx.sheets[0].columns, ["name", "name 2", "Column 3"]);
  assert.deepEqual(projectDocumentRead({ id: "roundtrip", ...xlsx }, {}).rows, [{ name: "A", "name 2": "B", "Column 3": "C" }]);
});

test("format conversion continues from the full docModel rather than the Markdown read projection", async () => {
  const docxBytes = await createDocumentBytes({
    format: "docx",
    title: "Conversion source",
    blocks: [
      { type: "heading", level: 1, text: "Conversion source" },
      { type: "paragraph", text: "Structured body" },
      { type: "table", columns: ["name", "value"], rows: [{ name: "preserved-row", value: "42" }] },
    ],
  });
  const docxModel = await parseDocumentBytes(docxBytes, { filename: "source.docx" });
  const modelBeforeRead = JSON.stringify(docxModel);
  const read = projectDocumentRead({ id: "conversion-docx", ...docxModel }, { chunkIndex: 0 });
  assert.doesNotMatch(read.content, /preserved-row/, "table rows should stay out of the Agent read projection");
  assert.equal(JSON.stringify(docxModel), modelBeforeRead, "reading must not mutate the conversion source");

  const htmlBytes = await createDocumentBytes({
    format: "html",
    title: docxModel.title,
    blocks: docxModel.blocks,
    sheets: docxModel.sheets,
  });
  const html = new TextDecoder().decode(htmlBytes);
  assert.match(html, /Structured body/);
  assert.match(html, /preserved-row/);
  assert.match(html, /<table>/);

  const pdfBytes = new TextEncoder().encode("%PDF-1.4\n/Type /Page\n(PDF conversion body remains available.) Tj\n%%EOF");
  const originalWarn = console.warn;
  console.warn = () => {};
  let pdfModel;
  try {
    pdfModel = await parseDocumentBytes(pdfBytes, { filename: "source.pdf" });
  } finally {
    console.warn = originalWarn;
  }
  const convertedDocx = await createDocumentBytes({
    format: "docx",
    title: pdfModel.title,
    blocks: pdfModel.blocks,
    sheets: pdfModel.sheets,
  });
  const reparsedDocx = await parseDocumentBytes(convertedDocx, { filename: "converted.docx" });
  const convertedRead = projectDocumentRead({ id: "converted-docx", ...reparsedDocx }, { chunkIndex: 0 });
  assert.match(convertedRead.content, /PDF conversion body remains available/);
});
