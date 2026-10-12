import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [["en", "en"], ["zh-CN", "zh_CN"], ["zh-TW", "zh_TW"], ["ja", "ja"], ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["de", "de"], ["pt-BR", "pt_BR"], ["ru", "ru"], ["ar", "ar"], ["hi", "hi"]];
const screenshots = resolve("tests/results/i18n/data-copy-layout");

async function audit(page, selector, name, testInfo) {
  const result = await page.locator(selector).evaluate(root => {
    const issues = [];
    const visible = element => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    for (const control of root.querySelectorAll("button, [role=button], select")) {
      if (!visible(control) || control.closest(".tabulator")) continue;
      const box = control.getBoundingClientRect();
      if (box.left < -1 || box.right > innerWidth + 1) issues.push({ kind: "outside", id: control.id, text: control.textContent.trim() });
      for (const label of control.querySelectorAll("span")) {
        if (!visible(label) || label.closest("svg") || !label.textContent.trim()) continue;
        if (label.scrollWidth > label.clientWidth + 1 && getComputedStyle(label).overflowX !== "visible") {
          issues.push({ kind: "truncated-action", id: control.id, text: label.textContent.trim(), needed: label.scrollWidth, available: label.clientWidth });
        }
      }
      const walk = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walk.nextNode())) {
        if (!text.textContent.trim() || text.parentElement.closest("svg")) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        if ([...range.getClientRects()].some(ink => ink.left < box.left - 1 || ink.right > box.right + 1)) {
          issues.push({ kind: "action-overflow", id: control.id, text: text.textContent.trim() });
        }
      }
    }
    for (const count of root.querySelectorAll(".data-image-selection-count")) {
      if (visible(count) && count.scrollWidth > count.clientWidth + 1) issues.push({ kind: "truncated-count", text: count.textContent.trim() });
    }
    for (const label of root.querySelectorAll("[data-data-action-label]")) {
      if (!visible(label)) continue;
      const lines = label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight);
      if (lines > 2.1) issues.push({ kind: "action-too-many-lines", text: label.textContent.trim(), lines });
    }
    return { issues, pageWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: resolve(screenshots, `${name}.png`), animations: "disabled" });
  await writeFile(resolve(screenshots, `${name}.json`), JSON.stringify(result, null, 2));
  await testInfo.attach(name, { path: resolve(screenshots, `${name}.png`), contentType: "image/png" });
  expect.soft(result.issues, name).toEqual([]);
  expect.soft(result.pageWidth).toBeLessThanOrEqual(result.width);
}

for (const [language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`${language} Data copy · ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 320, height: 900 } });
    test("keeps data import, table actions and active filters readable", async ({ page }, testInfo) => {
      test.setTimeout(60_000);
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      // Exercise the normal workspace startup: resource events require its connected Port.
      await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, uiLanguage: language, localeMessages });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
      await page.locator('[data-tab="data"]').click();
      const empty = page.locator("#data-empty");
      await expect(empty).toBeVisible();
      const builtInCopy = {
        en: { noDataTables: "No tables yet", createTableHint: "Import data with + above, or ask AI to create a table." },
        "zh-CN": { noDataTables: "暂无数据表", createTableHint: "点击上方 + 导入数据，或让 AI 创建数据表。" },
      };
      for (const key of ["noDataTables", "createTableHint"]) {
        const copy = builtInCopy[language]?.[key] || await page.evaluate(async ({ localeMessages, key }) => {
          const { chromeMessageId, decodeChromeMessage } = await import("/extension/shared/i18n/definition.js");
          return decodeChromeMessage(localeMessages[chromeMessageId(`data.${key}`)]);
        }, { localeMessages, key });
        expect(copy, `${language}: ${key} has a translation`).toBeTruthy();
        await expect(empty.locator(`[data-i18n="data.${key}"]`)).toHaveText(copy);
      }
      for (const width of [320, 360, 430]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await empty.evaluate(element => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          const textBounds = [...element.querySelectorAll("p")].flatMap(paragraph => {
            const range = document.createRange();
            range.selectNodeContents(paragraph);
            return [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right }));
          });
          return {
            centered: style.textAlign === "center",
            padding: [style.paddingTop, style.paddingInlineStart],
            overflow: textBounds.some(rect => rect.left < bounds.left + 19 || rect.right > bounds.right - 19),
          };
        });
        expect(layout).toEqual({ centered: true, padding: ["40px", "20px"], overflow: false });
        await audit(page, "#data-panel", `${language}-${colorScheme}-${width}-empty`, testInfo);
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await page.locator("#btn-import-data").click();
      await expect(page.locator("#data-import-panel")).toBeVisible();
      await audit(page, "#data-import-panel", `${language}-${colorScheme}-import`, testInfo);
      await page.locator("#data-import-table").fill("Original / 原文 / نص");
      await page.locator("#data-import-text").fill(JSON.stringify([{ code: "alpha", quantity: 2 }, { code: "beta", quantity: 3 }]));
      await page.locator("#btn-import-text").click();
      await expect(page.locator("#data-preview")).toContainText("alpha");
      await expect(empty).toBeHidden();
      await audit(page, "#data-panel", `${language}-${colorScheme}-table`, testInfo);
      await page.locator("#btn-data-columns").click();
      await expect(page.locator("#data-columns-menu")).toBeVisible();
      await audit(page, "#data-panel", `${language}-${colorScheme}-columns`, testInfo);
      await page.locator("#btn-data-columns").click();
      await page.locator("#btn-data-table-actions").click();
      await audit(page, "#data-panel", `${language}-${colorScheme}-actions`, testInfo);
      await page.locator("#btn-data-table-actions").click();
      await page.locator('[data-filter-field="code"]').click();
      await expect(page.locator("[data-data-grid-filter-popover]")).toBeVisible();
      await audit(page, "#data-panel", `${language}-${colorScheme}-filter`, testInfo);
      await page.locator("[data-data-grid-filter-input]").fill("alpha");
      await expect(page.locator("#data-preview .tabulator-row")).toHaveCount(1);
      await page.locator("[data-data-grid-filter-close]").click();
      await audit(page, "#data-panel", `${language}-${colorScheme}-filtered`, testInfo);
      await page.locator("#btn-clear-data-filters").click();
      await expect(page.locator("#data-preview .tabulator-row")).toHaveCount(2);
      await expect(page.locator("#data-table-search")).toHaveValue("Original / 原文 / نص");
      await page.locator(".data-grid-row-check").first().check();
      await audit(page, "#data-panel", `${language}-${colorScheme}-selected-row`, testInfo);
      await page.evaluate(async () => {
        const { insertDataRows, updateDataTableMetadata } = await import("/extension/shared/data-store.js");
        await insertDataRows("Original images / 原图 / صور", [{ title: "Original image", src: "https://example.test/image.png", status: "failed" }]);
        await updateDataTableMetadata("Original images / 原图 / صور", { kind: "image_collection", assetKind: "image" });
        window.__qzEmitPortMessage({ type: "data_changed", table: "Original images / 原图 / صور" });
      });
      await page.locator("#data-table-search").click();
      await page.locator('.data-table-select[data-table="Original images / 原图 / صور"]').click();
      await expect(page.locator("#data-detail")).toHaveClass(/image-collection/);
      await audit(page, "#data-panel", `${language}-${colorScheme}-images`, testInfo);
      await page.locator("#btn-select-visible-images").click();
      await expect(page.locator("#btn-clear-image-selection")).toBeEnabled();
      await audit(page, "#data-panel", `${language}-${colorScheme}-selected-images`, testInfo);
      for (const width of [360, 521, 640]) {
        await page.setViewportSize({ width, height: 900 });
        await audit(page, "#data-panel", `${language}-${colorScheme}-${width}-selected-images`, testInfo);
      }
      await page.locator("#btn-clear-image-selection").click();
      await expect(page.locator("#btn-delete-selected-images")).toBeDisabled();
    });
  });
}
