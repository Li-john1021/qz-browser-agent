import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChatRunController } from "../../src/sidepanel/features/chat/chat-run-controller.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test("landing presentation state is explicit and leaves conversation layout untouched", () => {
  const welcome = { style: { display: "" } };
  const messagesEl = {
    dataset: { chatState: "landing" },
    querySelector: selector => selector === "#welcome" ? welcome : null,
  };
  const controller = createChatRunController({
    messagesEl,
    transcript: { getCurrentTranscript: () => [] },
    settings: {},
    scroll: {},
    queue: {},
  });

  controller.hideWelcome();
  assert.equal(welcome.style.display, "none");
  assert.equal(messagesEl.dataset.chatState, "conversation");

  controller.showWelcome();
  assert.equal(welcome.style.display, "");
  assert.equal(messagesEl.dataset.chatState, "landing");
});

test("only the explicit landing state changes the messages scroller", () => {
  const html = readFileSync(join(root, "src/sidepanel/sidepanel.html"), "utf8");
  const css = readStylesheetSource(join(root, "src/sidepanel/sidepanel.css"));

  assert.match(html, /<main id="messages" data-chat-state="landing">/u);
  assert.match(css, /#messages\[data-chat-state="landing"\]\s*\{/u);
  assert.doesNotMatch(css, /#messages:has\([^)]*\.welcome/u);
});

test("context usage stays quiet for the first user message", () => {
  const contextUsageEl = { textContent: "" };
  const transcript = [{ type: "user", text: "第一条消息" }];
  const controller = createChatRunController({
    messagesEl: { querySelector: () => null },
    contextUsageEl,
    transcript: { getCurrentTranscript: () => transcript },
    settings: {},
    scroll: {},
    queue: {},
  });

  controller.handleContextUsage({ inputTokensEstimate: 1200, contextWindow: 1_000_000 });
  assert.equal(contextUsageEl.textContent, "");

  transcript.push({ type: "assistant", text: "第一轮回复" }, { type: "user", text: "第二条消息" });
  controller.handleRuntimeContextUsage({ inputTokensEstimate: 2400, contextWindow: 1_000_000 });
  assert.equal(contextUsageEl.textContent, "ctx 2.4k/1M");
});
