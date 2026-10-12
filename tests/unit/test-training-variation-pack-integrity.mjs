import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertRecordRevalidationPreconditions,
  auditExactArtifactSet,
  auditPageGroupSplits,
  auditPersistedTrainingArtifacts,
  auditT0ExactBytes,
  auditTaskInventory,
  canonicalJson,
  createRecordIntegrity,
  enumerateArtifactManifest,
  readJsonlRows,
  replaceDirectoryFromStaging,
  sha256,
  validateRecordRevalidationPreconditions,
  writeJsonlAtomic,
} from "../benchmarks/article-extraction/training-variation-pack-integrity.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qz-pack-integrity-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("canonical record seal detects result, identity field, and source tampering", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, "x"] }), '{"a":[true,"x"],"z":1}');
  const identityFields = { sampleId: "core-0001", model: "deepseek-v4-flash", assignedSlots: [1, 2] };
  const result = { variations: [{ slot: 1 }, { slot: 2 }] };
  const sources = { rawHtml: Buffer.from("<html>A</html>"), goldMarkdown: "# A\n", allowedUrls: ["https://b.test", "https://a.test"] };
  const integrity = createRecordIntegrity({ identityFields, result, sources });
  const record = {
    schema: "record.v1", accepted: true, validationErrors: [], model: "deepseek-v4-flash",
    result, ...integrity,
  };
  const expected = {
    expectedSchema: "record.v1", expectedFields: { model: "deepseek-v4-flash" }, identityFields, sources,
    revalidateResult: value => value.variations.length === 2 ? [] : ["bad count"],
  };
  assert.equal(assertRecordRevalidationPreconditions(record, expected), record);

  const tampered = structuredClone(record);
  tampered.result.variations[0].slot = 9;
  assert.match(validateRecordRevalidationPreconditions(tampered, expected).join("\n"), /resultSha256 mismatch/);
  assert.match(validateRecordRevalidationPreconditions(record, { ...expected, sources: { ...sources, goldMarkdown: "# B\n" } }).join("\n"), /identity mismatch|source/);
  assert.match(validateRecordRevalidationPreconditions({ ...record, model: "other" }, expected).join("\n"), /record field mismatch: model/);
});

test("atomic JSONL preserves the previous target on failure and artifact manifest hashes deterministically", async () => {
  const root = fixture();
  const target = join(root, "nested", "rows.jsonl");
  const written = await writeJsonlAtomic(target, [{ id: 1 }, { text: "line\nbreak" }]);
  assert.equal(written.rows, 2);
  assert.equal(readFileSync(target, "utf8"), '{"id":1}\n{"text":"line\\nbreak"}\n');
  assert.equal(written.sha256, sha256(readFileSync(target)));

  writeFileSync(target, "sentinel\n");
  async function* broken() {
    yield { id: 1 };
    throw new Error("boom");
  }
  await assert.rejects(writeJsonlAtomic(target, broken()), /boom/);
  assert.equal(readFileSync(target, "utf8"), "sentinel\n");
  assert.deepEqual((await enumerateArtifactManifest(root))["nested/rows.jsonl"], {
    bytes: 9,
    sha256: sha256("sentinel\n"),
  });
  const exact = await auditExactArtifactSet(root, ["nested/rows.jsonl"]);
  assert.equal(exact.ok, true);
  writeFileSync(join(root, "stale.123.tmp"), "partial");
  assert.match((await auditExactArtifactSet(root, ["nested/rows.jsonl"])).errors.join("\n"), /unexpected artifact: stale\.123\.tmp/);
});

test("JSONL readback preserves Unicode line and paragraph separators inside JSON strings", async () => {
  const root = fixture();
  const target = join(root, "unicode-separators.jsonl");
  const rows = [
    { id: 1, text: "before\u2028after" },
    { id: 2, text: "before\u2029after" },
  ];
  await writeJsonlAtomic(target, rows);
  const physical = readFileSync(target, "utf8");
  assert.match(physical, /before\\u2028after/);
  assert.match(physical, /before\\u2029after/);
  assert.equal(physical.includes("\u2028"), false);
  assert.equal(physical.includes("\u2029"), false);
  const readback = [];
  assert.equal(await readJsonlRows(target, row => readback.push(row)), rows.length);
  assert.deepEqual(readback, rows);
});

test("sibling staging replacement drops every old or unknown artifact", async () => {
  const root = fixture();
  const target = join(root, "pack");
  const staging = join(root, ".pack-staging");
  mkdirSync(target);
  mkdirSync(staging);
  writeFileSync(join(target, "stale.tmp"), "old");
  writeFileSync(join(staging, "manifest.json"), "new");
  await replaceDirectoryFromStaging(staging, target);
  assert.equal(readFileSync(join(target, "manifest.json"), "utf8"), "new");
  assert.equal((await auditExactArtifactSet(target, ["manifest.json"])).ok, true);
});

test("pack audit enforces three exact IDs per page and keeps task type separate from output format", () => {
  const pages = [
    { id: "p1", siteId: "site-a", finalUrl: "https://a.test/1" },
    { id: "p2", siteId: "site-b", finalUrl: "https://b.test/1" },
  ];
  const expectedTasksByPage = Object.fromEntries(pages.map(page => [page.id, [
    { taskType: "md", outputFormat: "markdown" },
    { taskType: "entity_inventory", outputFormat: "json_array" },
    { taskType: "focused_section", outputFormat: "plain_text" },
  ]]));
  const rows = pages.flatMap(page => expectedTasksByPage[page.id].map((task, task_idx) => ({
    sample_id: `${page.id}__t${task_idx}`, page_id: page.id, task_idx,
    task_type: task.taskType, output_format: task.outputFormat,
  })));
  assert.equal(auditTaskInventory({ pages, indexRows: rows, expectedTasksByPage }).ok, true);
  const bad = structuredClone(rows);
  bad[1].task_type = "json_array";
  bad.pop();
  const errors = auditTaskInventory({ pages, indexRows: bad, expectedTasksByPage }).errors.join("\n");
  assert.match(errors, /does not preserve teacher taskType/);
  assert.match(errors, /missing task: p2__t2/);
  assert.match(errors, /expected 3 tasks/);

  const twoTaskPlan = structuredClone(expectedTasksByPage);
  twoTaskPlan.p2.pop();
  assert.match(
    auditTaskInventory({ pages, indexRows: rows.slice(0, 5), expectedTasksByPage: twoTaskPlan }).errors.join("\n"),
    /expected task plan must contain exactly 1 or 3 tasks/,
  );
});

test("t0 is byte exact and site/page groups cannot leak across splits", () => {
  const root = fixture();
  mkdirSync(join(root, "gold"));
  mkdirSync(join(root, "outputs"));
  const pages = [
    { id: "p1", siteId: "shared", finalUrl: "https://a.test/1" },
    { id: "p2", siteId: "shared", finalUrl: "https://a.test/2" },
    { id: "p3", siteId: "solo", finalUrl: "https://b.test/1" },
  ];
  const rows = pages.map(page => {
    const gold = `# ${page.id}\n`;
    writeFileSync(join(root, "gold", `${page.id}.md`), gold);
    writeFileSync(join(root, "outputs", `${page.id}__t0.txt`), gold);
    return {
      sample_id: `${page.id}__t0`, page_id: page.id, task_idx: 0, split: page.id === "p3" ? "test" : "train",
      output: gold, answer_sha256: sha256(gold),
    };
  });
  assert.equal(auditT0ExactBytes({
    pages, indexRows: rows,
    goldPathForPage: page => join(root, "gold", `${page.id}.md`),
    outputPathForTask: row => join(root, "outputs", `${row.sample_id}.txt`),
  }).ok, true);
  const assignment = { p1: "train", p2: "train", p3: "test" };
  assert.deepEqual(auditPageGroupSplits({ pages, indexRows: rows, assignment }).counts, { train: 2, dev: 0, test: 1 });
  assert.equal(auditPageGroupSplits({ pages, indexRows: rows, assignment }).ok, true);

  const badRows = structuredClone(rows);
  badRows[0].output = "# p1";
  assert.match(auditT0ExactBytes({ pages, indexRows: badRows, goldPathForPage: page => join(root, "gold", `${page.id}.md`) }).errors.join("\n"), /byte-exact/);
  assert.match(auditPageGroupSplits({ pages, indexRows: rows, assignment: { ...assignment, p2: "dev" } }).errors.join("\n"), /leaks across splits/);
});

test("persisted readback cross-checks index, all SFT shards, outputs, and exact t0 bytes", async () => {
  const root = fixture();
  mkdirSync(join(root, "outputs"));
  mkdirSync(join(root, "gold"));
  const pages = [
    { id: "p1", siteId: "a", finalUrl: "https://a.test/1" },
    { id: "p2", siteId: "b", finalUrl: "https://b.test/1" },
  ];
  const system = "system";
  const expectedTasksByPage = {};
  const indexRows = [];
  const expectedRows = [];
  const sft = { train: [], dev: [], test: [] };
  for (const [pageOffset, page] of pages.entries()) {
    const split = pageOffset ? "test" : "train";
    const gold = `# ${page.id}\n`;
    writeFileSync(join(root, "gold", `${page.id}.md`), gold);
    expectedTasksByPage[page.id] = pageOffset ? [
      { taskType: "md", outputFormat: "markdown" },
    ] : [
      { taskType: "md", outputFormat: "markdown" },
      { taskType: "entity_list", outputFormat: "json_array" },
      { taskType: "single_fact", outputFormat: "plain_text" },
    ];
    for (let task_idx = 0; task_idx < expectedTasksByPage[page.id].length; task_idx += 1) {
      const sample_id = `${page.id}__t${task_idx}`;
      const output = task_idx === 0 ? gold : task_idx === 1 ? `["${page.id}"]` : page.id;
      const prompt = `prompt:${sample_id}`;
      const task = expectedTasksByPage[page.id][task_idx];
      const row = {
        sample_id, page_id: page.id, task_idx, split,
        task_type: task.taskType, output_format: task.outputFormat,
        prompt, output, answer_sha256: sha256(output),
      };
      indexRows.push(row);
      expectedRows.push({ ...row, prompt_sha256: sha256(prompt), output_sha256: sha256(output) });
      writeFileSync(join(root, "outputs", `${sample_id}.txt`), output);
      sft[split].push({ messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
        { role: "assistant", content: output },
      ] });
    }
  }
  await writeJsonlAtomic(join(root, "samples_index.jsonl"), indexRows);
  for (const split of ["train", "dev", "test"]) await writeJsonlAtomic(join(root, `sft_${split}.jsonl`), sft[split]);
  const options = {
    root, pages, expectedTasksByPage, expectedRows, expectedSystem: system,
    goldPathForPage: page => join(root, "gold", `${page.id}.md`),
  };
  const audit = await auditPersistedTrainingArtifacts(options);
  assert.equal(audit.ok, true, audit.errors.join("\n"));
  assert.equal(audit.indexTasks, 4);
  assert.equal(audit.sftTasks, 4);
  assert.equal(audit.outputArtifacts, 4);
  assert.equal(audit.t0Checked, 2);

  writeFileSync(join(root, "outputs", "p1__t2.txt"), "tampered");
  assert.match((await auditPersistedTrainingArtifacts(options)).errors.join("\n"), /output artifact differs from index output/);
});
