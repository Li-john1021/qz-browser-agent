import { expect, test } from "./sidepanel-fixtures.mjs";

test.describe("user message delivery", () => {
  test.use({ viewport: { width: 430, height: 620 } });

  test("keeps failed bubbles inline and retries the same message identity", async ({ page }) => {
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "message-delivery-session",
        transcript: [
          {
            type: "user",
            text: "需要可靠送达的消息",
            clientMessageId: "message-delivery-id",
            deliveryStatus: "failed",
          },
          { type: "assistant", content: "较早的回答" },
        ],
      });
    });

    const bubble = page.locator('[data-client-message-id="message-delivery-id"]');
    await expect(bubble.locator(".msg-user-delivery")).toHaveText("未发送·重发");
    await expect(bubble.locator("[data-action='edit-user-message']")).toHaveCount(0);

    await bubble.locator("[data-action='retry-user-message']").click();
    await expect(bubble.locator(".msg-user-delivery")).toHaveCount(0);

    const result = await page.evaluate(() => {
      const prompt = window.__qzPostedMessages.find(message => message.type === "prompt");
      const transcriptNodes = [...document.querySelectorAll("#messages > [data-transcript-key]")];
      return {
        prompt,
        lastClientMessageId: transcriptNodes.at(-1)?.dataset.clientMessageId || "",
      };
    });
    expect(result.prompt).toMatchObject({
      sessionId: "message-delivery-session",
      clientMessageId: "message-delivery-id",
      text: "需要可靠送达的消息",
      composerDraft: {
        sessionId: "message-delivery-session",
        messageId: "message-delivery-id",
      },
    });
    expect(result.lastClientMessageId).toBe("message-delivery-id");
  });

  test("does not decorate pending bubbles with loading chrome", async ({ page }) => {
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "pending-delivery-session",
        transcript: [{
          type: "user",
          text: "发送后立即出现",
          clientMessageId: "pending-delivery-id",
          deliveryStatus: "pending",
        }],
      });
    });

    const bubble = page.locator('[data-client-message-id="pending-delivery-id"]');
    await expect(bubble).toBeVisible();
    await expect(bubble.locator(".msg-user-delivery")).toHaveCount(0);
  });

  test("keeps a failed bubble while a later message is accepted", async ({ page }) => {
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "later-message-session",
        transcript: [{
          type: "user",
          text: "较早但未发送的消息",
          clientMessageId: "older-failed-message",
          deliveryStatus: "failed",
        }],
      });
    });
    await page.locator("#input").fill("继续发送的新消息");
    await page.locator("#input").press("Enter");

    await expect(page.locator(".msg-user")).toHaveCount(2);
    await expect(page.locator('[data-client-message-id="older-failed-message"] .msg-user-delivery')).toHaveText("未发送·重发");
    await expect(page.locator(".msg-user").last()).toContainText("继续发送的新消息");
  });

  test("reconciles a stale idle presentation when Background queues the message", async ({ page }) => {
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "atomic-admission-session",
        transcript: [{ type: "assistant", content: "上一轮已经展示结束。" }],
      });
      window.__qzPromptAcceptance = {
        disposition: "queued",
        duplicate: false,
        pendingSteerings: [],
      };
    });

    await page.locator("#input").fill("交接窗口里的下一条消息");
    await page.locator("#input").press("Enter");
    const clientMessageId = await page.evaluate(() => (
      window.__qzPostedMessages.findLast(message => message.type === "prompt")?.clientMessageId || ""
    ));
    expect(clientMessageId).not.toBe("");

    const queued = page.locator(`#queued-followups [data-client-message-id="${clientMessageId}"]`);
    await expect(queued).toContainText("交接窗口里的下一条消息");
    await expect(page.locator(`.msg-user[data-client-message-id="${clientMessageId}"]`)).toHaveCount(0);

    await page.evaluate(({ sessionId, clientMessageId: messageId }) => {
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "agent_start",
        sessionId,
        runId: "atomic-admission-run",
        eventSeq: 1,
      });
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_start",
        sessionId,
        runId: "atomic-admission-run",
        eventSeq: 2,
        clientMessageId: messageId,
        message: {
          role: "user",
          content: "交接窗口里的下一条消息",
          clientMessageId: messageId,
          _origin: "user",
        },
      });
    }, { sessionId: "atomic-admission-session", clientMessageId });

    await expect(queued).toHaveCount(0);
    await expect(page.locator(`.msg-user[data-client-message-id="${clientMessageId}"]`))
      .toContainText("交接窗口里的下一条消息");
  });
});
