import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [
  ["en", "en"], ["zh-CN", "zh_CN"], ["zh-TW", "zh_TW"], ["ja", "ja"],
  ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["de", "de"],
  ["pt-BR", "pt_BR"], ["ru", "ru"], ["ar", "ar"], ["hi", "hi"],
];

for (const [language, chromeLocale] of languages) {
  test(`compact tools and both timeline levels remain readable · ${language}`, async ({ page }, testInfo) => {
    const messages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
    await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages: messages });
    await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await page.evaluate(async () => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId: "compact-tools", transcript: [{ type: "user", text: "Tool labels" }] });
      const { createToolTimelineGroupElement, ensureToolTimelineActiveSlot } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
      const { getToolMetadataCatalog } = await import("/extension/shared/tools/tool-metadata.js");
      const { disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const cases = Object.entries(getToolMetadataCatalog().tools).flatMap(([name, metadata]) => [
        { name, args: {} },
        ...Object.keys(metadata.titleRule?.values || {}).map(action => ({ name, args: { [metadata.titleRule.field]: action } })),
        ...Object.keys(metadata.actionLabels || {}).map(action => ({ name, args: { action } })),
      ]);
      const tool = (item, index) => ({ type: "tool", id: `compact-${index}`, ...item,
        args: { url: "https://example.com/research", target: `Target ${index}`, ...item.args }, result: { ok: true },
      });
      const entries = cases.map(tool);
      const host = document.querySelector("#messages");
      disposeRendererTree(host);
      const group = createToolTimelineGroupElement({ entries }, { expanded: true });
      const sample = createToolTimelineGroupElement({ entries: ["navigate", "read_article", "run_script"]
        .flatMap(name => Array.from({ length: 5 }, () => ({ name }))).map(tool) }, { expanded: true });
      sample.dataset.compactSample = "true";
      host.replaceChildren(sample, group);
      window.auditCompactTools = () => {
        const issues = new Map();
        const inspect = root => {
          for (const label of root.querySelectorAll(".tool-family-title, .tool-family-batch > span")) {
            if (!label.checkVisibility()) continue;
            const box = label.getBoundingClientRect();
            const parent = label.parentElement.getBoundingClientRect();
            const text = label.textContent.trim();
            if (label.scrollWidth > label.clientWidth + 1 || box.left < parent.left - 1 || box.right > parent.right + 1) {
              issues.set(text, { text, width: box.width, needed: label.scrollWidth });
            }
          }
        };
        inspect(sample);
        entries.forEach((_, index) => { ensureToolTimelineActiveSlot(group, index); inspect(group); });
        return [...issues.values()];
      };
    });
    if (language === "en") {
      await expect(page.locator('[data-compact-sample] .tool-family-title')).toHaveText(["Navigate", "Collect", "Process"]);
      await expect(page.locator('[data-compact-sample] .tool-family-batch > span').first()).toHaveText("Go to URL");
    }
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 360, 430]) {
        await page.setViewportSize({ width, height: 900 });
        expect.soft(await page.evaluate(() => window.auditCompactTools()), `${language}/${colorScheme}/${width}`).toEqual([]);
        if (width === 360) await page.locator("[data-compact-sample]").screenshot({ path: testInfo.outputPath(`${language}-${colorScheme}.png`), animations: "disabled" });
      }
    }
  });
}
