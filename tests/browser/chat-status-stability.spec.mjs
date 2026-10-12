import { expect, test } from "./sidepanel-fixtures.mjs";

for (const colorScheme of ["light", "dark"]) {
  test(`status bar suppresses short tool phases in ${colorScheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "status-stability",
        transcript: [{ type: "user", content: "检查页面" }],
      });
    });
    await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
    const dispatch = event => page.evaluate(event => {
      window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
        sessionId: "status-stability", runId: "status-run", ...event,
      });
    }, event);
    const status = page.locator("#status-text");
    await dispatch({ type: "agent_start" });
    await expect(status).toContainText("思考中");
    await page.evaluate(() => {
      window.__statusPhases = [];
      new MutationObserver(() => window.__statusPhases.push(document.querySelector("#status-text").textContent))
        .observe(document.querySelector("#status-text"), { childList: true });
    });
    await dispatch({ type: "tool_execution_start", toolName: "read_page", toolCallId: "quick-tool" });
    await page.clock.runFor(100);
    await dispatch({ type: "tool_execution_end", toolName: "read_page", toolCallId: "quick-tool", result: {} });
    await dispatch({ type: "turn_start" });
    await page.clock.runFor(400);
    await expect(status).toContainText("思考中");
    expect(await page.evaluate(() => window.__statusPhases.some(text => text.includes("调用")))).toBe(false);

    await dispatch({ type: "tool_execution_start", toolName: "read_page", toolCallId: "slow-tool" });
    await page.clock.runFor(300);
    await expect(status).toContainText("调用");
    await testInfo.attach(`status-${colorScheme}.png`, { body: await page.screenshot(), contentType: "image/png" });
    await dispatch({ type: "turn_start" });
    await dispatch({ type: "llm_rate_wait" });
    await expect(status).toContainText("模型请求正在排队");
    await page.clock.runFor(400);
    await expect(status).toContainText("模型请求正在排队");
    await dispatch({ type: "agent_end" });
    await expect(page.locator("#status-bar")).toBeHidden();
    await page.clock.runFor(400);
    await expect(page.locator("#status-bar")).toBeHidden();
  });
}
