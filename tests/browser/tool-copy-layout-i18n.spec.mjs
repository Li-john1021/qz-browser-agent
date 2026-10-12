import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [
  ["en", "en"], ["zh-CN", "zh_CN"], ["zh-TW", "zh_TW"], ["ja", "ja"],
  ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["de", "de"],
  ["pt-BR", "pt_BR"], ["ru", "ru"], ["ar", "ar"], ["hi", "hi"],
];
const output = resolve("tests/results/i18n/tool-copy-layout");

// Product labels must fit their own cells, not merely the page. Argument previews may
// intentionally use ellipsis, but titles, disclosure controls and diagnostics must remain readable.
async function audit(page, selector, name, testInfo) {
  const issues = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
    if (!element.checkVisibility({ checkVisibilityCSS: true })) return [];
    const box = element.getBoundingClientRect();
    const parent = element.parentElement.getBoundingClientRect();
    const text = element.textContent.trim();
    const failures = [];
    if (box.left < parent.left - 1 || box.right > parent.right + 1) failures.push({ text, kind: "outside-parent" });
    if (element.scrollWidth > element.clientWidth + 1) failures.push({ text, kind: "text-overflow" });
    // A Range catches ink painted outside a fixed grid track even when overflow is visible.
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const ink of range.getClientRects()) {
        if (ink.left < box.left - 1 || ink.right > box.right + 1) failures.push({ text, kind: "outside-cell" });
      }
    }
    return failures;
  }));
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, `${name}.json`), JSON.stringify({ issues }, null, 2));
  await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  await testInfo.attach(name, { path: resolve(output, `${name}.png`), contentType: "image/png" });
  expect.soft(issues, `${name}: product text fits its own layout cell`).toEqual([]);
}

for (const [language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`tool copy · ${language} · ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 320, height: 760 } });
    test("keeps registered tool titles, diagnostics and retry controls readable", async ({ page }, testInfo) => {
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await page.evaluate(async () => {
        await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId: "tool-copy", transcript: [{ type: "user", text: "Layout review" }] });
        const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
        const { getToolMetadataCatalog } = await import("/extension/shared/tools/tool-metadata.js");
        window.__toolCopy = {
          render(diagnostics = false) {
            const messages = document.querySelector("#messages");
            disposeRendererTree(messages);
            messages.replaceChildren();
            const tools = diagnostics ? [{ name: "external_tool", isError: true, result: {
              error: "Original provider error", code: "EXTERNAL_ERROR",
              diagnostic: { category: "External service", likelyCause: "Original cause", suggestedNextStep: "Original recovery advice" },
              details: { pluginId: "external.extension", script: "script.py", tool: "external_tool" },
            } }] : Object.keys(getToolMetadataCatalog().tools).map(name => ({ name, args: { timeout: 60 }, result: { ok: true } }));
            for (const tool of tools) {
              const card = renderToolEvent({ type: "tool", ...tool }, { expanded: diagnostics, lazyDetails: false });
              card.dataset.testToolName = tool.name;
              messages.append(card);
            }
            messages.scrollTop = 0;
          },
        };
      });
      for (const width of [320, 430]) {
        await page.setViewportSize({ width, height: 760 });
        const prefix = `${language}-${colorScheme}-${width}`;
        await page.evaluate(() => window.__toolCopy.render());
        expect(await page.locator(".tool-name").count()).toBeGreaterThan(30);
        // A short built-in action should not need the long-title wrapping fallback.
        const askUserLines = await page.locator('[data-test-tool-name="ask_user"] .tool-name').evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
        });
        expect.soft(askUserLines, `${prefix}: ask-user action stays on one line`).toBe(1);
        await audit(page, ".tool-name, .tool-caret", `${prefix}-titles`, testInfo);
        await page.evaluate(() => window.__toolCopy.render(true));
        await expect(page.locator(".tool-error-diagnostic-row")).toHaveCount(6);
        await audit(page, ".tool-error-diagnostic-row > span, .tool-error-diagnostic-row > b", `${prefix}-diagnostics`, testInfo);
        await page.evaluate(() => {
          window.qingzhouConversationBenchmark.configureVisualState({ running: true });
          window.qingzhouConversationBenchmark.dispatchBackgroundEvent({ type: "llm_retry", sessionId: "tool-copy", runId: "benchmark-visual-run", delayMs: 32000, maxRetries: 5 });
        });
        await expect(page.locator("#status-bar")).toBeVisible();
        await expect(page.locator("#status-text")).toContainText("32");
        await page.locator("#btn-abort").click({ trial: true });
        await audit(page, "#status-text, #context-usage, #btn-abort", `${prefix}-retry`, testInfo);
      }
    });
  });
}
