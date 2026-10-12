import assert from "node:assert/strict";
import { test } from "node:test";
import { isWaitingTranscriptActive, normalizeWaitingForm } from "../../src/sidepanel/features/chat/transcript/waiting-card.js";

test("historical and malformed form payloads normalize at the boundary", () => {
  for (const input of [null, [], true, 4, "legacy", { fields: {} }]) {
    assert.deepEqual(normalizeWaitingForm(input), { title: "", submitLabel: "提交", fields: [] });
  }
  const form = normalizeWaitingForm({ fields: [
    null, { id: "fallback", type: "single_choice", options: [] },
    { id: "unknown", type: "unrecognized", required: false, defaultValue: 42 },
    { id: " ", label: "ignored" },
  ] });
  assert.deepEqual(form.fields.map(field => [field.id, field.type, field.defaultValue, field.required]), [
    ["field_1", "text", "", true], ["fallback", "text", "", true], ["unknown", "text", "42", false],
  ]);
});

test("choice defaults stay scalar or plural and all historical aliases keep their priority", () => {
  const fields = normalizeWaitingForm({ fields: [
    { type: "single_choice", options: ["a", { label: "B", value: "b" }], defaultValue: " b ", default: "a" },
    { type: "multi_choice", options: ["a", "b"], defaultValues: [" a ", "", "b"] },
    { type: "multi_choice", options: ["a"], value: "a" },
    { type: "textarea", default: " old value " },
    { type: "text", defaultValue: null, default: "must not override explicit null" },
  ] }).fields;
  assert.equal(fields[0].defaultValue, "b");
  assert.deepEqual(fields[1].defaultValue, ["a", "b"]);
  assert.deepEqual(fields[2].defaultValue, ["a"]);
  assert.equal(fields[3].defaultValue, "old value");
  assert.equal(fields[4].defaultValue, "");
});

test("only waiting and legacy empty status are active", () => {
  for (const entry of [{}, { status: "" }, { status: "waiting" }, null]) assert.equal(isWaitingTranscriptActive(entry), true);
  for (const status of ["submitted", "cancelled", "aborted", "superseded", "stale", "unknown-terminal"]) {
    assert.equal(isWaitingTranscriptActive({ status }), false);
  }
});
