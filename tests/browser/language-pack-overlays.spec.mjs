import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [
  ["en-US", "en", "en"], ["zh-CN", "zh-CN", "zh_CN"], ["zh-TW", "zh-TW", "zh_TW"],
  ["ja-JP", "ja", "ja"], ["ko-KR", "ko", "ko"], ["es-MX", "es", "es"],
  ["fr-FR", "fr", "fr"], ["de-DE", "de", "de"], ["pt-BR", "pt-BR", "pt_BR"],
  ["ru-RU", "ru", "ru"], ["ar-SA", "ar", "ar"], ["hi-IN", "hi", "hi"],
];
const artifacts = resolve("tests/results/i18n/overlays");
const config = { provider: "custom", model: "fixture-model", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions" };

async function auditOverlay(page, selector, name, testInfo) {
  const report = await page.locator(selector).evaluate(root => {
    const issues = [];
    const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const identity = element => element.id || `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]}`;
    const boxOf = element => element.getBoundingClientRect();
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (!visible(element) || element.closest("svg")) continue;
      const box = boxOf(element);
      if (element.matches("button, a") && (box.left < -1 || box.right > innerWidth + 1)) {
        issues.push({ kind: "outside", element: identity(element), left: box.left, right: box.right });
      }
      for (const text of element.childNodes) {
        if (text.nodeType !== Node.TEXT_NODE || !text.textContent.trim()) continue;
        const range = document.createRange(); range.selectNode(text);
        for (const ink of range.getClientRects()) {
          if (ink.width < 1 || ink.height < 1) continue;
          // Include labels and links, not only buttons: a label can paint over its
          // neighbor while every element and the document still fit the viewport.
          if (ink.left < box.left - 1 || ink.right > box.right + 1 || ink.top < box.top - 3 || ink.bottom > box.bottom + 3) {
            issues.push({ kind: "label-overflow", element: identity(element), text: text.textContent.trim(), ink: { left: ink.left, right: ink.right, top: ink.top, bottom: ink.bottom }, box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } });
          }
          for (let parent = element.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
            const clip = boxOf(parent), style = getComputedStyle(parent);
            if (style.overflowX !== "visible" && (ink.left < clip.left - 1 || ink.right > clip.right + 1)) {
              issues.push({ kind: "clipped-text", element: identity(element), clip: identity(parent) });
              break;
            }
          }
        }
      }
      if (element.matches("button:not(:disabled), a")) {
        // A multiline inline link's bounding-box center can lie in empty space;
        // each painted line fragment is the actual hit target.
        for (const target of element.getClientRects()) {
          if (target.top < 0 || target.bottom > innerHeight || target.width < 1) continue;
          const hit = document.elementFromPoint(target.left + target.width / 2, target.top + target.height / 2);
          if (!hit || !element.contains(hit)) issues.push({ kind: "covered-control", element: identity(element), by: hit && identity(hit) });
        }
      }
    }
    return { issues, documentWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  await mkdir(artifacts, { recursive: true });
  const path = resolve(artifacts, name);
  await writeFile(`${path}.json`, JSON.stringify(report, null, 2));
  await page.screenshot({ path: `${path}.png`, animations: "disabled" });
  await testInfo.attach(name, { path: `${path}.png`, contentType: "image/png" });
  expect.soft(report.issues, `${name}: translated labels fit and controls remain reachable`).toEqual([]);
  expect.soft(report.documentWidth).toBeLessThanOrEqual(report.width);
}

for (const [locale, language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`${language} overlays · ${colorScheme}`, () => {
    test.use({ locale, colorScheme, viewport: { width: 320, height: 760 } });
    test("keeps gallery metadata readable at narrow widths", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: locale, localeMessages, config });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
      for (const width of [320, 360, 430]) {
        await page.setViewportSize({ width, height: 760 });
        await page.evaluate(async () => {
          const { openImageGallery } = await import("/extension/sidepanel/ui/image-lightbox.js");
          const { t } = await import("/extension/capabilities/data/i18n.js");
          const image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#638f87"/></svg>');
          const fields = [[t("source"), "https://example.test/image.png"], [t("information"), "80 × 60 · image/png · 10 KB"], [t("captureMethod"), "page · screenshot"]];
          openImageGallery([{ src: image, title: "Original image title", fields }, { src: image, title: "Another image", fields }], 0, { label: t("collectionPreview") });
        });
        await expect(page.locator(".data-image-gallery-stage img")).toBeVisible();
        await auditOverlay(page, ".data-image-gallery-overlay", `${language}-${colorScheme}-${width}-gallery`, testInfo);
        await page.locator(".data-image-gallery-nav.next").click();
        await expect(page.locator(".data-image-gallery-meta-count")).toHaveText("2/2");
        await page.locator(".data-image-gallery-close").click();
        await expect(page.locator(".data-image-gallery-overlay")).toHaveCount(0);
      }
      expect(await page.evaluate(() => window.__qzPostedMessages.some(message => message.type === "prompt"))).toBe(false);
    });
  });
}
