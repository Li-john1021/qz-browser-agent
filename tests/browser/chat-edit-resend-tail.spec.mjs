import { expect, test } from "./sidepanel-fixtures.mjs";

test.describe("edited message resend tail", () => {
  test.use({ viewport: { width: 430, height: 620 } });

  test("returns to the live tail after resending an edited message", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const sessionId = "edited_message_tail_session";
      const runId = "benchmark-visual-run";
      const clientMessageId = "edited-message-target";
      const transcript = [];
      for (let index = 0; index < 8; index += 1) {
        transcript.push({
          type: "user",
          text: `历史问题 ${index + 1}`,
          clientMessageId: `edited-tail-history-user-${index + 1}`,
        });
        transcript.push({
          type: "assistant",
          content: `历史回答 ${index + 1}：${"用于制造可滚动对话。".repeat(3)}`,
          spanId: `edited-tail-history-assistant-${index + 1}`,
          runId: `edited-tail-history-run-${index + 1}`,
        });
      }
      transcript.push({
        type: "user",
        text: "请重新整理这份结论",
        clientMessageId,
      });
      transcript.push({
        type: "assistant",
        content: Array.from(
          { length: 28 },
          (_item, index) => `原回答第 ${index + 1} 段：这部分会在编辑重发时被截断。`,
        ).join("\n\n"),
        spanId: "edited-tail-old-assistant",
        runId: "edited-tail-old-run",
      });

      await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId, transcript });
      await frames(4);

      const messages = document.querySelector("#messages");
      const target = document.querySelector(`[data-client-message-id="${clientMessageId}"]`);
      messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true }));
      target?.scrollIntoView({ block: "center" });
      messages.dispatchEvent(new Event("scroll"));
      await frames(3);

      const editButton = target?.querySelector("[data-action='edit-user-message']");
      editButton?.click();
      await frames(2);
      const textarea = target?.querySelector(".msg-user-edit-input");
      if (textarea) {
        textarea.value = "请重新整理这份结论，并补充风险项";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      target?.querySelector("[data-action='submit-user-edit']")?.click();
      const immediateBottomGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
      await frames(5);

      // Editing contracts the old bubble and replaces the transcript. Browsers may
      // report that layout correction as a scroll without any user scroll gesture.
      // It must not revoke the live-tail intent established by the resend.
      messages.scrollTop = Math.max(0, messages.scrollTop - 72);
      const layoutDriftRequestedGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
      messages.dispatchEvent(new Event("scroll"));
      await frames(3);
      const layoutDriftBottomGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight;

      await new Promise(resolve => setTimeout(resolve, 1400));

      window.qingzhouConversationBenchmark.configureVisualState({ running: true });
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "thinking_update",
        sessionId,
        runId,
        eventSeq: 1,
        thinking: "Use the weather skill to check tomorrow's weather.",
      });
      await frames(6);
      const thinking = document.querySelector(".msg-thinking-group");
      const thinkingRect = thinking?.getBoundingClientRect();
      const messagesRect = messages.getBoundingClientRect();
      const thinkingBottomGap = messages.scrollHeight - messages.scrollTop - messages.clientHeight;

      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_start",
        sessionId,
        runId,
        eventSeq: 2,
        spanId: "edited-tail-new-assistant",
        message: { role: "assistant", content: "" },
      });
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        type: "message_update",
        sessionId,
        runId,
        eventSeq: 3,
        spanId: "edited-tail-new-assistant",
        content: Array.from(
          { length: 36 },
          (_item, index) => `新回答第 ${index + 1} 段：持续输出用于验证编辑重发后的追尾。`,
        ).join("\n\n"),
      });
      await frames(8);

      const editedBubble = document.querySelector(`[data-client-message-id="${clientMessageId}"]`);
      return {
        targetFound: Boolean(target),
        editButtonFound: Boolean(editButton),
        textareaFound: Boolean(textarea),
        editedText: editedBubble?.querySelector(".user-text")?.textContent || "",
        immediateBottomGap,
        layoutDriftRequestedGap,
        layoutDriftBottomGap,
        thinkingFound: Boolean(thinking),
        thinkingBottom: thinkingRect?.bottom ?? null,
        messagesBottom: messagesRect.bottom,
        thinkingBottomGap,
        bottomGap: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        clientHeight: messages.clientHeight,
      };

      function frames(count) {
        return new Promise(resolve => {
          const step = remaining => requestAnimationFrame(() => (
            remaining <= 1 ? resolve() : step(remaining - 1)
          ));
          step(Math.max(1, count));
        });
      }
    });

    expect(result.targetFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.editButtonFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.textareaFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.editedText, JSON.stringify(result, null, 2)).toContain("补充风险项");
    expect(result.immediateBottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(28);
    expect(result.layoutDriftRequestedGap, JSON.stringify(result, null, 2)).toBeGreaterThan(28);
    expect(result.layoutDriftBottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(28);
    expect(result.thinkingFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.thinkingBottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(28);
    expect(result.thinkingBottom, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(result.messagesBottom);
    expect(result.bottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(28);
  });
});
