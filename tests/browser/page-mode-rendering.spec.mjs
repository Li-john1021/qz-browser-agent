import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

for (const language of ["zh-CN", "en", "zh-TW", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "ar", "hi"]) {
  test(`page modes render in ${language}, including offline output and both themes`, async ({ page }) => {
    const localeMessages = JSON.parse(await readFile(join(await ensureTestExtension(), "_locales", language.replaceAll("-", "_"), "messages.json"), "utf8"));
    await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      const results = await page.evaluate(async () => {
        const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
        const { t } = await import("/extension/capabilities/tabs/i18n.js");
        const messages = document.querySelector("#messages");
        disposeRendererTree(messages); messages.replaceChildren();
        return [false, true].flatMap(staticOutput => ["mobile", "desktop"].map(mode => {
          const root = renderToolEvent({ name: "set_page_mode", args: { mode }, result: { tabId: 1, pageMode: mode, changed: true, reloaded: true } },
            { expanded: true, lazyDetails: false, static: staticOutput });
          messages.append(root);
          const details = root.querySelector(".tool-details");
          return { text: details.textContent, title: t("modeChanged"), mode: t(mode === "mobile" ? "mobileMode" : "desktopMode"),
            overflow: details.scrollWidth > details.clientWidth + 1,
            fallback: root.querySelectorAll(".tool-renderer-fallback").length };
        }));
      });
      for (const result of results) {
        expect(result.text).toContain(result.title);
        expect(result.text).toContain(result.mode);
        expect(result.fallback).toBe(0);
        expect(result.overflow).toBe(false);
      }
    }
  });
}
