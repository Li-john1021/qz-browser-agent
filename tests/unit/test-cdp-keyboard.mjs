import assert from "node:assert/strict";
import test from "node:test";

import { createCdpKeyboard, primaryModifierForContext } from "../../src/background/tools/cdp-keyboard.js";

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

test("CDP keyboard uses rawKeyDown for control keys and keyDown for text-producing keys", async () => {
  const calls = [];
  const keyboard = createCdpKeyboard({
    ToolExecutionError,
    async sendCdp(tabId, method, params, context) {
      calls.push({ tabId, method, params, context });
    },
  });
  const context = { sessionId: "s1", runId: "r1", runProfile: { platform: { os: "mac" } } };

  for (const key of ["Tab", "Backspace", "Delete", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
    calls.length = 0;
    await keyboard.press(7, key, context);
    assert.deepEqual(calls.map(call => call.params.type), ["rawKeyDown", "keyUp"]);
    assert.equal(calls[0].params.key, key === "Escape" ? "Escape" : key);
    assert.equal(calls[0].params.text, "");
    assert.equal(calls[0].context, context);
  }

  for (const [key, expected] of [["a", "a"], ["Space", " "], ["Enter", "\r"]]) {
    calls.length = 0;
    await keyboard.press(7, key, context);
    assert.deepEqual(calls.map(call => call.params.type), ["keyDown", "keyUp"]);
    assert.equal(calls[0].params.text, expected);
  }
});

test("CDP keyboard normalizes modifier aliases and applies editing commands only to current-platform shortcuts", async () => {
  const calls = [];
  const keyboard = createCdpKeyboard({
    ToolExecutionError,
    async sendCdp(_tabId, _method, params) { calls.push(params); },
  });

  await keyboard.press(1, "Command+A", { runProfile: { platform: { os: "mac" } } });
  assert.deepEqual(calls[0], {
    type: "rawKeyDown",
    key: "A",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 4,
    text: "",
    unmodifiedText: "",
    commands: ["selectAll"],
  });

  calls.length = 0;
  await keyboard.press(1, "Ctrl+A", { runProfile: { platform: { os: "win" } } });
  assert.equal(calls[0].type, "rawKeyDown");
  assert.equal(calls[0].modifiers, 2);
  assert.deepEqual(calls[0].commands, ["selectAll"]);

  for (const [key, command] of [["C", "copy"], ["V", "paste"], ["X", "cut"]]) {
    calls.length = 0;
    await keyboard.press(1, `Cmd+${key}`, { runProfile: { platform: { os: "mac" } } });
    assert.equal(calls[0].type, "rawKeyDown");
    assert.equal(calls[0].modifiers, 4);
    assert.deepEqual(calls[0].commands, [command]);
  }

  calls.length = 0;
  await keyboard.press(1, "Control+A", { runProfile: { platform: { os: "mac" } } });
  assert.equal(calls[0].modifiers, 2);
  assert.equal(calls[0].commands, undefined);

  calls.length = 0;
  await keyboard.press(1, "Control+C", { runProfile: { platform: { os: "mac" } } });
  assert.equal(calls[0].commands, undefined);

  calls.length = 0;
  await keyboard.press(1, "Option+Shift+ArrowDown", { runProfile: { platform: { os: "mac" } } });
  assert.equal(calls[0].modifiers, 9);
  assert.equal(calls[0].type, "rawKeyDown");
});

test("CDP keyboard releases a possibly pressed key after a lost keyDown response", async () => {
  const calls = [];
  const keyboard = createCdpKeyboard({ ToolExecutionError, sendCdp: async (_tabId, _method, params) => {
    calls.push(params.type);
    if (params.type === "keyDown") throw new Error("lost keyDown response");
  } });
  await assert.rejects(keyboard.press(1, "Enter"), /lost keyDown response/);
  assert.deepEqual(calls, ["keyDown", "keyUp"], "release without replaying Enter");
});

test("CDP keyboard rejects invalid modifiers before dispatch and releases a key after a keyUp failure", async () => {
  const calls = [];
  let keyUpFailures = 1;
  const keyboard = createCdpKeyboard({
    ToolExecutionError,
    async sendCdp(_tabId, _method, params) {
      calls.push(params.type);
      if (params.type === "keyUp" && keyUpFailures > 0) {
        keyUpFailures -= 1;
        throw new Error("transient keyUp failure");
      }
    },
  });

  await assert.rejects(
    keyboard.press(1, "Hyper+A", {}),
    error => error?.code === "INVALID_ARGUMENTS" && error?.details?.key === "Hyper+A",
  );
  assert.deepEqual(calls, []);

  assert.throws(
    () => keyboard.normalize("Hyper+A"),
    error => error?.code === "INVALID_ARGUMENTS" && error?.details?.key === "Hyper+A",
  );

  await assert.rejects(keyboard.press(1, "ArrowDown", {}), /transient keyUp failure/);
  assert.deepEqual(calls, ["rawKeyDown", "keyUp", "keyUp"]);
});

test("primary modifier derives from the frozen run profile", () => {
  assert.equal(primaryModifierForContext({ runProfile: { platform: { os: "mac" } } }), "Meta");
  assert.equal(primaryModifierForContext({ runProfile: { platform: { os: "win" } } }), "Control");
  assert.equal(primaryModifierForContext({ runProfile: { platform: { os: "linux" } } }), "Control");
});
