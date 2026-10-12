import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, testAssetUrl } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = ["en", "zh-CN", "zh-TW", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "ar", "hi"];
const artifacts = resolve("tests/results/i18n/settings-tabs");

async function mountSettings(page, language) {
  const extension = await ensureTestExtension();
  const [html, messages] = await Promise.all([
    readFile(resolve(extension, "sidepanel/sidepanel.html"), "utf8"),
    readFile(resolve(extension, `_locales/${language.replace("-", "_")}/messages.json`), "utf8").then(JSON.parse),
  ]);
  await page.route("**/settings-tabs-layout", route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${testAssetUrl("extension/sidepanel/sidepanel.css")}"></head><body><button id="btn-settings">Settings</button></body></html>`,
  }));
  await page.goto(testAssetUrl("settings-tabs-layout"));
  return page.evaluate(async ({ html, messages, language }) => {
    const { createSettingsShell } = await import("/extension/sidepanel/capability-host/settings-shell.js");
    const { chromeMessageId, decodeChromeMessage } = await import("/extension/shared/i18n/definition.js");
    const catalogs = await Promise.all([
      import("/extension/capabilities/settings/messages.js"),
      import("/extension/capabilities/i18n/messages.js"),
      import("/extension/sidepanel/i18n/messages.js"),
    ]);
    const sources = Object.fromEntries(catalogs.map(({ default: catalog }) => [catalog.namespace, catalog.messages]));
    const t = key => {
      const separator = key.indexOf(".");
      const authored = sources[key.slice(0, separator)]?.[key.slice(separator + 1)];
      return decodeChromeMessage(messages[chromeMessageId(key)]) ?? authored?.[language] ?? authored?.en;
    };
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.querySelector("#btn-settings").textContent = t("core.settings");
    const source = new DOMParser().parseFromString(html, "text/html");
    const panel = source.querySelector("#settings-panel");
    document.body.appendChild(panel);
    panel.querySelectorAll("[data-i18n], [data-i18n-aria-label]").forEach(element => {
      if (element.dataset.i18n) element.textContent = t(element.dataset.i18n);
      if (element.dataset.i18nAriaLabel) element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    });
    const labels = [
      ["model", t("settings.model"), 10],
      ["skills", t("settings.skills"), 20],
      ["advanced", t("settings.advanced"), 30],
      ["i18n-language", t("language-settings.title"), 90],
      ["capability-security", t("settings.securityPolicies"), 100],
      ["capability-navigation", t("settings.pageNavigationRateLimits"), 110],
      ["capability-long", `${t("settings.securityPolicies")} ${t("settings.pageNavigationRateLimits")} ${"Capability".repeat(12)}`, 120],
    ];
    if (labels.some(([, title]) => !title)) throw new Error("Missing translated fixture label");
    let count = 3;
    let changed;
    const records = labels.map(([id, title, order]) => {
      const element = document.createElement("section");
      const input = document.createElement("input");
      input.className = "qz-field-input";
      input.setAttribute("aria-label", title);
      input.value = title;
      element.appendChild(input);
      return { id, title, order, element, visible: () => id === "skills" ? count >= 4 : id.startsWith("capability-") ? count >= 7 : true };
    });
    const shell = createSettingsShell(document, error => { throw error; });
    const registered = [];
    shell.connect({
      getSettingsSections: () => [...registered].sort((a, b) => a.order - b.order),
      subscribeChanges(listener) { changed = listener; return () => {}; },
    });
    // Actual packages may mount asynchronously in a different order from their declared order.
    for (const record of [...records].reverse()) {
      registered.push(record);
      changed();
      shell.setState(record.id, { saveLabel: t("settings.saveConfiguration"), text: t("settings.saved"), disabled: true });
    }
    window.settingsLayout = { shell, configure(next) { count = next; changed(); } };
    shell.open();
    return Object.fromEntries(labels.map(([id, title]) => [id, title]));
  }, { html, messages, language });
}

async function inspectSelectedTab(page, expected) {
  const button = page.locator(`[data-settings-tab="${expected}"]`);
  await expect(button).toHaveAttribute("aria-selected", "true");
  await expect(button).toBeFocused();
  const geometry = await button.evaluate(element => {
    const tabs = element.closest(".settings-tabs");
    const track = tabs.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
    return {
      track: { left: track.left, right: track.right, top: track.top, bottom: track.bottom },
      box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, text,
      overflow: element.scrollWidth - element.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      tabStops: tabs.querySelectorAll('[tabindex="0"]').length,
      outline: getComputedStyle(element).outlineStyle,
    };
  });
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.tabStops).toBe(1);
  expect(geometry.box.left).toBeGreaterThanOrEqual(geometry.track.left - 1);
  expect(geometry.box.right).toBeLessThanOrEqual(geometry.track.right + 1);
  expect(geometry.box.top).toBeGreaterThanOrEqual(geometry.track.top - 1);
  expect(geometry.box.bottom).toBeLessThanOrEqual(geometry.track.bottom + 1);
  expect(geometry.outline).not.toBe("none");
  for (const text of geometry.text) {
    expect(text.left).toBeGreaterThanOrEqual(geometry.box.left - 1);
    expect(text.right).toBeLessThanOrEqual(geometry.box.right + 1);
    expect(text.top).toBeGreaterThanOrEqual(geometry.box.top - 1);
    expect(text.bottom).toBeLessThanOrEqual(geometry.box.bottom + 1);
  }
}

for (const language of languages) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`${language} settings tabs · ${colorScheme}`, () => {
      test.use({ colorScheme, viewport: { width: 320, height: 900 } });
      test("keeps translated and additional sections readable and keyboard reachable", async ({ page }, testInfo) => {
        const titles = await mountSettings(page, language);
        await mkdir(artifacts, { recursive: true });
        const forward = language === "ar" ? "ArrowLeft" : "ArrowRight";
        const backward = language === "ar" ? "ArrowRight" : "ArrowLeft";
        for (const width of [320, 360, 430]) {
          await page.setViewportSize({ width, height: 900 });
          for (const count of [3, 4, 7]) {
            await page.evaluate(count => window.settingsLayout.configure(count), count);
            const ids = count === 3 ? ["model", "advanced", "i18n-language"]
              : count === 4 ? ["model", "skills", "advanced", "i18n-language"] : Object.keys(titles);
            await expect(page.locator(".settings-tab:visible")).toHaveText(ids.map(id => titles[id]));
            await page.locator('[data-settings-tab="model"]').focus();
            await page.keyboard.press("Home");
            for (const id of ids) {
              await inspectSelectedTab(page, id);
              await page.keyboard.press(forward);
            }
            await inspectSelectedTab(page, ids[0]);
            await page.keyboard.press(backward);
            await inspectSelectedTab(page, ids.at(-1));
            await page.keyboard.press("Home");
            await inspectSelectedTab(page, ids[0]);
            await page.keyboard.press("End");
            await inspectSelectedTab(page, ids.at(-1));
            const file = resolve(artifacts, `${language}-${colorScheme}-${width}-${count}.png`);
            await page.screenshot({ path: file, animations: "disabled" });
            await testInfo.attach(`${width}-${count}-tabs`, { path: file, contentType: "image/png" });
          }
        }
      });
    });
  }
}
