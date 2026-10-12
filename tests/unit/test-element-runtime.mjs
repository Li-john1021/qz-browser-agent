import assert from "node:assert/strict";

let currentUrl = "https://example.test/page#one";
globalThis.chrome = {
  tabs: { async get(tabId) { return { id: tabId, url: currentUrl }; } },
  debugger: { async sendCommand() { return {}; } },
};

const { createElementRuntime } = await import("../../src/background/tools/element-runtime.js");

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const resolveCalls = [];
const runtime = createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies() {
    return {
      sessions: {
        async resolveTargetTab(input) {
          resolveCalls.push(input);
          return { ok: true };
        },
      },
    };
  },
  makeSessionTabTargetError(code, details = {}) { return new ToolExecutionError(code, code, details); },
  async assertTabAllowed() {},
  async withDebugger(_tabId, callback) { return await callback({ tabId: 5 }); },
});

runtime.registerElementRef({
  uid: "t5_ax_1",
  tabId: 5,
  sessionId: "session-a",
  pageUrl: "https://example.test/page",
  selector: "button.primary",
});

const resolved = await runtime.resolveElementReference(undefined, { target: "uid:t5_ax_1" }, { sessionId: "session-a" });
assert.equal(resolved.tabId, 5);
assert.equal(resolved.selector, "button.primary");
assert.equal(resolved.target, "uid:t5_ax_1");
assert.equal(resolveCalls.length, 1);

const css = await runtime.resolveElementReference(5, { target: "css:main > button", index: 2 }, { sessionId: "session-a" });
assert.equal(css.selector, "main > button");
assert.equal(css.index, 2);

await assert.rejects(
  runtime.resolveElementReference(5, {}, { sessionId: "session-a" }),
  error => error?.code === "MISSING_ELEMENT_REFERENCE",
  "an empty read_image target path must still fail before page access",
);
await assert.rejects(
  runtime.resolveElementReference(5, { target: "uid:missing" }, { sessionId: "session-a" }),
  error => error?.code === "STALE_ELEMENT_UID",
);
await assert.rejects(
  runtime.resolveElementReference(5, { target: "uid:t5_ax_1" }, { sessionId: "session-b" }),
  error => error?.code === "ELEMENT_UID_SESSION_MISMATCH",
);

currentUrl = "https://example.test/other";
await assert.rejects(
  runtime.resolveElementReference(5, { target: "uid:t5_ax_1" }, { sessionId: "session-a" }),
  error => error?.code === "STALE_ELEMENT_UID_PAGE_CHANGED",
);

assert.equal(runtime.isUidElementTarget("uid:t5_ax_1"), true);
assert.equal(runtime.elementTargetForSelector("#save"), "css:#save");

console.log("element runtime ownership tests passed");
