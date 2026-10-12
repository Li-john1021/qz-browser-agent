import assert from "node:assert/strict";
import test from "node:test";

import { createTranscriptProjection } from "../../src/sidepanel/features/chat/transcript/projection.js";

test("protocol transcript keys stay stable while streamed content changes", () => {
  const projection = createTranscriptProjection();
  const source = Array.from({ length: 12 }, (_, index) => ({
    type: index % 2 === 0 ? "thinking" : "assistant",
    runId: "run-without-entry-ids",
    eventSeq: index + 1,
    streaming: true,
    text: `thinking ${index}`,
    content: `assistant ${index}`,
  }));
  const first = structuredClone(source);
  const second = structuredClone(source);
  second[0].text = "streaming content changed";
  second[1].content = "streaming content changed";

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  assert.deepEqual(
    second.map(entry => entry._uiKey),
    first.map(entry => entry._uiKey),
  );
  assert.equal(new Set(first.map(entry => entry._uiKey)).size, source.length);
  assert.ok(first.every(entry => /:event:\d+$/.test(entry._uiKey)));
});

test("identity-poor legacy keys survive clone and canonical reordering", () => {
  const projection = createTranscriptProjection();
  const notes = Array.from({ length: 12 }, (_, index) => ({
    type: "note",
    text: `legacy note ${index + 1}`,
    ...(index === 0 ? { _uiKey: "session-a:entry:91" } : {}),
  }));
  const tool = { type: "tool", runId: "run-a", toolCallId: "call-a" };
  const first = structuredClone([...notes, tool]);
  const second = structuredClone([tool, ...notes]);

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  const firstNoteKeys = first.filter(entry => entry.type === "note").map(entry => entry._uiKey);
  const secondNoteKeys = second.filter(entry => entry.type === "note").map(entry => entry._uiKey);
  assert.deepEqual(secondNoteKeys, firstNoteKeys);
  assert.equal(new Set(firstNoteKeys).size, notes.length);
  assert.ok(firstNoteKeys.every(key => /^session-a:note:legacy:/.test(key)));
});

test("duplicate protocol identities receive deterministic suffixes", () => {
  const projection = createTranscriptProjection();
  const source = [
    { type: "tool", runId: "run-a", toolCallId: "call-a" },
    { type: "tool", runId: "run-a", toolCallId: "call-a" },
  ];
  const first = structuredClone(source);
  const second = structuredClone(source);

  projection.assignKeys("session-a", first);
  projection.assignKeys("session-a", second);

  assert.deepEqual(
    first.map(entry => entry._uiKey),
    [
      "session-a:tool:run-a:call-a",
      "session-a:tool:run-a:call-a:duplicate:2",
    ],
  );
  assert.deepEqual(second.map(entry => entry._uiKey), first.map(entry => entry._uiKey));
});
