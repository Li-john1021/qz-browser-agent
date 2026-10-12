import assert from "node:assert/strict";
import { createArtifactModel } from "../../src/capabilities/sessions/artifacts/artifact-model.js";
import {
  artifactTimeMs, normalizeArtifactTimeValue, resolveArtifactUpdatedAt,
  fileArtifactDownloadId, fileArtifactDedupeKey, projectFileArtifact,
} from "../../src/shared/tools/artifact-projection.js";

import { projectToolArtifacts } from "../../src/shared/tools/tool-artifacts.js";

const model = createArtifactModel({ request: async () => { throw new Error("offline"); } });
const stamp = "2026-09-17 10:00:00";
const tool = (name, result, args = {}, extra = {}) => ({ type: "tool", name, args, result, endedAt: stamp, ...extra });
const history = [
  tool("save_file", { filename: "Report.pdf", downloadId: 7, size: 2048 }),
  tool("document_create", { filename: "Report.pdf", artifactId: "a1", downloaded: { downloadId: 7 }, format: "pdf", size: 2048 }),
  tool("document_download", { filename: "Report.pdf", downloadId: 8 }, { artifactId: "a1" }),
  tool("download_url", { url: "https://example.test/data.csv" }),
  tool("save_file", { filename: "unfinished.pdf", downloadId: 10 }, {}, { isRunning: true }),
  tool("document_create", { filename: "failed.pdf", downloaded: { downloadId: 11 } }, {}, { isError: true }),
  tool("document_create", { artifactId: "hidden", filename: "local.pdf" }),
  tool("document_create", { url: "https://example.test/missing-name.pdf" }),
  tool("custom", { artifacts: [{ type: "file", sourceTool: "document_fetch", filename: "intermediate.pdf", url: "https://example.test/intermediate.pdf" }] }),
];
const summary = model.collectSessionArtifacts("s1", history);
assert.equal(summary.files.length, 2, "completed downloads dedupe by filename/format while failures, pending and intermediate files stay excluded");
assert.equal(summary.files[0].title, "Report.pdf");
assert.equal(summary.files[0].artifactId, "a1");
assert.equal(summary.files[0].meta, "pdf · 2 KB");
assert.equal(summary.files[0].updatedAt, stamp);
assert.equal(summary.files[1].url, "https://example.test/data.csv");
assert.deepEqual(await model.collectSessionArtifactsWithRuntime("s1", history), summary, "unavailable runtime hydration retains the immediate transcript projection");

const initial = model.collectSessionArtifacts("s1", [tool("data_store", { table: "rows", totalRows: 1 }, { action: "insert" })]);
const hydrated = model.buildArtifactSummaryFromRuntimeArtifacts("s1", {
  dataTables: [{ table: "rows", totalRows: 10, updatedAt: "2026-09-17 12:00:00" }],
});
const merged = model.mergeArtifactSummaries("s1", initial, hydrated);
assert.equal(merged.data[0].count, 10);
assert.equal(merged.data[0].updatedAt, "2026-09-17 12:00:00");
assert.equal(merged.data[0].sortTimeMs, initial.data[0].sortTimeMs, "richer metadata cannot reorder an existing UI anchor");

assert.equal(fileArtifactDownloadId({ id: "download:42" }), "42");
assert.equal(fileArtifactDownloadId({ downloaded: { downloadId: 42 } }), "42");
assert.equal(fileArtifactDedupeKey({ title: "Report.PDF" }), fileArtifactDedupeKey({ filename: "report.pdf", format: "PDF" }));
assert.equal(projectFileArtifact({ filename: "local.pdf", artifactId: "a1" }).id, "artifact:a1", "the core projection retains non-downloadable metadata for the owning consumer to filter");
assert.equal(projectFileArtifact({ url: "relative/file.csv?token=1" }).filename, "file.csv");
assert.deepEqual(projectToolArtifacts("other", {}, {}), []);
assert.equal(projectToolArtifacts("document_create", {}, { filename: "a.txt", downloadId: 1, downloaded: { downloadId: 2 } })[0].downloadId, 2, "context extraction retains its nested document download source");
assert.equal(normalizeArtifactTimeValue(String(artifactTimeMs(stamp))), stamp);
assert.equal(resolveArtifactUpdatedAt({ updatedAt: "invalid", createdAt: stamp }, "2026-01-01 00:00:00"), stamp);
assert.equal(normalizeArtifactTimeValue("invalid"), "");
console.log("shared artifact projections preserve file identity, eligibility and UI hydration anchors");
