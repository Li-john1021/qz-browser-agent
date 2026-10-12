import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentCodecs, BUILTIN_DOCUMENT_CODECS, documentCodecs } from "../../src/shared/documents/document-codecs.js";
import { createJsonDocumentCodec } from "../fixtures/capabilities/example/json-document-codec.js";
import { DOCUMENT_OUTPUT_FORMATS } from "../../src/shared/documents/document-create-input.js";

const bytes = new TextEncoder().encode('{"text":"Hello 你好"}');
const model = { type: "txt", title: "test", blocks: [{ type: "paragraph", text: "Hello" }], sheets: [], chunks: [], outline: [], warnings: [] };
const codec = { id: "custom", mimeType: "application/x-custom", matches: input => input.extension === "custom", parse: () => model };

test("pure output metadata matches statically bound encoder capabilities", () => {
  assert.deepEqual(DOCUMENT_OUTPUT_FORMATS, documentCodecs.outputFormats);
  assert.deepEqual(DOCUMENT_OUTPUT_FORMATS, BUILTIN_DOCUMENT_CODECS.filter(codec => codec.encode).map(codec => codec.id));
});

test("a new parser composes with built-ins and preserves the shared document model", async () => {
  const registry = createDocumentCodecs([...BUILTIN_DOCUMENT_CODECS, createJsonDocumentCodec(bytes => new TextDecoder().decode(bytes))]);
  const parsed = await registry.parse(bytes, { filename: "note.qznote" });
  assert.equal(parsed.blocks[0].text, "Hello 你好");
  assert.equal(parsed.chunkSize, 6000);
  assert.equal(registry.inferFormat({ mimeType: "application/vnd.qingzhou.note+json" }), "json-note");
  assert.equal(registry.mimeType("json-note"), "application/vnd.qingzhou.note+json");
  assert.equal(registry.outputFormats.includes("json-note"), false, "a parser-only codec cannot become an output format");
  assert.deepEqual(registry.outputFormats, ["docx", "xlsx", "pdf", "html", "txt", "csv"]);
  const output = await registry.encode({ format: "html", ...parsed });
  assert.match(new TextDecoder().decode(output), /Hello/);
});

test("matching priority and replacement are explicit; duplicate IDs never silently replace a format", async () => {
  assert.throws(() => createDocumentCodecs([codec, codec]), /Duplicate/);
  assert.throws(() => createDocumentCodecs([{ ...codec, replaces: "missing" }]), /replacement/);
  const registry = createDocumentCodecs([codec,
    { ...codec, id: "preferred", priority: 10, parse: () => ({ ...model, title: "preferred" }) },
    { ...codec, replaces: "custom", parse: () => ({ ...model, title: "replaced" }) },
  ]);
  assert.equal((await registry.parse(bytes, { filename: "x.custom" })).title, "preferred");
  assert.equal((await createDocumentCodecs([codec, { ...codec, replaces: "custom", parse: () => ({ ...model, title: "replaced" }) }]).parse(bytes, { filename: "x.custom" })).title, "replaced");
});

test("cancellation is prompt even when a parser ignores the signal and late results never escape", async () => {
  let resolve, started;
  const ready = new Promise(value => { started = value; });
  const pending = new Promise(value => { resolve = value; });
  let sourceSignal;
  const registry = createDocumentCodecs([{ ...codec, parse: (_bytes, options) => { sourceSignal = options.signal; started(); return pending; } }]);
  const controller = new AbortController();
  const result = registry.parse(bytes, { filename: "x.custom", signal: controller.signal });
  await ready;
  controller.abort("cancelled by user");
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(sourceSignal.aborted, true);
  resolve(model);
  await assert.rejects(registry.parse(bytes, { filename: "x.custom", signal: controller.signal }), { name: "AbortError" });
});

test("input budgets, malformed models and invalid encoder results fail at the codec boundary", async () => {
  const registry = createDocumentCodecs([codec]);
  await assert.rejects(registry.parse(bytes, { filename: "x.custom", maxBytes: 1 }), { code: "DOCUMENT_SIZE_LIMIT" });
  await assert.rejects(registry.parse("not bytes", { filename: "x.custom" }), { code: "DOCUMENT_BYTES_INVALID" });
  await assert.rejects(createDocumentCodecs([{ ...codec, parse: () => ({ type: "txt" }) }]).parse(bytes, { filename: "x.custom" }), { code: "DOCUMENT_CODEC_INVALID_RESULT" });
  await assert.rejects(createDocumentCodecs([{ ...codec, encode: () => "not bytes" }]).encode({ format: "custom" }), { code: "DOCUMENT_CODEC_INVALID_RESULT" });
  assert.equal((await documentCodecs.encode({ format: "txt" })).byteLength, 0, "empty text remains a valid byte encoding");
});

test("PDF export uses only the injected host printer and forwards cancellation", async () => {
  await assert.rejects(documentCodecs.encode({ format: "pdf", ...model }), { code: "DOCUMENT_PRINT_UNAVAILABLE" });
  const signal = new AbortController().signal;
  const pdf = new TextEncoder().encode("%PDF-1.7\nexample");
  let received;
  assert.deepEqual(await documentCodecs.encode({ format: "pdf", ...model }, { signal, printPdf: async (content, value) => {
    received = [content, value]; return pdf;
  } }), pdf);
  assert.equal(received[0].title, model.title);
  assert.equal(received[1], signal);
});

test("built-in MIME and filename precedence remains compatible", () => {
  for (const [input, expected] of [
    [{ filename: "report.docx", mimeType: "application/pdf" }, "docx"],
    [{ filename: "table.csv", mimeType: "text/plain" }, "csv"],
    [{ filename: "index.HTML?download=1" }, "html"],
    [{ filename: "Dockerfile" }, "txt"],
    [{ filename: "code.py" }, "txt"],
    [{ filename: "binary.unknown", mimeType: "application/octet-stream" }, ""],
  ]) assert.equal(documentCodecs.inferFormat(input), expected);
});


test("PDF parser releases an aborted load and a later parse still succeeds", { timeout: 5000 }, async () => {
  const { parsePdfToModel } = await import("../../src/capabilities/documents/document-utils.js");
  // A complete one-page PDF exercises the real PDF.js task, rather than its fallback reader.
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 12 Tf 72 720 Td (A complete PDF remains readable after cancellation.) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = source.length;
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const bytes = () => new TextEncoder().encode(source);
  await assert.rejects(parsePdfToModel(bytes(), { signal: AbortSignal.abort() }), { name: "AbortError" });
  const controller = new AbortController();
  let listeners = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { listeners++; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { listeners--; controller.signal.removeEventListener(...args); },
  };
  const pending = parsePdfToModel(bytes(), { signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(listeners, 0, "cancelled parser must release its listener");
  const parsed = await parsePdfToModel(bytes());
  assert.equal(parsed.parser, "pdfjs");
  assert.deepEqual(parsed.warnings, []);
  assert.match(parsed.blocks.map(block => block.text).join(" "), /readable after cancellation/);
});
