import { expect, test } from "./fixtures.mjs";

for (const locale of ["zh-CN", "en-US"]) {
  test.describe(`Logs language ${locale}`, () => {
    test.use({ locale });

    test("localizes loading and empty states while preserving log content", async ({ page }) => {
      await page.goto("/tests/git-skill-source/probe.html");
      const result = await page.evaluate(async () => {
        const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
        const parsed = new DOMParser().parseFromString(html, "text/html");
        document.body.replaceChildren(document.importNode(parsed.querySelector("#logs-panel"), true));
        const { createLogsFeature } = await import("/extension/capabilities/diagnostics/workspace/logs-feature.js");
        const feature = createLogsFeature({ root: document, isEnabled: () => true });
        const content = document.querySelector("#logs-content");
        feature.load();
        const loading = content.textContent;
        feature.render([]);
        const empty = content.textContent;
        feature.render(["外部日志: Save configuration <b>unchanged</b>", "Raw error: undefined"]);
        const logs = content.textContent;
        const injected = content.querySelectorAll("b").length;
        feature.dispose();
        return { loading, empty, logs, injected };
      });
      expect(result.loading).toBe(locale === "zh-CN" ? "加载中…" : "Loading…");
      expect(result.empty).toBe(locale === "zh-CN" ? "暂无日志" : "No logs yet");
      expect(result.logs).toBe("外部日志: Save configuration <b>unchanged</b>\nRaw error: undefined");
      expect(result.injected).toBe(0);
    });
  });
}

test("Logs capability can dispose and remount without duplicate actions or late feedback", async ({ page }) => {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(document.importNode(parsed.querySelector("#logs-panel"), true));
    document.querySelector("#logs-panel").classList.remove("hidden");
    const { createLogsFeature } = await import("/extension/capabilities/diagnostics/workspace/logs-feature.js");
    const sent = [];
    const options = { root: document, send: message => sent.push(message), isEnabled: () => true };
    const first = createLogsFeature(options);
    first.load();
    first.flashStatus("old feedback");
    first.dispose();
    const second = createLogsFeature(options);
    second.render(["new mount"]);
    first.render(["late old event"]);
    window.__logs = { sent, second };
  });
  await expect(page.locator("#logs-content")).toHaveText("new mount");
  await page.locator("#btn-refresh-logs").click();
  await page.locator("#btn-clear-logs").click();
  expect(await page.evaluate(() => window.__logs.sent)).toEqual([{ type: "get_trace" }, { type: "get_trace" }, { type: "clear_trace" }]);
  await page.evaluate(() => { window.__logs.second.dispose(); document.querySelector("#btn-refresh-logs").click(); });
  expect(await page.evaluate(() => window.__logs.sent.length)).toBe(3);
});
