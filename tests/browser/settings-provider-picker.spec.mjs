import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

const languages = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "ar", "hi"];
const providers = [
  { id: "internal-fixture", label: "Workspace provider", requiresApiKey: true, group: { id: "preferred", label: "Recommended", priority: 100 } },
  { id: "custom", label: "Custom endpoint", requiresApiKey: true, group: { id: "custom", label: "Custom", priority: 10 } },
  ...Array.from({ length: 140 }, (_, index) => ({
    id: `cloud-${String(index).padStart(3, "0")}`,
    label: index === 139 ? "VeryLongProviderNameWithNoSpacesAndAnExtraLongSuffix" : `Cloud ${String(index).padStart(3, "0")}`,
    requiresApiKey: true, group: { id: "all", label: "All providers", priority: -10 },
  })),
];

async function boot(page, language = "en", entries = providers) {
  const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${language.replace("-", "_")}/messages.json`), "utf8"));
  await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages, config: {
    provider: "cloud-098", model: "existing-model", apiKey: "fixture-key", providers: entries,
  } });
  await page.goto("/extension/sidepanel/sidepanel.html");
  await page.locator("#btn-settings").click();
  await expect(page.locator("#cfg-provider-trigger")).toHaveText("Cloud 098");
}

async function groupPresentation(page) {
  return page.locator('#cfg-provider-list > [role="group"]:visible').evaluateAll(groups => groups.map(group => {
    const label = group.querySelector(".provider-picker-group");
    const option = group.querySelector('[role="option"]:not([hidden])');
    const groupStyle = getComputedStyle(group);
    const labelStyle = getComputedStyle(label);
    const optionStyle = getComputedStyle(option);
    return {
      headingDecoration: getComputedStyle(label, "::after").content,
      margin: parseFloat(groupStyle.marginBlockStart),
      labelFontSize: parseFloat(labelStyle.fontSize),
      optionFontSize: parseFloat(optionStyle.fontSize),
      labelColor: labelStyle.color,
      optionColor: optionStyle.color,
      labelFits: label.scrollWidth <= label.clientWidth && label.scrollHeight <= label.clientHeight,
      headingIsOption: label.matches('[role="option"], [tabindex]'),
    };
  }));
}

async function assertPopupFits(page) {
  const report = await page.locator("#cfg-provider-picker").evaluate(popup => {
    const rect = popup.getBoundingClientRect();
    const list = popup.querySelector("#cfg-provider-list");
    const search = popup.querySelector("input");
    const problems = [];
    if (rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) problems.push("popup exceeds viewport");
    if (popup.scrollWidth > popup.clientWidth || list.scrollWidth > list.clientWidth) problems.push("horizontal overflow");
    if (search.scrollWidth > search.clientWidth) problems.push("search overflows");
    for (const option of list.querySelectorAll("[role=option]")) {
      const label = option.firstElementChild;
      if (label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight) problems.push("provider label clipped");
    }
    return problems;
  });
  expect(report).toEqual([]);
}

for (const language of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`${language} ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 320, height: 720 } });
    test("a large searchable provider menu keeps priority, current value and narrow layouts", async ({ page }, testInfo) => {
      await boot(page, language);
      await expect(page.locator("#cfg-provider")).toBeHidden();
      await expect(page.locator("#cfg-provider")).toHaveAttribute("tabindex", "-1");
      await page.locator("#cfg-provider-trigger").click();
      const search = page.locator("#cfg-provider-search");
      const choices = page.locator("#cfg-provider-list [role=option]:visible");
      await expect(search).toBeFocused();
      await expect(choices).toHaveCount(providers.length);
      await expect(choices.first()).toHaveAttribute("data-provider-id", "internal-fixture");
      await expect(page.locator('#cfg-provider-list [aria-selected="true"]')).toHaveAttribute("data-provider-id", "cloud-098");
      await page.locator("#cfg-provider-picker").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      await assertPopupFits(page);
      const groups = await groupPresentation(page);
      expect(groups).toHaveLength(3);
      expect(groups[0].margin).toBe(0);
      for (const [index, group] of groups.entries()) {
        expect(group.labelFontSize).toBeLessThan(group.optionFontSize);
        expect(group.labelColor).not.toBe(group.optionColor);
        expect(group.labelFits).toBe(true);
        expect(group.headingIsOption).toBe(false);
        expect(group.headingDecoration).toBe("none");
        if (index > 0) expect(group.margin).toBeGreaterThan(0);
      }
      const output = resolve("tests/results/provider-picker");
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: resolve(output, `${language}-${colorScheme}-320.png`) });

      await search.fill("  cLoUd   127 ");
      await expect(choices).toHaveCount(1);
      await expect(choices).toHaveText("Cloud 127✓");
      await search.fill("no-such-provider");
      await expect(choices).toHaveCount(0);
      await expect(page.locator("#cfg-provider-empty")).toBeVisible();
      expect(await page.locator("#cfg-provider-empty").textContent()).not.toContain("settings.");
      await search.press("Enter");
      await expect(page.locator("#cfg-provider")).toHaveValue("cloud-098");
      await search.press("Escape");
      await expect(page.locator("#cfg-provider-picker")).toBeHidden();
      await expect(page.locator("#cfg-provider-trigger")).toBeFocused();
      await expect(page.locator("#settings-panel")).toBeVisible();
      await expect(page.locator("#cfg-model")).toHaveValue("existing-model");
      await expect(page.locator("#cfg-apikey")).toHaveValue("fixture-key");

      await page.locator("#cfg-provider-trigger").press("ArrowDown");
      await expect(search).toHaveValue("");
      await search.fill("cloud-139");
      await assertPopupFits(page);
      await search.press("Enter");
      await expect(page.locator("#cfg-provider")).toHaveValue("cloud-139");
      await expect(page.locator("#cfg-provider-trigger")).toHaveText(providers.at(-1).label);
      await expect(page.locator("#cfg-model")).toHaveValue("");
      await expect(page.locator("#cfg-provider-picker")).toBeHidden();
      await expect(page.locator("#cfg-provider-trigger")).toBeFocused();
      await testInfo.attach("provider-picker-layout", { body: Buffer.from(JSON.stringify({ language, colorScheme, width: 320, providers: providers.length })), contentType: "application/json" });
    });
  });
}

test("keyboard, outside dismissal, refresh and form close do not retain stale picker state", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await boot(page);
  await page.locator("#cfg-provider-trigger").click();
  await page.locator("#cfg-provider-trigger").click();
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
  await page.locator("#cfg-provider-trigger").press("ArrowDown");
  const search = page.locator("#cfg-provider-search");
  await page.locator(".provider-picker-group").first().click();
  await expect(page.locator("#cfg-provider-picker")).toBeVisible();
  await expect(page.locator("#cfg-provider")).toHaveValue("cloud-098");
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  const activeChoice = await search.getAttribute("aria-activedescendant");
  await expect(page.locator(`#${activeChoice}`)).toHaveAttribute("role", "option");
  await expect(page.locator(`#${activeChoice}`)).toHaveAttribute("data-provider-id", "custom");
  await search.press("Enter");
  await expect(page.locator("#cfg-provider")).toHaveValue("custom");
  await chooseProvider(page, "cloud-004");
  await expect(page.locator("#cfg-provider")).toHaveValue("cloud-004");

  await page.locator("#cfg-provider-trigger").click();
  await search.press("Tab");
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
  await expect(page.locator("#cfg-apikey")).toBeFocused();

  await page.locator("#cfg-provider-trigger").click();
  await search.fill("cloud-004");
  await page.locator("#settings-panel-model > label").first().click();
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
  await page.locator("#cfg-provider-trigger").click();
  await expect(search).toHaveValue("");
  await page.evaluate(() => window.__qzEmitPortMessage({ type: "config", config: {
    provider: "replacement", model: "replacement-model", providers: [{ id: "replacement", label: "Replacement", requiresApiKey: false }],
  } }));
  await expect(page.locator("#cfg-provider-trigger")).toHaveText("Replacement");
  await expect(page.locator("#cfg-provider-list [role=option]")).toHaveCount(1);
  await expect(page.locator('#cfg-provider-list [aria-selected="true"]')).toHaveText("Replacement✓");
  await page.evaluate(() => window.__qzEmitPortMessage({ type: "config", config: { providers: [] } }));
  await expect(page.locator("#cfg-provider-list [role=option]")).toHaveCount(0);
  await expect(page.locator("#cfg-provider-empty")).toBeVisible();
  await page.locator("#settings-tab-advanced").click();
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
  await page.locator("#settings-tab-model").click();
  await page.locator("#cfg-provider-trigger").click();
  await page.locator("#btn-close-settings").click();
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
});

test("filtered groups do not keep spacing from hidden preceding sections", async ({ page }) => {
  await boot(page);
  await page.locator("#cfg-provider-trigger").click();
  const search = page.locator("#cfg-provider-search");
  for (const query of ["Cloud", "Custom", "Recommended"]) {
    await search.fill(query);
    const groups = await groupPresentation(page);
    expect(groups).toHaveLength(1);
    expect(groups[0].headingDecoration).toBe("none");
    expect(groups[0].margin).toBe(0);
  }
  await search.fill("");
  const restored = await groupPresentation(page);
  expect(restored).toHaveLength(3);
  expect(restored[0].margin).toBe(0);
  expect(restored.slice(1).every(group => group.margin > 0)).toBe(true);
});

test("long group names remain readable in a narrow RTL menu", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ colorScheme: "dark" });
  const entries = providers.map(provider => ({ ...provider, group: {
    ...provider.group,
    label: provider.group.id === "preferred"
      ? "مزوّدو الخدمة الموصى بهم للاستخدام في مساحة العمل الحالية"
      : provider.group.id === "all"
        ? "VeryLongProviderGroupNameWithoutAnySpacesToWrapNaturally"
        : "مخصّص",
  } }));
  await boot(page, "ar", entries);
  await page.locator("#cfg-provider-trigger").click();
  await page.locator("#cfg-provider-picker").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await assertPopupFits(page);
  expect((await groupPresentation(page)).every(group => group.labelFits)).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const output = resolve("tests/results/provider-picker");
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, "group-long-rtl-dark-320.png") });
});

test("the provider menu opens above its field when the panel has little space below", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 360 });
  await boot(page);
  await page.locator("#cfg-provider-trigger").press("ArrowUp");
  await page.locator("#cfg-provider-picker").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  await assertPopupFits(page);
  await expect.poll(() => page.evaluate(() =>
    document.querySelector("#cfg-provider-picker").getBoundingClientRect().bottom
      - document.querySelector("#cfg-provider-trigger").getBoundingClientRect().top,
  )).toBeLessThan(0);
  await page.locator("#cfg-provider-search").press("Enter");
  await expect(page.locator("#cfg-provider")).toHaveValue("cloud-139");
  await page.locator("#cfg-provider-trigger").click();
  await page.locator("#settings-tab-panel-model").evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator("#cfg-provider-picker")).toBeHidden();
});

test.describe("provider label dismissal", () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 720 } });
  for (const pointer of ["mouse", "touch"]) test(`${pointer} on the label's blank space dismisses without reopening`, async ({ page }) => {
    await boot(page);
    const trigger = page.locator("#cfg-provider-trigger");
    await trigger.click();
    await expect(page.locator("#cfg-provider-search")).toBeFocused();
    const label = page.locator("#cfg-provider-label");
    const box = await label.boundingBox();
    const options = { position: { x: box.width - 3, y: box.height / 2 } };
    if (pointer === "touch") await label.tap(options);
    else await label.click(options);
    await expect(page.locator("#cfg-provider-picker")).toBeHidden();
    await expect(page.locator("#cfg-provider")).toHaveValue("cloud-098");
    await trigger.click();
    await expect(page.locator("#cfg-provider-picker")).toBeVisible();
    await trigger.click();
    await expect(page.locator("#cfg-provider-picker")).toBeHidden();
  });
});

for (const height of [360, 720]) test(`search retains the popup, matching rows and geometry at height ${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 320, height });
  await boot(page);
  await page.locator("#settings-panel").evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await page.locator("#cfg-provider-trigger").click();
  const popup = page.locator("#cfg-provider-picker");
  await popup.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
  const initialBox = await popup.boundingBox();
  const originalRow = await page.locator('[data-provider-id="cloud-127"]').elementHandle();
  await page.evaluate(() => {
    window.__providerPopupEvents = [];
    document.querySelector("#cfg-provider-picker").addEventListener("beforetoggle", event => window.__providerPopupEvents.push(event.newState));
  });
  for (const query of ["cloud", "cloud-127", "missing", ""]) {
    await page.locator("#cfg-provider-search").fill(query);
    await expect(page.locator("#cfg-provider-search")).toBeFocused();
    const box = await popup.boundingBox();
    expect(Math.abs(box.y - initialBox.y)).toBeLessThan(1);
    expect(Math.abs(box.height - initialBox.height)).toBeLessThan(1);
    expect(await originalRow.evaluate(element => element.isConnected)).toBe(true);
  }
  expect(await page.evaluate(() => window.__providerPopupEvents)).toEqual([]);
});
