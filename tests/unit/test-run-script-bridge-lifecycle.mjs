import assert from "node:assert/strict";
import test from "node:test";
import { createRunScriptBridge } from "../../src/background/tools/run-script-bridge.js";

for (const stage of ["context", "execute", "apply"]) {
  for (const stop of ["revoke", "abort"]) {
    test(`nested script ${stop} during ${stage} rejects late artifacts and observations; the next run recovers`, async () => {
      let reachBoundary, releaseBoundary;
      const reached = new Promise(resolve => { reachBoundary = resolve; });
      const blocked = new Promise(resolve => { releaseBoundary = resolve; });
      const runId = "current";
      let activeRun = runId;
      let controller = new AbortController();
      let shouldPause = true;
      const pause = async boundary => {
        if (boundary !== stage || !shouldPause) return;
        reachBoundary();
        await blocked;
      };
      let executions = 0, applies = 0, appends = 0, refreshes = 0;
      const bridge = createRunScriptBridge({
        supervisor: { isRunCurrent: (_id, run) => activeRun === run, hasAgent: () => true, getAbortSignal: () => controller.signal },
        getRuntime: () => ({ status: "running" }),
        canManageSessions: async () => true,
        buildRunProfile: async () => ({}),
        getRunToolContext: async () => { await pause("context"); return {}; },
        applyNestedToolResult: async () => { applies++; await pause("apply"); },
        toolRuntime: {
          getSchemas: () => [],
          resolveDefinition: () => ({ behavior: { nestedObservation: true } }),
          async execute() { executions++; await pause("execute"); return { _image: "data:image/png;base64,aW1hZ2U=" }; },
        },
        collectArtifacts: () => [{ type: "file", filename: "output.txt" }],
        appendArtifacts: async () => { appends++; },
        scheduleArtifactRefresh: () => { refreshes++; },
      });
      const pending = bridge.handleToolCall({ sessionId: "s1", runId, toolName: "custom_observation" });
      await reached;
      if (stop === "abort") controller.abort();
      else activeRun = "next";
      releaseBoundary();
      const stopped = await pending;
      assert.equal(stopped.code, "RUN_STOPPED");
      assert.equal(stopped.observation, undefined);
      assert.equal(appends, 0);
      assert.equal(refreshes, 0);
      assert.equal(executions, stage === "context" ? 0 : 1);
      assert.equal(applies, stage === "apply" ? 1 : 0, "revoked tool results must not reach the Agent");

      shouldPause = false;
      activeRun = "next";
      controller = new AbortController();
      const recovered = await bridge.handleToolCall({ sessionId: "s1", runId: "next", toolName: "custom_observation" });
      assert.equal(recovered.ok, true);
      assert.ok(recovered.observation?._image);
      assert.equal(appends, 1);
      assert.equal(refreshes, 1);
    });
  }
}
