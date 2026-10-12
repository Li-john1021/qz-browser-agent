import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

const languages = [["zh-CN", "zh_CN"], ["zh-TW", "zh_TW"], ["en", "en"], ["ja", "ja"], ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["de", "de"], ["pt-BR", "pt_BR"], ["ru", "ru"], ["ar", "ar"], ["hi", "hi"]];
const output = resolve("tests/results/i18n/settings-copy-review");
const skill = { name: "layout-example", displayName: "Original skill", description: "Original description / 用户原文 / نص", content: "# Original content\n\nKeep this text unchanged.", scope: "global", status: "active", resources: [], updatedAt: "2026-09-20 12:34:56" };
const setting = {
  id: "layout-example::connection", pluginId: "connection", skillName: skill.name,
  skillDisplayName: skill.displayName, title: skill.displayName, configured: true, missing: [],
  fields: [
    { key: "endpoint", type: "url", label: "Original endpoint", required: true, value: "https://example.test" },
    { key: "token", type: "secret", label: "Original token", required: true, hasValue: true, value: "fixture-secret" },
    { key: "enabled", type: "boolean", label: "Original option / 用户原文 / نص", value: false },
  ],
};
const config = { provider: "custom", model: "fixture-model", apiKey: "test-key", customEndpoint: "https://example.test/v1/chat/completions", contextWindow: 128000, vision: false };

function installSettingsReplies(setting) {
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args), post = port.postMessage;
    port.postMessage = message => {
      if (message.type === "list_skill_settings") queueMicrotask(() => window.__qzEmitPortMessage({ type: "skill_settings", requestId: message.requestId, settings: [setting] }));
      else post(message);
    };
    return port;
  };
}

async function captureLayout(page, selector, name, testInfo) {
  const root = page.locator(selector);
  const report = await root.evaluate(root => {
    const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
    const id = element => element.id || element.className || element.tagName;
    const problems = [];
    for (const label of root.querySelectorAll("[data-i18n]:not(option), .advanced-setting-title, .skill-settings-field-label, .skill-config-label, .skill-workbench-statusbar > span")) {
      if (!visible(label) || label.closest("textarea, pre")) continue;
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        const rects = [...range.getClientRects()];
        for (let parent = text.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
          const box = parent.getBoundingClientRect();
          if (rects.some(rect => rect.left < box.left - 2 || rect.right > box.right + 2)) {
            problems.push({ element: id(label), container: id(parent), text: text.textContent.trim(), reason: "text exceeds its cell" });
            break;
          }
          // A positioned menu is constrained by its own box, not its icon-sized anchor.
          if (parent.matches(".qz-popover")) break;
        }
      }
    }
    const canvas = document.createElement("canvas").getContext("2d");
    for (const select of root.querySelectorAll("select")) {
      if (!visible(select) || !select.selectedOptions[0]?.hasAttribute("data-i18n") && !["cfg-context-preset", "i18n-language-select"].includes(select.id)) continue;
      const style = getComputedStyle(select);
      canvas.font = style.font;
      const text = select.selectedOptions[0]?.textContent.trim() || "";
      const width = canvas.measureText(text).width;
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (width > available + 2) problems.push({ element: id(select), text, width, available, reason: "selected option is clipped" });
    }
    for (const field of root.querySelectorAll(".guardrail-rate-limit-field")) {
      if (!visible(field)) continue;
      const input = field.querySelector("input"), unit = field.querySelector(".guardrail-rate-limit-unit");
      const style = getComputedStyle(input), box = input.getBoundingClientRect(), unitBox = unit.getBoundingClientRect();
      canvas.font = style.font;
      const text = input.value || input.placeholder, width = canvas.measureText(text).width;
      // The native stepper reduces the text area inside the input's shadow tree.
      if (input.scrollWidth > input.clientWidth + 1) problems.push({ element: id(input), text, reason: "value is clipped inside its number input" });
      const left = style.direction === "rtl"
        ? box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight) - width
        : box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
      if (left < unitBox.right && left + width > unitBox.left) problems.push({ element: id(input), text, reason: "value overlaps its unit" });
    }
    const overflow = [...root.querySelectorAll("button, input, select, textarea")].filter(visible).filter(element => {
      const box = element.getBoundingClientRect();
      return box.left < -1 || box.right > innerWidth + 1;
    }).map(id);
    return { problems, overflow, pageWidth: document.documentElement.scrollWidth, width: innerWidth };
  });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, `${name}.json`), JSON.stringify(report, null, 2));
  await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  await testInfo.attach(name, { path: resolve(output, `${name}.png`), contentType: "image/png" });
  expect.soft(report.problems, `${name}: product labels fit their cells`).toEqual([]);
  expect.soft(report.overflow, `${name}: controls stay in the panel`).toEqual([]);
  expect.soft(report.pageWidth).toBeLessThanOrEqual(report.width);
}

for (const [language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`settings copy · ${language} · ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 320, height: 900 } });
    test("keeps conditional settings and Skill workspace labels readable", async ({ page }, testInfo) => {
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      const options = { uiLanguage: language, localeMessages, config, localStorage: { _skills: { [skill.name]: skill } } };
      await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify(options)}); (${installSettingsReplies.toString()})(${JSON.stringify(setting)});` });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      const audit = (selector, scene) => captureLayout(page, selector, `${language}-${colorScheme}-${scene}`, testInfo);
      await page.locator("#btn-settings").click();
      await page.locator("#cfg-context-preset").selectOption("__custom");
      await expect(page.locator("#cfg-context-window")).toBeVisible();
      await expect(page.locator("#cfg-context-window")).toHaveValue("128K");
      await audit("#settings-panel", "model-custom");
      await page.locator("#settings-tab-advanced").click();
      for (const action of ["block", "allow", "rate_limit"]) {
        await page.locator("#guardrail-rule-action").selectOption(action);
        await page.locator("#guardrail-rule-type").selectOption("pattern");
        if (action === "rate_limit") await page.locator("#guardrail-rate-limit-interval").fill("86400");
        await audit("#settings-panel", `advanced-${action}`);
      }
      await page.locator("#settings-tab-skills").click();
      await expect(page.locator('[data-skill-setting-field="endpoint"]')).toHaveValue("https://example.test");
      await audit("#settings-panel", "skill-form");
      await page.locator("#btn-close-settings").click();
      await page.locator('[data-tab="skills"]').click();
      await page.locator(`.skill-card[data-name="${skill.name}"]`).click();
      await expect(page.locator("#skill-detail-desc")).toHaveText(skill.description);
      await page.locator("#btn-skill-actions").click();
      await audit("#skill-detail", "skill-actions");
      await page.locator("#btn-skill-settings").click();
      await page.locator('[data-skill-scope="site"]').click();
      await audit("#skill-settings-view", "skill-site");
      await page.locator("#btn-close-skill-settings").click();
      await page.locator("#skill-tab-mcp").click();
      await page.locator("#btn-add-skill-mcp").click();
      await audit("#skill-detail", "skill-mcp");
    });
  });
}
