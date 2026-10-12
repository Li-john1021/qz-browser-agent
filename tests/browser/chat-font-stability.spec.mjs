import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [["en", "en"], ["fr", "fr"], ["ja", "ja"], ["ko", "ko"], ["zh-CN", "zh_CN"], ["ar", "ar"]];
const preview = "I will inspect the next page and compare the findings. 次のページを確認します。继续检查页面。";

for (const [language, locale] of languages) for (const colorScheme of ["light", "dark"]) {
  test(`streamed summaries keep text styles and avoid per-preview GPU layers · ${language} · ${colorScheme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 430, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${locale}/messages.json`), "utf8"));
    await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages });
    await page.goto("/extension/sidepanel/sidepanel.html");
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({
        sessionId: "font-stability",
        transcript: [
          { type: "user", text: "Compare the weather in major cities.", clientMessageId: "question" },
          { type: "assistant", content: "A stable reply. Une réponse. 日本語 한국어 中文 العربية", spanId: "stable-reply", runId: "font-run" },
        ],
      });
    });
    const cdp = await page.context().newCDPSession(page);
    let layers = [];
    cdp.on("LayerTree.layerTreeDidChange", event => { layers = event.layers || []; });
    await cdp.send("LayerTree.enable");
    const samples = await page.evaluate(async preview => {
      const api = window.qingzhouConversationBenchmark;
      const stable = document.querySelector(".msg-assistant .msg-content");
      const styles = () => {
        const css = getComputedStyle(stable);
        return [css.fontFamily, css.fontWeight, css.fontSize, css.lineHeight, css.webkitFontSmoothing];
      };
      const initial = styles();
      const changed = [];
      let frames = 0, sampling = true;
      const sample = () => {
        frames++;
        if (!stable.isConnected || JSON.stringify(styles()) !== JSON.stringify(initial)) changed.push(styles());
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const dispatch = event => api.dispatchBackgroundEvent({ sessionId: "font-stability", runId: "font-run", ...event });
      dispatch({ type: "agent_start" });
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "thinking_update", spanId: `thinking-${i}`, thinking: preview });
        dispatch({ type: "tool_execution_start", toolName: "open_tab", toolCallId: `tool-${i}`, args: { url: "https://example.com" } });
        dispatch({ type: "tool_execution_end", toolName: "open_tab", toolCallId: `tool-${i}`, result: { ok: true, tabId: i + 1 } });
        dispatch({ type: "message_start", spanId: `reply-${i}`, message: { role: "assistant", content: "" } });
        dispatch({ type: "message_update", spanId: `reply-${i}`, content: `Weather findings ${i + 1}.` });
        dispatch({ type: "message_end", spanId: `reply-${i}`, message: { role: "assistant", content: `Weather findings ${i + 1}.` } });
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      dispatch({ type: "agent_end" });
      await new Promise(resolve => setTimeout(resolve, 300));
      sampling = false;
      const messages = document.querySelector("#messages");
      return { initial, changed, frames, overflowing: messages.scrollHeight > messages.clientHeight };
    }, preview);
    expect(samples.frames).toBeGreaterThan(10);
    expect(samples.changed).toEqual([]);
    expect(samples.overflowing).toBe(true);
    await expect(page.locator(".thinking-group-preview-text")).toHaveCount(10);
    await expect(page.locator("#messages")).toContainText("Weather findings 10.");
    // Query real compositing output, rather than just asserting CSS declarations.
    const previewLayers = [];
    for (const layer of layers.filter(layer => layer.drawsContent && layer.backendNodeId)) {
      const { node } = await cdp.send("DOM.describeNode", { backendNodeId: layer.backendNodeId });
      if (node.attributes?.includes("thinking-group-preview-text")) previewLayers.push(layer.layerId);
    }
    expect(previewLayers, "completed summaries must not retain individual compositing layers").toEqual([]);
    await testInfo.attach("text-stability.json", { body: JSON.stringify(samples), contentType: "application/json" });

    // Preserve layout, labels and borders. Preview glyph antialiasing may differ
    // intentionally when removing its dedicated compositing layer.
    const summary = page.locator(".thinking-group-summary").last();
    await summary.scrollIntoViewIfNeeded();
    await expect(summary).toBeVisible();
    const geometry = () => summary.locator(".thinking-group-preview-text").evaluate(node => {
      const box = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { x: box.x, y: box.y, width: box.width, height: box.height, font: css.font };
    });
    const currentGeometry = await geometry();
    const screenshotOptions = { animations: "disabled", mask: [summary.locator(".thinking-group-preview")] };
    const current = await summary.screenshot(screenshotOptions);
    const legacyStyle = await page.addStyleTag({ content: ".thinking-group-preview-text { transform: translate3d(var(--thinking-preview-offset, 0px), 0, 0); will-change: transform; }" });
    const legacy = await summary.screenshot(screenshotOptions);
    expect(await geometry()).toEqual(currentGeometry);
    await legacyStyle.evaluate(node => node.remove());
    await testInfo.attach("summary-current.png", { body: current, contentType: "image/png" });
    await testInfo.attach("summary-previous.png", { body: legacy, contentType: "image/png" });
    expect(current.equals(legacy), "summary pixels outside preview glyphs stay unchanged").toBe(true);
    await cdp.detach();
  });
}
