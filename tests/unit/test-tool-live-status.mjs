import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
const stripTypes = source => stripTypeScriptTypes(source, { mode: "transform" });
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
const toolRenderer = stripTypes(readFileSync(join(root, "src/sidepanel/tools/tool-renderer.ts"), "utf8"));

assertTranscriptReducerKeepsLiveToolStatus();
assertToolPatchSignatureIncludesLiveStatus();
assertToolRendererCarriesLiveStatusToDetails();

console.log("tool live status tests passed");

function assertTranscriptReducerKeepsLiveToolStatus() {
  let result = updateTranscriptWithAgentEvent([], {
    type: "tool_execution_start",
    sessionId: "session-live-status",
    runId: "run-live-status",
    spanId: "span-open-tab",
    toolCallId: "call-open-tab",
    toolName: "open_tab",
    toolCapabilityId: "open_tab",
    toolTitle: "新开页面",
    toolFamilyId: "arrival",
    toolFamilyTitle: "到达页面",
    args: { url: "https://example.net/a" },
  });

  result = updateTranscriptWithAgentEvent(result.transcript, {
    type: "tool_execution_update",
    sessionId: "session-live-status",
    runId: "run-live-status",
    spanId: "span-open-tab",
    toolCallId: "call-open-tab",
    toolName: "open_tab",
    args: { url: "https://example.net/a" },
    phase: "queued",
    statusText: "流控等待中",
    rateLimit: {
      host: "example.net",
      minOpenIntervalMs: 50000,
      waitMs: 41669,
    },
  });

  const tool = result.transcript.find(entry => entry.type === "tool");
  assert.equal(tool?.statusText, "流控等待中", "live tool update should enter transcript state");
  assert.equal(tool?.phase, "queued");
  assert.equal(tool?.rateLimit?.host, "example.net");
  assert.equal(tool?.capabilityId, "open_tab", "tool capability should survive later status updates");
  assert.equal(tool?.title, "新开页面", "tool title should survive later status updates");
  assert.equal(tool?.familyId, "arrival", "tool family should survive later status updates");
}

function assertToolPatchSignatureIncludesLiveStatus() {
  assert.match(
    transcriptRenderer,
    /function\s+toolTranscriptRenderSignature\(entry\s*=\s*\{\}\)[\s\S]*statusText:\s*entry\.statusText/,
    "live tool statusText must be part of the transcript render signature, otherwise DOM patch can skip the update",
  );
  assert.match(
    transcriptRenderer,
    /function\s+toolTranscriptRenderSignature\(entry\s*=\s*\{\}\)[\s\S]*rateLimit:\s*entry\.rateLimit/,
    "live tool rateLimit metadata must be part of the transcript render signature, otherwise queued-state details can stay stale",
  );
}

function assertToolRendererCarriesLiveStatusToDetails() {
  assert.match(
    toolRenderer,
    /function\s+createToolEventView\(tool,[\s\S]*statusText:\s*tool\.statusText/,
    "tool event view should keep statusText from the transcript entry",
  );
  assert.match(
    toolRenderer,
    /toolRuntimeDetails\.project\(\{\s*\.\.\.view,/,
    "tool details projection should receive the complete event view, including live statusText",
  );
  assert.match(
    toolRenderer,
    /function\s+toolDetailsRenderSignature\(tool,[\s\S]*statusText:\s*tool\?\.statusText/,
    "lazy tool details signature should include statusText so closed cards render fresh details when opened",
  );
}
