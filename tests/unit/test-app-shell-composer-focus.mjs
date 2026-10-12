import assert from "node:assert/strict";
import { createAppShellFeature } from "../../src/sidepanel/features/app/app-shell-feature.js";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => {
  const id = ++frameId;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = id => frames.delete(id);

try {
  const body = fakeElement("body");
  const root = new EventTarget();
  const windowTarget = new EventTarget();
  const newButton = fakeElement("new-chat");
  const input = fakeElement("input");
  const inputArea = fakeElement("input-area");
  let activeElement = body;
  let focusCount = 0;
  let blurCount = 0;
  let currentTab = "chat";
  let documentFocused = true;
  let settingsBlocking = false;
  let resolveNewChatTransition = null;

  Object.assign(root, {
    body,
    defaultView: windowTarget,
    visibilityState: "visible",
    querySelectorAll: () => [],
    hasFocus: () => documentFocused,
  });
  Object.defineProperty(root, "activeElement", { get: () => activeElement });
  Object.assign(input, {
    value: "draft",
    disabled: false,
    readOnly: false,
    isConnected: true,
    focus() {
      focusCount += 1;
      activeElement = input;
    },
    blur() {
      blurCount += 1;
      activeElement = body;
    },
  });

  const shell = createAppShellFeature({
    ui: {
      getPages: () => [], getPage: id => ({ id }), isPageEnabled: () => true,
      subscribeChanges: () => () => {}, activatePage() {}, deactivatePage() {}, emit() {},
      closeTopmostOverlay: () => false,
      hasBlockingOverlay: () => settingsBlocking,
    },
    root,
    newButton,
    tabs: { CHAT: "chat", LOGS: "logs" },
    getCurrentTab: () => currentTab,
    setCurrentTab: tab => { currentTab = tab; },
    input,
    inputArea,
    panels: {},
    runController: {
      renderDock() {},
      setSuppressEvents() {},
      finish() {},
    },
    goalStrip: { renderCurrent() {} },
    logs: { setEnabled() {} },
    artifacts: {},
    automations: {},
    chatSearch: {},
    settings: { hasBlockingOverlay: () => settingsBlocking },
    data: { hasBlockingOverlay: () => false },
    transitionToSession: () => new Promise(resolve => {
      resolveNewChatTransition = resolve;
    }),
  });

  shell.start();
  shell.setReady();
  flushFrames();
  assert.equal(activeElement, input);

  focusCount = 0;
  activeElement = body;
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 0, "window focus without a pending intent must not steal focus from another control");

  documentFocused = false;
  shell.scheduleComposerFocus();
  flushFrames();
  assert.equal(focusCount, 0, "an unfocused Side Panel document must not report a fake Composer focus");

  documentFocused = true;
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 1, "a real window focus should fulfill the pending Composer intent once");

  focusCount = 0;
  activeElement = body;
  root.visibilityState = "hidden";
  shell.scheduleComposerFocus();
  flushFrames();
  assert.equal(focusCount, 0, "a hidden Side Panel must not steal focus");

  root.visibilityState = "visible";
  currentTab = "logs";
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 0, "a non-chat tab must keep its own focus");

  currentTab = "chat";
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 0, "a rejected intent must not become a later focus steal");

  settingsBlocking = true;
  shell.scheduleComposerFocus();
  flushFrames();
  assert.equal(focusCount, 0, "a visible modal must retain focus ownership");

  settingsBlocking = false;
  input.focus();
  focusCount = 0;
  blurCount = 0;
  documentFocused = false;
  shell.scheduleComposerFocus("preset_closed");
  flushFrames();
  shell.scheduleComposerFocus();
  flushFrames();
  assert.equal(blurCount, 0, "a deferred dialog-close intent must wait for real document focus");
  assert.equal(focusCount, 0);

  documentFocused = true;
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();

  assert.equal(blurCount, 1, "native dialog restoration should be reset when it only changes activeElement");
  assert.equal(focusCount, 1, "the Composer should receive one real focus transition after the reset");
  assert.equal(activeElement, input);
  assert.equal(input.value, "draft", "forcing a focus transition must preserve the draft");

  activeElement = body;
  focusCount = 0;
  newButton.dispatchEvent(new Event("click"));
  assert.equal(typeof resolveNewChatTransition, "function");
  documentFocused = false;
  resolveNewChatTransition(true);
  await Promise.resolve();
  flushFrames();
  assert.equal(focusCount, 0, "an async new-chat transition must not focus after the user returns to the webpage");

  documentFocused = true;
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 1, "new-chat focus should recover when the Side Panel actually regains focus");

  documentFocused = false;
  activeElement = body;
  focusCount = 0;
  shell.scheduleComposerFocus();
  flushFrames();
  shell.stop();
  documentFocused = true;
  windowTarget.dispatchEvent(new Event("focus"));
  flushFrames();
  assert.equal(focusCount, 0, "stopping the shell must discard deferred focus intent");
} finally {
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
}

console.log("app shell Composer focus tests passed");

function flushFrames() {
  while (frames.size) {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback(Date.now());
  }
}

function fakeElement(id) {
  const element = new EventTarget();
  element.id = id;
  element.classList = { contains: () => false };
  element.getAttribute = () => null;
  return element;
}
