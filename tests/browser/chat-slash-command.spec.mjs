import { expect, test } from "./sidepanel-fixtures.mjs";

test("explains why compact cannot run before a conversation exists", async ({ page }) => {
  await page.locator("#input").fill("/compact");
  await page.locator("#btn-send").click();

  await expect(page.locator(".case-toast.visible")).toContainText("当前没有可压缩的对话");
  const posted = await page.evaluate(() => window.__qzPostedMessages);
  expect(posted.some(message => message.type === "compact_context")).toBe(false);
});

test("shows a command category and executes compact with optional instructions outside the chat stream", async ({ page }) => {
  await page.evaluate(async () => {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: "slash-command-session",
      transcript: [{
        type: "assistant",
        runId: "slash-command-history",
        spanId: "slash-command-history",
        content: "已有对话历史",
      }],
    });
    window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
      type: "agent_start",
      sessionId: "slash-command-session",
      runId: "previous-run",
    });
    window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
      type: "message_update",
      sessionId: "slash-command-session",
      runId: "previous-run",
      spanId: "previous-run:llm:1",
      eventSeq: 12,
      content: "上一轮已经完成",
    });
    window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
      type: "agent_end",
      sessionId: "slash-command-session",
      runId: "previous-run",
    });
    window.__qzCompactLifecycle = {
      compactId: "manual-compact-after-reload",
      delayMs: 500,
      summary: "数据库设计与未完成事项已经保留。",
    };
  });

  const input = page.locator("#input");
  await input.fill("/");
  const menu = page.locator(".input-slash-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-slash-filter="data_store"]')).toContainText("data:");
  await expect(menu.locator('[data-slash-filter="skill"]')).toContainText("skill:");
  await expect(menu.locator('[data-slash-filter="command"]')).toContainText("command: 1");

  const commandItem = menu.locator(".slash-item").filter({ hasText: "压缩上下文" });
  await expect(commandItem).toBeVisible();
  await commandItem.click();
  await expect(input).toHaveValue("/compact ");

  await input.fill("/压缩上下文 重点保留数据库设计和未完成事项");
  await page.locator("#btn-send").click();
  await expect(input).toHaveValue("");
  const compactCard = page.locator(".msg-compact").last();
  await expect(compactCard).toContainText("正在压缩上下文");
  await expect(compactCard).toContainText("正在整理较早的对话历史");
  await input.fill("压缩完成后再发送");
  await input.press("Enter");
  await expect(input).toHaveValue("压缩完成后再发送");
  await expect(compactCard).not.toContainText(/正在整理 \d+ 条/);
  await expect(compactCard).toContainText("上下文已压缩");
  await expect(compactCard).toContainText("数据库设计与未完成事项已经保留");
  await expect(page.locator(".case-toast")).toBeHidden();

  const posted = await page.evaluate(() => window.__qzPostedMessages);
  const compact = posted.find(message => message.type === "compact_context");
  expect(compact).toMatchObject({
    sessionId: "slash-command-session",
    instruction: "重点保留数据库设计和未完成事项",
  });
  expect(posted.some(message => message.type === "prompt" || message.type === "follow_up")).toBe(false);
  expect(posted.some(message => message.type === "get_messages" && message.sessionId === "slash-command-session")).toBe(true);
  expect(posted.some(message => message.type === "get_session_artifacts" && message.sessionId === "slash-command-session")).toBe(true);
});

test("only shows a toast when manual compact fails", async ({ page }) => {
  await page.evaluate(async () => {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: "slash-command-error-session",
      transcript: [{
        type: "assistant",
        runId: "slash-command-error-history",
        spanId: "slash-command-error-history",
        content: "等待压缩的对话历史",
      }],
    });
    window.__qzCompactFailure = {
      code: "CONTEXT_COMPACTION_FAILED",
      message: "模拟压缩失败",
    };
  });

  await page.locator("#input").fill("/compact");
  await page.locator("#btn-send").click();

  await expect(page.locator(".case-toast.visible")).toContainText("模拟压缩失败");
});

test("shows an error toast when the conversation has no compactable history", async ({ page }) => {
  await page.evaluate(async () => {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: "slash-command-no-segment-session",
      transcript: [{
        type: "assistant",
        runId: "slash-command-no-segment-history",
        spanId: "slash-command-no-segment-history",
        content: "只有一轮的对话",
      }],
    });
    window.__qzCompactResult = {
      compacted: false,
      reason: "no_compactable_segment",
    };
  });

  await page.locator("#input").fill("/compact");
  await page.locator("#btn-send").click();

  await expect(page.locator(".case-toast.visible")).toContainText("当前对话内容不足，暂时无法压缩上下文");
  await expect(page.locator("#input")).toHaveValue("");
});
