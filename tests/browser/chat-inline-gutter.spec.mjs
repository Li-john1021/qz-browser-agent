import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test(`chat stream keeps equal inline insets and a complete panel frame in ${colorScheme} mode`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 532, height: 620 });
    await page.evaluate(async ({ sessionId }) => {
      const transcript = [
        { type: "user", text: "213412341234" },
        {
          type: "thinking",
          runId: `${sessionId}-run`,
          spanId: `${sessionId}-thinking`,
          text: "用于验证满宽思考面板四周边界在滚动状态下保持完整。",
        },
        {
          type: "assistant",
          runId: `${sessionId}-run`,
          spanId: `${sessionId}-assistant`,
          content: "边界验证完成。",
        },
        ...Array.from({ length: 17 }, (_, index) => ({
          type: "assistant",
          runId: `${sessionId}-run-${index}`,
          spanId: `${sessionId}-assistant-${index}`,
          content: `第 ${index + 1} 条消息用于验证滚动状态下的左右留白。`,
        })),
      ];
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId,
        title: "对话左右留白",
        transcript,
      });
    }, { sessionId: `chat-inline-gutter-${colorScheme}` });
    await page.locator(".thinking-group-summary").click();

    const metrics = await page.locator("#messages").evaluate((messages) => {
      const lane = messages.querySelector(".msg");
      const outlinedPanel = messages.querySelector(".msg-thinking-group");
      const containerRect = messages.getBoundingClientRect();
      const laneRect = lane?.getBoundingClientRect();
      const panelRect = outlinedPanel?.getBoundingClientRect();
      const style = getComputedStyle(messages);
      return {
        overflow: messages.scrollHeight > messages.clientHeight,
        leftInset: laneRect ? laneRect.left - containerRect.left : null,
        rightInset: laneRect ? containerRect.right - laneRect.right : null,
        panelLeftInset: panelRect ? panelRect.left - containerRect.left : null,
        panelRightInset: panelRect ? containerRect.right - panelRect.right : null,
        outlineSafeLeft: Number.parseFloat(style.paddingLeft),
        outlineSafeRight: Number.parseFloat(style.paddingRight),
      };
    });

    expect(metrics.overflow).toBe(true);
    expect(metrics.leftInset).not.toBeNull();
    expect(Math.abs(metrics.leftInset - metrics.rightInset)).toBeLessThanOrEqual(1);
    expect(metrics.panelLeftInset).toBeGreaterThanOrEqual(1);
    expect(metrics.panelRightInset).toBeGreaterThanOrEqual(1);
    expect(Math.abs(metrics.panelLeftInset - metrics.panelRightInset)).toBeLessThanOrEqual(1);
    expect(metrics.outlineSafeLeft).toBe(10);
    expect(metrics.outlineSafeRight).toBe(10);
    await testInfo.attach(`chat-inline-gutter-${colorScheme}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });
}
