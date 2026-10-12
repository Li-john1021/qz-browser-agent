import assert from "node:assert/strict";

import { createChromeWindowTarget } from "../../src/background/services/chrome-window-target.js";

function fixture({ tabs = {}, windows = {}, lastFocused = null } = {}) {
  const calls = [];
  let currentLastFocused = lastFocused;
  const target = createChromeWindowTarget({
    tabs: {
      async get(id) {
        calls.push(["tabs.get", id]);
        const tab = tabs[id];
        if (!tab) throw new Error("missing tab");
        return tab;
      },
    },
    windows: {
      async get(id) {
        calls.push(["windows.get", id]);
        const window = windows[id];
        if (!window) throw new Error("missing window");
        return window;
      },
      async getLastFocused(options) {
        calls.push(["windows.getLastFocused", options]);
        if (!currentLastFocused) throw new Error("no window");
        return currentLastFocused;
      },
    },
  });
  return {
    target,
    calls,
    setLastFocused(value) { currentLastFocused = value; },
  };
}

{
  const { target, calls } = fixture({
    tabs: { 9: { id: 9, windowId: 3 } },
    windows: { 3: { id: 3, type: "normal" }, 4: { id: 4, type: "normal" } },
    lastFocused: { id: 5, type: "normal" },
  });
  assert.equal(await target.resolveForNewTab({ anchorTabId: 9, sourceWindowId: 4 }), 3);
  assert.deepEqual(calls, [["tabs.get", 9], ["windows.get", 3]]);
}

{
  const { target } = fixture({
    tabs: { 9: { id: 9, windowId: 7 } },
    windows: { 4: { id: 4, type: "normal" }, 7: { id: 7, type: "popup" } },
    lastFocused: { id: 5, type: "normal" },
  });
  assert.equal(await target.resolveForNewTab({ anchorTabId: 9, sourceWindowId: 4 }), 4);
}

{
  const { target } = fixture({
    windows: { 4: { id: 4, type: "popup" } },
    lastFocused: { id: 5, type: "normal" },
  });
  assert.equal(await target.resolveForNewTab({ anchorTabId: 99, sourceWindowId: 4 }), 5);
}

{
  const state = fixture({ lastFocused: { id: 5, type: "normal" } });
  assert.equal(await state.target.resolveForNewTab(), 5);
  state.setLastFocused({ id: 6, type: "normal" });
  assert.equal(await state.target.resolveForNewTab(), 6, "the resolver must not cache an earlier window");
}

{
  const { target } = fixture({ lastFocused: { id: 5, type: "popup" } });
  await assert.rejects(
    target.resolveForNewTab(),
    error => error?.code === "NO_NORMAL_BROWSER_WINDOW",
  );
}

console.log("chrome window target tests passed");
