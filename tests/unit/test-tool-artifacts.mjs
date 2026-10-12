import assert from "node:assert/strict";
import test from "node:test";
import { createToolArtifactProjector, projectToolArtifacts } from "../../src/shared/tools/tool-artifacts.js";
import { createRunScriptArtifactCollector } from "../../src/background/tools/run-script-bridge.js";
import { createArtifactModel } from "../../src/capabilities/sessions/artifacts/artifact-model.js";
import { createSessionArtifacts } from "../../src/background/session/artifacts.js";

const stamp = "2026-09-18 10:00:00";
const file = { type: "file", id: "receipt", filename: "receipt.txt", url: "https://example.test/receipt.txt" };
const collector = createRunScriptArtifactCollector({ getToolIdentity: name => ({ capabilityId: name }) });
const model = createArtifactModel({ request: async () => { throw new Error("offline"); } });

test("an arbitrary tool shares explicit artifacts across nested calls, history and authoritative context", async () => {
  const result = { artifacts: [file, { type: "data", table: "custom rows", totalRows: 4 }] };
  const history = [{ type: "tool", name: "custom_receipt", args: {}, result, endedAt: stamp }];
  assert.deepEqual(collector("custom_receipt", {}, result), result.artifacts);
  const ui = model.collectSessionArtifacts("s", history);
  assert.equal(ui.files[0].title, "receipt.txt");
  assert.equal(ui.data[0].count, 4);
  const runtime = sessionArtifacts(history);
  const context = await runtime.collect("s", history);
  assert.equal(context.files[0].filename, "receipt.txt");
  assert.equal(context.dataTables[0].totalRows, 4);
});

test("legacy inference merges richer fields without losing the user's ordering anchor", () => {
  const history = [{ type: "tool", name: "data_store", args: { action: "insert" }, endedAt: stamp,
    result: { table: "rows", totalRows: 10, artifacts: [{ type: "data", id: "rows", table: "rows", totalRows: 1 }] } }];
  const summary = model.collectSessionArtifacts("s", history);
  assert.equal(summary.data.length, 1);
  assert.equal(summary.data[0].count, 10);
  assert.equal(summary.data[0].action, "insert");
  assert.equal(summary.data[0].updatedAt, stamp);
  for (const name of ["data_store", "collect_images"]) {
    const projected = projectToolArtifacts(name, {}, { table: "rows", totalRows: 1, updatedAt: "invalid", finishedAt: stamp });
    assert.equal(projected[0].updatedAt, stamp, "legacy results retain all established timestamp fallbacks");
  }
});

test("malformed explicit entries cannot replace valid legacy resources", () => {
  for (const artifacts of [[[]], [null, "bad", {}, { unexpected: 1 }]]) {
    const projected = collector("data_store", { action: "insert" }, { table: "rows", totalRows: 10, artifacts });
    assert.equal(projected.length, 1);
    assert.equal(projected[0].table, "rows");
    assert.equal(projected[0].totalRows, 10);
  }
});

test("failed and intermediate outputs never become user artifacts", () => {
  for (const failure of [{ error: "failed" }, { ok: false }, { isError: true }]) {
    assert.deepEqual(projectToolArtifacts("custom", {}, { ...failure, artifacts: [file] }), []);
  }
  const artifacts = [{ ...file, stage: "intermediate" }, { ...file, sourceTool: "document_fetch" }];
  for (const consumer of ["resource", "context", "display"]) {
    assert.deepEqual(projectToolArtifacts("custom", {}, { artifacts }, consumer), []);
  }
  assert.deepEqual(collector("custom", {}, { result: { artifacts: [file] } }), [file]);
});

test("a failing adapter preserves explicit results and does not poison the next tool", () => {
  const entry = { project() { throw new Error("broken adapter"); } };
  const registry = createToolArtifactProjector({ broken: entry });
  entry.project = () => [{ filename: "mutation.txt" }];
  assert.deepEqual(registry.project("broken", {}, { artifacts: [file] }), [file]);
  assert.deepEqual(registry.project("unknown", {}, { artifacts: [file] }), [file]);
  assert.throws(() => createToolArtifactProjector({ invalid: { project: true } }), /Invalid artifact projection/);
});

test("package envelope normalization reaches every consumer and leaves third-party content intact", () => {
  const image = { type: "data", table: "用户图集", kindLabel: "画像コレクション", rowCount: 2, meta: "2 张图片", score: 3 };
  for (const name of ["collect_images", "screenshot"]) {
    for (const consumer of ["resource", "context", "display"]) {
      const result = { artifacts: [image, file] };
      const projected = projectToolArtifacts(name, {}, result, consumer);
      assert.equal(projected[0].kind, "image_collection");
      assert.equal(projected[0].table, image.table);
      assert.equal(projected[0].rowCount, 2);
      assert.equal(projected[0].meta, undefined);
      assert.deepEqual(projected[1], file);
      assert.equal(result.artifacts[0].meta, "2 张图片", "normalization must not rewrite history");
      assert.deepEqual(projectToolArtifacts("custom", {}, result, consumer), [image, file]);
    }
  }
});

test("a broken package normalizer cannot discard explicit resources or mutate their top-level fields", () => {
  const projector = createToolArtifactProjector({ broken: { normalize(item) {
    item.filename = "corrupted.txt";
    throw new Error("broken normalizer");
  } } });
  for (const consumer of ["resource", "context", "display"]) {
    assert.deepEqual(projector.project("broken", {}, { artifacts: [file] }, consumer), [file]);
    assert.equal(file.filename, "receipt.txt");
  }
  assert.throws(() => createToolArtifactProjector({ invalid: { normalize: true } }), /Invalid artifact normalizer/);
});

function sessionArtifacts(history) {
  return createSessionArtifacts({
    sessionRepository: { updateMetadata: async () => ({ changed: false }) },
    getSessions: async () => ({ s: { id: "s" } }),
    normalizeSessionId: value => String(value || ""), nowBeijingDateTime: () => stamp,
    resolveSessionArtifactTranscript: async () => history, collectRunScriptToolArtifacts: collector,
    getToolIdentity: name => ({ capabilityId: name }), listTables: async () => [],
    appendResources: async () => [], listResources: async () => [],
  });
}
