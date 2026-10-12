import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCUMENT_BLOCK_EXAMPLES,
  DOCUMENT_BLOCK_INPUT_SCHEMA,
  DOCUMENT_BLOCK_TYPES,
  DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA,
  DOCUMENT_OUTPUT_FORMATS,
  DOCUMENT_SHEET_INPUT_SCHEMA,
  summarizeDocumentContent,
  validateDirectDocumentCreateInput,
} from "../../src/shared/documents/document-create-input.js";
import { base64ToBytes, buildDocumentHtml, normalizeBlocks, normalizeSheets } from "../../src/capabilities/documents/document-utils.js";
import { createDocumentBytes, parseDocumentBytes } from "../../src/shared/documents/document-codecs.js";

test("document_create exposes one flat discriminated block schema", () => {
  assert.deepEqual(DOCUMENT_OUTPUT_FORMATS, ["docx", "xlsx", "pdf", "html", "txt", "csv"]);
  assert.deepEqual(DOCUMENT_BLOCK_INPUT_SCHEMA.required, ["type"]);
  assert.equal(DOCUMENT_BLOCK_INPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(DOCUMENT_BLOCK_INPUT_SCHEMA.properties.type.enum, DOCUMENT_BLOCK_TYPES);
  assert.equal(DOCUMENT_SHEET_INPUT_SCHEMA.additionalProperties, false);
  assert.equal(DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA.properties.blocks.items, DOCUMENT_BLOCK_INPUT_SCHEMA);
  assert.equal(DOCUMENT_CREATE_CONTENT_INPUT_SCHEMA.properties.sheets.items, DOCUMENT_SHEET_INPUT_SCHEMA);
  assert.deepEqual(Object.keys(DOCUMENT_BLOCK_EXAMPLES), DOCUMENT_BLOCK_TYPES);
  assert.equal(Object.hasOwn(DOCUMENT_BLOCK_INPUT_SCHEMA, "oneOf"), false);
  assert.equal(Object.hasOwn(DOCUMENT_BLOCK_INPUT_SCHEMA, "anyOf"), false);
  const rowDescription = DOCUMENT_SHEET_INPUT_SCHEMA.properties.rows.description;
  assert.match(rowDescription, /rows:\[\{"列名":"值"\},\{"列名":"值"\}\]/);
  assert.match(rowDescription, /rows:\[\["值1","值2"\],\["值3","值4"\]\]/);
  assert.match(rowDescription, /不要把多行再整体包进一个数组/);
});

test("all canonical block kinds and both table row shapes validate", () => {
  const input = {
    blocks: [
      { type: "paragraph", text: "正文" },
      { type: "heading", text: "标题", level: 2 },
      { type: "list", ordered: true, items: ["第一项", { text: "第二项", children: ["子项"] }] },
      {
        type: "table",
        name: "Array rows",
        columns: ["text", "number", "boolean", "empty"],
        rows: [["A", 42, true, null], ["B", -3.5, false, ""]],
        header: false,
      },
      {
        type: "table",
        name: "Object rows",
        columns: ["name", "score"],
        rows: [{ name: "Alice", score: 98 }, { name: "Bob" }],
      },
      { type: "link", text: "来源", url: "https://example.com/report" },
      { type: "image", url: "https://example.com/image.png", alt: "示意图", caption: "图一" },
      { type: "code", language: "javascript", text: "const answer = 42;", startLine: 10, endLine: 10 },
    ],
    sheets: [
      { name: "ArrayData", columns: ["id", "active"], rows: [[1, true], [2, false]], header: false },
      { name: "ObjectData", columns: ["id", "note"], rows: [{ id: 1, note: null }, { id: 2, note: "ok" }] },
    ],
  };
  assert.deepEqual(validateDirectDocumentCreateInput(input), {
    valid: true,
    issueCount: 0,
    issues: [],
    omittedIssueCount: 0,
    invalidFields: [],
  });
});

test("legacy shorthand from the failed PDF conversation is rejected in one bounded result", () => {
  const blocks = [
    ...Array.from({ length: 12 }, (_, index) => ({ heading: `Heading ${index + 1}`, level: index ? 2 : 1 })),
    ...Array.from({ length: 7 }, (_, index) => ({ table: true, columns: ["id"], rows: [[index + 1]] })),
    { list: ["one", "two"] },
    { list: ["three"] },
  ];
  const result = validateDirectDocumentCreateInput({ blocks, sheets: [] });
  assert.equal(result.valid, false);
  assert.equal(result.issueCount, 21);
  assert.equal(result.issues.length, 16);
  assert.equal(result.omittedIssueCount, 5);
  assert.deepEqual(result.invalidFields, ["blocks"]);
  assert.deepEqual(result.issues[0].receivedKeys, ["heading", "level"]);
  assert.equal(result.issues[0].suggestedType, "heading");
  assert.equal(result.issues[12].suggestedType, "table");

  const mixed = validateDirectDocumentCreateInput({
    blocks,
    sheets: [{ name: "Bad/Name", columns: ["id"], rows: [[1]] }],
  });
  assert.deepEqual(mixed.invalidFields, ["blocks", "sheets"], "bounded issue reporting must not hide an invalid source");
});

test("invalid block and sheet variants report stable paths without normalizing away data", () => {
  const result = validateDirectDocumentCreateInput({
    blocks: [
      { type: "unknown", text: "x" },
      { type: "paragraph", content: "wrong field" },
      { type: "heading", text: " ", level: 9 },
      { type: "list", items: ["", { text: "ok", extra: true }] },
      { type: "table", name: "Bad/Name", columns: ["id", "id"], rows: [[1], [2, { nested: true }]] },
      { type: "table", name: "bad/name", columns: ["id"], rows: [[1], { id: 2 }] },
      { type: "link", url: "" },
      { type: "image", url: 42 },
      { type: "code", text: "x", startLine: 5, endLine: 4 },
    ],
    sheets: [],
  });
  assert.equal(result.valid, false);
  const paths = result.issues.map(issue => issue.path);
  assert.ok(paths.includes("blocks[0].type"));
  assert.ok(paths.includes("blocks[1]"));
  assert.ok(paths.includes("blocks[2].text"));
  assert.ok(paths.includes("blocks[2].level"));
  assert.ok(paths.includes("blocks[4].columns[1]"));
  assert.ok(paths.includes("blocks[4].name"));
  assert.ok(paths.includes("blocks[5].name"));
  assert.ok(paths.includes("blocks[5].rows"));
  assert.ok(paths.includes("blocks[8].endLine"));

  const sheetResult = validateDirectDocumentCreateInput({
    blocks: [],
    sheets: [
      { name: "Bad/Name", columns: ["id"], rows: [[1]] },
      { name: "bad/name", columns: ["id"], rows: [[2]] },
    ],
  });
  assert.equal(sheetResult.valid, false);
  const sheetPaths = sheetResult.issues.map(issue => issue.path);
  assert.ok(sheetPaths.includes("sheets[0].name"));
  assert.ok(sheetPaths.includes("sheets[1].name"));
  assert.ok(sheetResult.issues.some(issue => issue.keyword === "unique"));

  const emptyCellResult = validateDirectDocumentCreateInput({
    blocks: [
      { type: "table", rows: [[]] },
      { type: "table", columns: ["value"], rows: [[undefined]] },
    ],
    sheets: [],
  });
  assert.deepEqual(emptyCellResult.issues.map(issue => issue.path), [
    "blocks[0].rows",
    "blocks[1].rows[0][0]",
  ]);
});

test("document content summary preserves the recorded report structure", () => {
  const tableRows = [7, 7, 7, 7, 7, 7, 8];
  const blocks = [
    ...Array.from({ length: 12 }, (_, index) => ({ type: "heading", text: `Heading ${index + 1}`, level: index ? 2 : 1 })),
    ...tableRows.map((count, tableIndex) => ({
      type: "table",
      name: `Table ${tableIndex + 1}`,
      columns: ["id", "value"],
      rows: Array.from({ length: count }, (_, rowIndex) => [rowIndex + 1, `row-${tableIndex + 1}-${rowIndex + 1}`]),
      header: false,
    })),
    { type: "list", items: ["one", "two", "three"] },
    { type: "list", items: ["four", "five", "six", "seven"] },
  ];
  const validation = validateDirectDocumentCreateInput({ blocks, sheets: [] });
  assert.equal(validation.valid, true);
  const normalized = normalizeBlocks(blocks);
  const summary = summarizeDocumentContent({ title: "Report", blocks: normalized, sheets: [] });
  assert.equal(summary.blocks, 21);
  assert.equal(summary.headings, 12);
  assert.equal(summary.tables, 7);
  assert.equal(summary.tableRows, 50);
  assert.equal(summary.lists, 2);
  assert.equal(summary.listItems, 7);
  assert.equal(summary.meaningful, true);
});

test("canonical content survives HTML, TXT, DOCX, XLSX, and CSV creation", async () => {
  const blocks = normalizeBlocks([
    { type: "heading", text: "Formats", level: 1 },
    { type: "paragraph", text: "A < B & C" },
    { type: "list", items: ["Alpha", "Beta"] },
    { type: "table", name: "Scores", columns: ["name", "score"], rows: [["Alice", 98], ["Bob", 87]], header: false },
    { type: "code", language: "js", text: "const x = 1;" },
  ]);

  const html = buildDocumentHtml({ title: "Formats", blocks });
  assert.match(html, /<title>Formats<\/title>/);
  assert.equal(html.match(/<h1>Formats<\/h1>/g)?.length, 1, "metadata title must not duplicate the visible heading");
  assert.match(html, /A &lt; B &amp; C/);
  assert.match(html, /<table>/);
  assert.match(html, /Alice/);

  const txt = new TextDecoder().decode(await createDocumentBytes({ format: "txt", title: "Formats", blocks }));
  assert.match(txt, /# Formats/);
  assert.match(txt, /- Alpha/);
  assert.match(txt, /Alice\t98/);

  const docxBytes = await createDocumentBytes({ format: "docx", title: "Formats", blocks });
  const docxModel = await parseDocumentBytes(docxBytes, { filename: "formats.docx" });
  assert.ok(docxModel.blocks.some(block => block.type === "heading" && block.text === "Formats"));
  assert.ok(docxModel.blocks.some(block => block.type === "table" && block.rows.some(row => row.name === "Alice")));

  const sheets = normalizeSheets([{
    name: "Types",
    columns: ["text", "number", "boolean", "empty"],
    rows: [["A", 42, true, null], ["B", -3.5, false, ""]],
    header: false,
  }]);
  const xlsxBytes = await createDocumentBytes({ format: "xlsx", title: "Types", sheets });
  const xlsxModel = await parseDocumentBytes(xlsxBytes, { filename: "types.xlsx" });
  assert.deepEqual(xlsxModel.sheets[0].rows, [
    { text: "A", number: "42", boolean: "true", empty: "" },
    { text: "B", number: "-3.5", boolean: "false", empty: "" },
  ]);

  const csvBytes = await createDocumentBytes({ format: "csv", title: "Types", sheets: [sheets[0]] });
  const csvModel = await parseDocumentBytes(csvBytes, { filename: "types.csv" });
  assert.deepEqual(csvModel.sheets[0].rows, xlsxModel.sheets[0].rows);
  assert.equal(base64ToBytes(Buffer.from(csvBytes).toString("base64")).length, csvBytes.length);
});

test("document title stays metadata unless a heading block makes it visible", () => {
  const html = buildDocumentHtml({
    title: "Metadata title",
    blocks: [{ type: "paragraph", text: "Body only" }],
  });
  assert.match(html, /<title>Metadata title<\/title>/);
  assert.doesNotMatch(html, /<h1>Metadata title<\/h1>/);
  assert.match(html, /<p>Body only<\/p>/);
});

test("title metadata alone is not treated as document body", () => {
  const summary = summarizeDocumentContent({ title: "Only metadata", blocks: [], sheets: [] });
  assert.equal(summary.titleChars, 13);
  assert.equal(summary.meaningful, false);
});

test("document links and images reject executable or nonportable URL schemes", () => {
  const result = validateDirectDocumentCreateInput({
    blocks: [
      { type: "link", text: "unsafe", url: "javascript:alert(1)" },
      { type: "image", url: "file:///tmp/private.png" },
      { type: "image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
    ],
    sheets: [],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.path), [
    "blocks[0].url",
    "blocks[1].url",
    "blocks[2].url",
  ]);

  assert.equal(validateDirectDocumentCreateInput({
    blocks: [
      { type: "link", text: "source", url: "https://example.com" },
      { type: "link", text: "section", url: "#details" },
      { type: "image", url: "data:image/png;base64,iVBORw0KGgo=" },
    ],
    sheets: [],
  }).valid, true);
});
