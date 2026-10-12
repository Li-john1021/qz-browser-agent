import assert from "node:assert/strict";
import test from "node:test";
import { createChatRunController } from "../../src/sidepanel/features/chat/chat-run-controller.js";

function harness(t) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 10000 });
  let sessionId = "a";
  const classes = new Set(["hidden"]);
  const statusBar = { classList: {
    contains: name => classes.has(name),
    add: name => classes.add(name),
    remove: name => classes.delete(name),
  } };
  const statusText = { textContent: "" };
  const noop = () => {};
  const controller = createChatRunController({
    messagesEl: {}, statusBar, statusText,
    transcript: { getCurrentTranscript: () => [], hideAssistantActions: noop, scheduleRender: noop, render: noop },
    settings: { renderGptConnectHint: noop, hideGptConnectHint: noop },
    scroll: { updateSafeArea: noop, settleAfterDockLayout: noop, shouldFollowTail: () => false },
    queue: {}, getSessionId: () => sessionId, isChatActive: () => true,
  });
  controller.start("run-a", { requireConversation: false });
  t.after(() => controller.finish());
  return { controller, statusText, classes, switchSession: id => { sessionId = id; } };
}

test("fast tool phases never flash and repeated deltas do not postpone a stable phase", t => {
  const { controller, statusText } = harness(t);
  controller.showStatus("调用工具...");
  t.mock.timers.tick(100);
  assert.match(statusText.textContent, /^思考中/);
  controller.showStatus("思考中...");
  t.mock.timers.tick(400);
  assert.match(statusText.textContent, /^思考中/);
  controller.showStatus("调用慢工具...");
  t.mock.timers.tick(100);
  controller.showStatus("调用慢工具...");
  t.mock.timers.tick(200);
  assert.match(statusText.textContent, /^调用慢工具/);
  controller.showStatus("思考中...");
  t.mock.timers.tick(100);
  assert.match(statusText.textContent, /^调用慢工具/);
  t.mock.timers.tick(200);
  assert.match(statusText.textContent, /^思考中/);
});

test("urgent feedback overrides pending phases and terminal states hide immediately", t => {
  const { controller, statusText, classes } = harness(t);
  controller.showStatus("调用工具...");
  controller.showStatus("模型请求正在排队…", { immediate: true });
  assert.match(statusText.textContent, /^模型请求正在排队/);
  t.mock.timers.tick(400);
  assert.match(statusText.textContent, /^模型请求正在排队/);
  controller.showStatus("生成中...");
  controller.enterState(controller.states.WAITING_USER);
  assert.equal(classes.has("hidden"), true);
  t.mock.timers.tick(400);
  assert.equal(classes.has("hidden"), true);
  controller.start("run-b", { requireConversation: false });
  assert.match(statusText.textContent, /^思考中/);
  controller.showStatus("调用工具...");
  controller.finish();
  t.mock.timers.tick(400);
  assert.equal(classes.has("hidden"), true);
});

test("pending phases cannot leak across sessions or runs", t => {
  const { controller, statusText, switchSession } = harness(t);
  controller.showStatus("旧任务工具...");
  switchSession("b");
  controller.start("run-b", { requireConversation: false });
  t.mock.timers.tick(400);
  assert.match(statusText.textContent, /^思考中/);
  controller.showStatus("上一轮工具...");
  controller.start("run-c", { requireConversation: false });
  t.mock.timers.tick(400);
  assert.match(statusText.textContent, /^思考中/);
});
