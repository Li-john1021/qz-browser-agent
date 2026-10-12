import assert from "node:assert/strict";
import { registerFilesDocumentsTools } from "../../src/capabilities/documents/tools.js";
import { ToolExecutionError } from "../../src/background/tools/arguments.js";

for (const phase of ["navigation", "print"]) {
  const controller = new AbortController();
  const listeners = new Set();
  const removed = [];
  let attached = false;
  let detached = false;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  globalThis.chrome = {
    storage: { local: { async get() { return {}; } } },
    tabs: {
      async create() { return { id: 42 }; },
      async get() { if (phase === "navigation") markStarted(); return { id: 42, status: phase === "navigation" ? "loading" : "complete" }; },
      async remove(id) { removed.push(id); },
      onUpdated: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    },
  };
  const definitions = new Map();
  registerFilesDocumentsTools({
    registerTool: definition => definitions.set(definition.name, definition),
    ToolExecutionError,
    getToolRuntimeDependencies: () => ({ windowTarget: { async resolveForNewTab() { return 1; } } }),
    assertUrlAllowed() {},
    async withTemporaryDebugger(_tabId, callback) {
      attached = true;
      try {
        return await callback({}, async method => {
          if (method === "Page.enable") return {};
          assert.equal(method, "Page.printToPDF");
          markStarted();
          return new Promise(() => {});
        });
      } finally { detached = true; }
    },
  });
  const operation = definitions.get("document_create").execute({
    format: "pdf", title: "Cancellation", download: false, blocks: [{ type: "paragraph", text: "Body" }],
  }, controller.signal, { sessionId: "current" });
  const failed = assert.rejects(operation, error => error.name === "AbortError" || error.code === "OPERATION_ABORTED");
  await started;
  controller.abort();
  await failed;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(removed.includes(42), `${phase}: cancellation must close the owned temporary tab`);
  assert.equal(listeners.size, 0, `${phase}: no page listener may survive cancellation`);
  assert.equal(attached, phase === "print");
  assert.equal(detached, phase === "print", "print cancellation must unwind the debugger scope even if Chrome never resolves the command");
}
console.log("document PDF cancellation releases temporary tab and debugger scopes");
