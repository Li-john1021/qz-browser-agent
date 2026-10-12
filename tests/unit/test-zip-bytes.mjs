import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { createZipBytes, openZip } from "../../src/shared/zip-bytes.js";
import { createZip, importSkillsZip } from "../../src/shared/skills/skill-package.js";
import { documentCodecs } from "../../src/shared/documents/document-codecs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = text => encoder.encode(text);
const adapters = {
  decode: bytes => decoder.decode(bytes),
  inflate: bytes => new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(),
};
const archive = (data = "hello", name = "你好.txt") => createZipBytes([{ name, data }], encode);
const offsets = bytes => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { view, end: bytes.length - 22, central: view.getUint32(bytes.length - 6, true) };
};
function deflateArchive(data, name) {
  const stored = archive(data, name);
  const { central } = offsets(stored);
  const start = 30 + encode(name).length;
  const compressed = deflateRawSync(typeof data === "string" ? encode(data) : data);
  const result = new Uint8Array(start + compressed.length + stored.length - central);
  result.set(stored.subarray(0, start));
  result.set(compressed, start);
  result.set(stored.subarray(central), start + compressed.length);
  const view = new DataView(result.buffer);
  const directory = start + compressed.length;
  view.setUint16(8, 8, true);
  view.setUint32(18, compressed.length, true);
  view.setUint16(directory + 10, 8, true);
  view.setUint32(directory + 20, compressed.length, true);
  view.setUint32(result.length - 6, directory, true);
  return result;
}

test("ZIP store round trip preserves UTF-8 names and binary bytes with deterministic timestamps", async () => {
  const files = [{ name: "中文/空.txt", data: "" }, { name: "binary", data: new Uint8Array([0, 255, 7]) }];
  const bytes = createZipBytes(files, encode);
  assert.deepEqual(bytes, createZipBytes(files, encode));
  const zip = openZip(bytes, adapters);
  assert.deepEqual(zip.entries.map(entry => entry.name), files.map(file => file.name));
  assert.deepEqual(await zip.read(zip.entries[1], 3), files[1].data);
  assert.equal((await zip.read(zip.entries[0], 0)).length, 0);
  assert.equal(openZip(createZipBytes([], encode), adapters).entries.length, 0);
  const dated = createZipBytes(files, encode, new Date(2025, 3, 12));
  assert.notDeepEqual(dated, bytes);
  await assert.rejects(openZip(dated, adapters).read(zip.entries[0], 0), /不属于此归档/);
});

test("central and local bounds, names, methods, output sizes and CRC are checked", async () => {
  for (const mutate of [
    bytes => bytes.subarray(0, 16),
    bytes => { offsets(bytes).view.setUint32(bytes.length - 6, 0xffffffff, true); return bytes; },
    bytes => { const { view, central } = offsets(bytes); view.setUint16(central + 28, 65535, true); return bytes; },
    bytes => { const { view, end } = offsets(bytes); view.setUint16(end + 8, 2, true); return bytes; },
  ]) assert.throws(() => openZip(mutate(archive()), adapters), /zip/i);
  const cases = [
    [bytes => { bytes[0] = 0; }, /目录损坏/],
    [bytes => { bytes[30] = 0; }, /文件名校验失败/],
    [bytes => { const { view, central } = offsets(bytes); view.setUint32(central + 20, bytes.length, true); }, /数据损坏/],
    [bytes => { const { view, central } = offsets(bytes); view.setUint32(central + 24, 6, true); }, /大小校验失败/],
    [bytes => { const { view, central } = offsets(bytes); view.setUint32(central + 16, 0, true); }, /内容校验失败/],
    [bytes => { const { view, central } = offsets(bytes); view.setUint16(8, 99, true); view.setUint16(central + 10, 99, true); }, /压缩方式/],
    [bytes => { const { view, central } = offsets(bytes); view.setUint16(6, 1, true); view.setUint16(central + 8, 1, true); }, /不受支持/],
  ];
  for (const [mutate, expected] of cases) {
    const bytes = archive(); mutate(bytes);
    const zip = openZip(bytes, adapters);
    await assert.rejects(zip.read(zip.entries[0], 100), expected);
  }
});

test("deflate reads bounded bytes and refuses archive and file budget overflow", async () => {
  const bytes = deflateArchive("hello hello hello", "data.txt");
  const zip = openZip(bytes, adapters);
  assert.equal(decoder.decode(await zip.read(zip.entries[0], 100)), "hello hello hello");
  const unsupported = openZip(bytes, { decode: adapters.decode });
  await assert.rejects(unsupported.read(unsupported.entries[0], 100), /升级浏览器/);
  assert.throws(() => openZip(bytes, { ...adapters, maxArchiveBytes: 10 }), /包过大/);
  assert.throws(() => openZip(bytes, { ...adapters, maxEntries: 0 }), /数量过多/);
  await assert.rejects(zip.read(zip.entries[0], 5), /文件过大/);
  offsets(bytes).view.setUint32(offsets(bytes).central + 24, 5, true);
  const dishonest = openZip(bytes, adapters);
  await assert.rejects(dishonest.read(dishonest.entries[0], 5), /解压后文件过大/);
});

test("cancellation during a pending inflate closes the reader and prevents late output", async () => {
  const controller = new AbortController();
  let cancelled = 0, released = 0, finish;
  const bytes = deflateArchive("hello", "data.txt");
  const zip = openZip(bytes, { ...adapters, signal: controller.signal, inflate: () => ({
    read: () => new Promise(resolve => { finish = resolve; }),
    cancel: async () => { cancelled++; finish?.({ done: true }); },
    releaseLock: () => { released++; },
  }) });
  const pending = zip.read(zip.entries[0], 100);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(cancelled >= 1);
  assert.equal(released, 1);
  assert.throws(() => openZip(bytes, { ...adapters, signal: controller.signal }), { name: "AbortError" });
});

test("a lying decompressor is cancelled when it exceeds the byte budget", async () => {
  let cancelled = 0, released = 0;
  const bytes = deflateArchive("hello", "data.txt");
  const zip = openZip(bytes, { ...adapters, inflate: () => ({
    read: async () => ({ done: false, value: new Uint8Array(20) }),
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; },
  }) });
  await assert.rejects(zip.read(zip.entries[0], 5), /文件过大/);
  assert.equal(cancelled, 1); assert.equal(released, 1);
});

test("Skill and document adapters read compressed resources and preserve their own models", async () => {
  const markdown = "---\nname: zipped\ndescription: ZIP test.\n---\n# Test";
  const skillBytes = deflateArchive(markdown, "skills/zipped/SKILL.md");
  assert.equal((await importSkillsZip(skillBytes.buffer))[0].name, "zipped");
  const documentBytes = deflateArchive('<w:document><w:body><w:p><w:r><w:t>Compressed 你好</w:t></w:r></w:p></w:body></w:document>', "word/document.xml");
  assert.equal((await documentCodecs.parse(documentBytes, { filename: "test.docx" })).blocks[0].text, "Compressed 你好");
  for (const format of ["docx", "xlsx"]) {
    const content = { title: "ZIP roundtrip", blocks: [{ type: "paragraph", text: "hello" }], sheets: [{ name: "data", columns: ["value"], rows: [{ value: "你好" }] }] };
    const generated = await documentCodecs.encode({ format, ...content });
    const parsed = await documentCodecs.parse(generated, { filename: `test.${format}` });
    assert.equal(parsed.type, format);
    if (format === "xlsx") assert.equal(parsed.sheets[0].rows[0].value, "你好");
  }
  const controller = new AbortController(); controller.abort();
  const stored = await createZip([{ path: "zipped/SKILL.md", content: markdown }]);
  await assert.rejects(importSkillsZip(await stored.arrayBuffer(), { signal: controller.signal }), { name: "AbortError" });
});

test("ZIP comments and data descriptors remain valid while embedded signatures are ignored", async () => {
  const bytes = deflateArchive("descriptor", "data.txt");
  const { view, central } = offsets(bytes);
  view.setUint16(6, 0x808, true);
  view.setUint16(central + 8, 0x808, true);
  view.setUint32(14, 0, true);
  view.setUint32(18, 0, true);
  view.setUint32(22, 0, true);
  const descriptor = new Uint8Array(16);
  const descriptorView = new DataView(descriptor.buffer);
  descriptorView.setUint32(0, 0x08074b50, true);
  descriptorView.setUint32(4, view.getUint32(central + 16, true), true);
  descriptorView.setUint32(8, view.getUint32(central + 20, true), true);
  descriptorView.setUint32(12, view.getUint32(central + 24, true), true);
  const comment = new Uint8Array(40);
  new DataView(comment.buffer).setUint32(0, 0x06054b50, true);
  const output = new Uint8Array(bytes.length + descriptor.length + comment.length);
  output.set(bytes.subarray(0, central)); output.set(descriptor, central);
  output.set(bytes.subarray(central), central + descriptor.length);
  output.set(comment, bytes.length + descriptor.length);
  const end = bytes.length + descriptor.length - 22;
  const outputView = new DataView(output.buffer);
  outputView.setUint32(end + 16, central + descriptor.length, true);
  outputView.setUint16(end + 20, comment.length, true);
  const zip = openZip(output, adapters);
  assert.equal(decoder.decode(await zip.read(zip.entries[0], 100)), "descriptor");
});
