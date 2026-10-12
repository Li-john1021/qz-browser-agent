import assert from "node:assert/strict";
import test from "node:test";
import { createToolRuntimeDetails } from "../../src/sidepanel/tools/tool-runtime-details.js";
import { toolPresentationRegistry } from "../../src/sidepanel/tools/tool-presentation.js";
import { presentations } from "../../src/capabilities/script/presentation.js";

const details = createToolRuntimeDetails({ genericRenderer: {} });

test("script successful outer envelopes preserve returned error-like data without masking execution failure", () => {
  const unregister = presentations({ pageDisplayTarget: () => "" }).map(definition => toolPresentationRegistry.register(definition));
  try {
    const tool = { name: "run_script", hasResult: true, args: {}, result: { ok: true, result: { ok: false, error: "business data" } } };
    assert.equal(details.project(tool).state, "completed");
    assert.equal(details.project({ ...tool, isError: true }).state, "error");
    assert.equal(details.project({ ...tool, phase: "aborted" }).state, "aborted");
    assert.equal(details.project({ ...tool, result: { ok: false, error: "execution failed" } }).state, "error");
    assert.equal(details.project({ ...tool, result: { result: { error: "unknown envelope" } } }).state, "completed");
    assert.equal(details.project({ ...tool, result: { ok: true, error: "contradictory failure", result: 1 } }).state, "error");
  } finally { unregister.forEach(dispose => dispose()); }
});

test("an arbitrary renderer can declare result semantics and unregister back to the default", () => {
  const tool = { name: "ledger", rendererId: "ledger", hasResult: true, args: {}, result: { ok: true, result: { error: "not an execution failure" } } };
  const unregister = toolPresentationRegistry.register({ id: "ledger", resultIsError: () => false });
  assert.equal(details.project(tool).state, "completed");
  assert.equal(details.project({ ...tool, isError: true }).state, "error");
  unregister();
  assert.equal(details.project(tool).state, "error");
  const forceError = toolPresentationRegistry.register({ id: "ledger", resultIsError: () => true });
  assert.equal(details.project({ ...tool, result: { value: 3 } }).state, "error");
  forceError();
});

test("broken or asynchronous result interpreters fall back to the normal failure classifier", async () => {
  const tool = { name: "broken", hasResult: true, args: {}, result: { ok: true, result: { error: "failure" } } };
  for (const resultIsError of [() => { throw new Error("projection"); }, () => "false", async () => false, async () => { throw new Error("async"); }]) {
    const unregister = toolPresentationRegistry.register({ id: "broken", resultIsError });
    assert.equal(details.project(tool).state, "error");
    unregister();
    await Promise.resolve();
  }
});
