import { expect, test } from "./sidepanel-fixtures.mjs";

test.describe("historical message edit viewport stability", () => {
  test.use({ viewport: { width: 430, height: 620 } });

  test("keeps the conversation anchored while a capped edit textarea remeasures", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const sessionId = "historical-edit-viewport-session";
      const targetId = "historical-edit-viewport-target";
      const transcript = [];
      for (let index = 0; index < 34; index += 1) {
        transcript.push({
          type: "user",
          text: `历史问题 ${index + 1}`,
          clientMessageId: `historical-edit-user-${index + 1}`,
        });
        transcript.push({
          type: "assistant",
          content: `历史回答 ${index + 1}：${"用于制造长对话。".repeat(4)}`,
          spanId: `historical-edit-assistant-${index + 1}`,
          runId: `historical-edit-run-${index + 1}`,
        });
      }
      const longText = Array.from(
        { length: 12 },
        (_item, index) => `原请求第 ${index + 1} 行。`,
      ).join("\n");
      transcript.push({
        type: "user",
        text: longText,
        clientMessageId: targetId,
      });
      transcript.push({
        type: "assistant",
        content: "目标消息之后的短回答，用于保留底部滚动空间。",
        spanId: "historical-edit-tail-assistant",
        runId: "historical-edit-tail-run",
      });

      await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId, transcript });
      await frames(4);

      const messages = document.querySelector("#messages");
      const target = document.querySelector(`[data-client-message-id="${targetId}"]`);
      const editButton = target?.querySelector("[data-action='edit-user-message']");
      messages.scrollTop = messages.scrollHeight;
      await frames(2);

      const beforeEdit = measure(messages, target, null);
      editButton?.click();
      await frames(4);
      const textarea = target?.querySelector(".msg-user-edit-input");
      const afterEdit = measure(messages, target, textarea);
      pauseTailNearBottom(messages, 12);
      await frames(2);

      const beforeInput = measure(messages, target, textarea);
      if (textarea) {
        textarea.value = `${textarea.value}补充`;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const immediateAfterInput = measure(messages, target, textarea);
      await frames(4);
      const settledAfterInput = measure(messages, target, textarea);
      const beforeBurst = measure(messages, target, textarea);
      let maxBurstDrift = 0;
      for (let index = 0; index < 16; index += 1) {
        textarea.value = `${textarea.value}${index}`;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        maxBurstDrift = Math.max(
          maxBurstDrift,
          Math.abs(target.getBoundingClientRect().top - beforeBurst.anchorTop),
        );
      }
      await frames(4);
      const settledAfterBurst = measure(messages, target, textarea);
      const cancelButton = target?.querySelector("[data-action='cancel-user-edit']");
      const beforeCancel = measure(messages, target, textarea);
      cancelButton?.click();
      const immediateAfterCancel = measure(messages, target, null);
      await frames(4);
      const settledAfterCancel = measure(messages, target, null);

      return {
        targetFound: Boolean(target),
        editButtonFound: Boolean(editButton),
        textareaFound: Boolean(textarea),
        cancelButtonFound: Boolean(cancelButton),
        beforeEdit,
        afterEdit,
        beforeInput,
        immediateAfterInput,
        settledAfterInput,
        beforeBurst,
        maxBurstDrift,
        settledAfterBurst,
        beforeCancel,
        immediateAfterCancel,
        settledAfterCancel,
      };

      function pauseTailNearBottom(element, gap) {
        element.dispatchEvent(new WheelEvent("wheel", {
          deltaY: -80,
          bubbles: true,
          cancelable: true,
        }));
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        element.scrollTop = Math.max(0, max - gap);
        element.dispatchEvent(new Event("scroll"));
      }

      function measure(element, anchor, input) {
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
        return {
          scrollTop: element.scrollTop,
          maxScrollTop: max,
          bottomGap: max - element.scrollTop,
          anchorTop: anchor?.getBoundingClientRect().top ?? null,
          textareaHeight: input?.getBoundingClientRect().height ?? null,
        };
      }

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
    expect(result.cancelButtonFound, JSON.stringify(result, null, 2)).toBe(true);
    expect(
      Math.abs(result.afterEdit.anchorTop - result.beforeEdit.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(result.beforeInput.textareaHeight, JSON.stringify(result, null, 2)).toBeGreaterThanOrEqual(179);
    expect(result.beforeInput.bottomGap, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(14);
    expect(
      Math.abs(result.immediateAfterInput.anchorTop - result.beforeInput.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(result.settledAfterInput.anchorTop - result.beforeInput.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(result.maxBurstDrift, JSON.stringify(result, null, 2)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(result.settledAfterBurst.anchorTop - result.beforeBurst.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(result.immediateAfterCancel.anchorTop - result.beforeCancel.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(result.settledAfterCancel.anchorTop - result.beforeCancel.anchorTop),
      JSON.stringify(result, null, 2),
    ).toBeLessThanOrEqual(1);
  });
});
