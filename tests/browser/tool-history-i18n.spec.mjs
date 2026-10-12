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
let historyPromise;
function historicalSnapshots() {
  return historyPromise ??= (async () => {
    const extension = await ensureTestExtension();
    const titles = [
      ["tabs.openPage", "Open tab", "新开页面"],
      ["tabs.navigatePage", "Navigate to URL", "页面跳转"],
      ["script.executeScript", "Run script", "执行脚本"],
    ];
    return Promise.all(languages.map(async ([language, chromeLocale]) => {
      const messages = JSON.parse(await readFile(resolve(extension, `_locales/${chromeLocale}/messages.json`), "utf8"));
      return { language, titles, messages };
    }));
  })();
}

for (const [language, chromeLocale] of languages) {
  test(`historical tool cards and family chips use the current language · ${language}`, async ({ page }, testInfo) => {
    const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
    const requestedPacks = [];
    page.on("request", request => { if (request.url().includes("/_locales/")) requestedPacks.push(request.url()); });
    await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages });
    await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    const expected = await page.evaluate(async histories => {
      await window.qingzhouConversationBenchmark.runSnapshotRender({ sessionId: "tool-history-language", transcript: [{ type: "user", text: "History" }] });
      const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const { createToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
      const { getToolMetadataCatalog } = await import("/extension/shared/tools/tool-metadata.js");
      const { chromeMessageId, decodeChromeMessage } = await import("/extension/shared/i18n/definition.js");
      const messages = document.querySelector("#messages");
      disposeRendererTree(messages);
      messages.replaceChildren();
      const names = ["open_tab", "navigate", "run_script"];
      const expected = names.map(name => {
        const metadata = getToolMetadataCatalog().tools[name];
        return metadata.shortTitle || metadata.title;
      });
      for (const { language: source, titles: keys, messages: sourceMessages } of histories) {
        const titles = keys.map(([key, en, zh]) => decodeChromeMessage(sourceMessages[chromeMessageId(key)]) || (source === "zh-CN" ? zh : en));
        const entries = names.flatMap((name, position) => Array.from({ length: 5 }, (_, index) => Object.freeze({
          type: "tool", id: `${source}-${name}-${index}`, name,
          title: titles[position],
          args: name === "run_script" ? { code: "return 42" } : { url: "https://example.com/research" },
          result: { ok: true, value: 42 },
        })));
        const group = createToolTimelineGroupElement({ entries }, { expanded: true });
        group.dataset.historySource = source;
        messages.append(group);
        for (const tool of entries.filter((_, index) => index % 5 === 0)) {
          const card = renderToolEvent(tool);
          card.dataset.historyCard = source;
          messages.append(card);
        }
      }
      const custom = renderToolEvent({ type: "tool", name: "open_tab", title: "My research tab", args: {}, result: {} });
      custom.dataset.customTitle = "true";
      messages.append(custom);
      return expected;
    }, await historicalSnapshots());
    for (const [source] of languages) {
      await expect(page.locator(`[data-history-source="${source}"] .tool-family-batch > span`)).toHaveText(expected);
      await expect(page.locator(`[data-history-card="${source}"] .tool-name`)).toHaveText(expected);
    }
    await expect(page.locator("[data-custom-title] .tool-name")).toHaveText("My research tab");
    expect(requestedPacks.every(url => url.includes(`/_locales/${chromeLocale}/`)), "only the current language pack is loaded").toBe(true);
    if (language === "zh-CN") await page.locator('[data-history-source="en"]').screenshot({ path: testInfo.outputPath("english-history-in-chinese.png"), animations: "disabled" });
  });
}
