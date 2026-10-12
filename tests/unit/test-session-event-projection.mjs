import assert from "node:assert/strict";
import test from "node:test";
import { updateTranscriptWithAgentEvent } from "../../src/shared/session/session-codec.js";

const timestamp = "2026-09-18 08:00:00";
const event = (type, fields = {}) => ({ type, toolCallId: "call", runId: "current", timestamp, ...fields });

test("tool preparation finalizes its parent thinking while execution starts the latest thinking", () => {
  const thinking = [
    { type: "thinking", spanId: "parent", text: "first", streaming: true },
    { type: "thinking", spanId: "latest", text: "second", streaming: true },
  ];
  const prepared = updateTranscriptWithAgentEvent(thinking, event("tool_call_update", {
    parentSpanId: "parent", args: { ignored: true }, arguments: '{"value":', argsComplete: false,
  })).transcript;
  assert.equal(prepared[0].streaming, undefined);
  assert.equal(prepared[1].streaming, true);
  const call = prepared.find(entry => entry.type === "tool");
  assert.deepEqual(call.args, {}, "partial arguments remain text, never executable data");
  assert.equal(call.argsText, '{"value":');
  assert.equal(call.argsState, "generating");
  assert.equal(call.argsIncomplete, true);
  assert.equal(call.argsGenerating, true);
  const started = updateTranscriptWithAgentEvent(prepared, event("tool_execution_start", {
    args: { value: 3 }, phase: "ignored", argsState: "ignored",
  })).transcript;
  assert.equal(started[1].streaming, undefined);
  const executing = started.find(entry => entry.type === "tool");
  assert.deepEqual(executing.args, { value: 3 });
  assert.equal(executing.argsText, "");
  assert.equal(executing.argsState, "executing");
  assert.equal(executing.phase, "running");
  assert.equal(executing.argsIncomplete, false);
  assert.equal(executing.argsGenerating, false);
});

test("tool progress preserves same-run evidence while completion uses the final event and image policy", () => {
  const foreign = { type: "tool", runId: "other", toolCallId: "call", name: "foreign", args: { other: 1 } };
  const previous = {
    type: "tool", runId: "current", toolCallId: "call", spanId: "stored", name: "stored",
    title: "Old title", familyId: "family", args: { stored: 1 }, argsText: "draft",
    argsState: "ready", phase: "waiting", result: false, image: "previous-image",
    rateLimit: { waitMs: 20 }, timestamp, eventSeq: 2,
  };
  const updated = updateTranscriptWithAgentEvent([foreign, previous], event("tool_execution_update", {
    title: "New title", eventSeq: 8,
  })).transcript;
  assert.deepEqual(updated[0], foreign);
  const progress = updated[1];
  for (const key of ["spanId", "name", "args", "argsText", "argsState", "phase", "result", "image", "rateLimit", "familyId", "eventSeq"]) {
    assert.deepEqual(progress[key], previous[key], `progress should retain ${key}`);
  }
  assert.equal(progress.title, "New title");
  assert.equal(progress.statusText, "");
  for (const isError of [false, true]) {
    const result = { ok: true, _image: "data:image/png;base64,AA" };
    const ended = updateTranscriptWithAgentEvent(updated, event("tool_execution_end", {
      toolName: "final", result, isError, endedAt: "2026-09-18 08:01:00",
    })).transcript[1];
    assert.equal(ended.name, "final");
    assert.deepEqual(ended.args, {});
    assert.equal(ended.argsText, "");
    assert.equal(ended.phase, "done");
    assert.equal(ended.isRunning, false);
    assert.equal(ended.isError, isError);
    assert.equal(ended.image, isError ? null : result._image);
    assert.deepEqual(ended.result, isError ? result : { ok: true });
    assert.equal(ended.timestamp, timestamp);
    assert.equal(ended.endedAt, "2026-09-18 08:01:00");
    assert.equal(ended.eventSeq, 2);
  }
});

test("compaction states keep distinct summaries, metrics and completion times", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 18, 1, 2, 3) });
  const base = { compactId: "compact", inputTokensBefore: 200, inputTokensAfter: 30,
    contextWindow: 1000, threshold: 700, sourceMessageCount: 8, retainedMessageCount: 2,
    endedAt: "2026-09-18 08:00:05", content: "[之前的对话摘要] restored summary", message: "failed summary" };
  for (const [type, status, summary] of [
    ["context_compaction_start", "running", ""],
    ["context_compaction_end", "done", "restored summary"],
    ["context_compaction_failed", "failed", "failed summary"],
  ]) {
    const entry = updateTranscriptWithAgentEvent([], event(type, base)).transcript[0];
    assert.equal(entry.status, status);
    assert.equal(entry.summary, summary);
    assert.equal(entry.inputTokensBefore, 200);
    assert.equal(entry.retainedMessageCount, 2);
    assert.equal(Object.hasOwn(entry, "inputTokensAfter"), status === "done");
    assert.equal(entry.endedAt, status === "running" ? base.endedAt : "2026-09-18 09:02:03");
    assert.equal(entry.streaming, status === "running" ? true : undefined);
  }
  const custom = updateTranscriptWithAgentEvent([], event("context_compaction_end", { ...base, status: "custom", summary: "explicit" })).transcript[0];
  assert.equal(custom.status, "custom");
  assert.equal(custom.summary, "explicit");
});

test("terminal recovery retains prior results and times and never settles another run", () => {
  for (const status of ["completed", "aborted", "interrupted", "error"]) {
    for (const result of [null, "", false, 0, { evidence: true }]) {
      const foreign = { type: "tool", toolCallId: "foreign", runId: "other", argsState: "ready", result: null };
      const own = { type: "tool", toolCallId: "own", runId: "current", argsState: "generating",
        argsIncomplete: true, isRunning: true, result, endedAt: timestamp };
      const output = updateTranscriptWithAgentEvent([foreign, own], event("state", { runtime: { status } })).transcript;
      assert.deepEqual(output[0], foreign);
      const terminal = output[1];
      assert.equal(terminal.phase, status === "completed" ? "not_executed" : status);
      assert.equal(terminal.argsState, status === "interrupted" ? "aborted" : terminal.phase);
      assert.equal(terminal.endedAt, timestamp);
      assert.equal(terminal.isRunning, false);
      assert.equal(terminal.argsIncomplete, false);
      if (result === null || result === "") {
        assert.equal(terminal.result.code, status === "completed" ? "TOOL_NOT_EXECUTED" : status === "aborted" ? "TOOL_ABORTED" : "TOOL_INTERRUPTED");
        if (status === "completed") assert.match(terminal.result.error, /没有完成工具参数生成/);
      } else assert.deepEqual(terminal.result, result);
    }
  }
});
