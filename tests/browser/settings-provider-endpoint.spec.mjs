import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

const longEndpoint = `https://gateway.example/${"long-routing-segment/".repeat(5)}v1/chat/completions`;
const longProvider = { id: "endpoint-fixture", label: "Gateway", endpoint: longEndpoint, requiresApiKey: true };
const hiddenProvider = { ...longProvider, id: "hidden-endpoint-fixture", label: "Managed gateway", hideEndpoint: true };
const protocols = [{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" }];

async function boot(page, language, config) {
  const localeMessages = JSON.parse(await readFile(join(await ensureTestExtension(), "_locales", language.replace("-", "_"), "messages.json"), "utf8"));
  await page.addInitScript(installBenchmarkChromeStub, { uiLanguage: language, localeMessages, config });
  await page.goto("/extension/sidepanel/sidepanel.html");
  await page.locator("#btn-settings").click();
  await page.locator("#settings-panel").evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
}

for (const language of ["en", "ar"]) for (const colorScheme of ["light", "dark"]) test.describe(`${language} ${colorScheme} endpoint`, () => {
  test.use({ locale: language, colorScheme, viewport: { width: 320, height: 720 } });
  test("provider URLs wrap in the field and custom previews follow protocol changes", async ({ page, providerMenus }) => {
    await boot(page, language, {
      provider: longProvider.id, model: "configured-model", providers: [...providerMenus[language], longProvider, hiddenProvider], customProtocols: protocols,
    });
    const preview = page.locator("#cfg-provider-endpoint");
    await expect(preview).toHaveText(longEndpoint);
    const geometry = await preview.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const trigger = document.querySelector("#cfg-provider-trigger").getBoundingClientRect();
      const style = getComputedStyle(element);
      return { left: rect.left, right: rect.right, top: rect.top, triggerBottom: trigger.bottom,
        scrollWidth: element.scrollWidth, width: element.clientWidth, lines: rect.height / parseFloat(style.lineHeight),
        direction: style.direction, align: style.textAlign, color: style.color,
        textColor: getComputedStyle(document.querySelector("#cfg-provider-trigger")).color };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(320);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.triggerBottom);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    expect(geometry.lines).toBeGreaterThan(1);
    expect(geometry.direction).toBe("ltr");
    expect(geometry.align).toBe("right");
    expect(geometry.color).not.toBe(geometry.textColor);
    const output = resolve("tests/results/provider-picker");
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, `endpoint-${language}-${colorScheme}-320.png`) });

    await chooseProvider(page, hiddenProvider.id);
    await expect(preview).toBeHidden();
    await expect(preview).toHaveText("");
    expect(await preview.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
    await page.screenshot({ path: join(output, `endpoint-hidden-${language}-${colorScheme}-320.png`) });

    await chooseProvider(page, "openaicodex");
    await expect(preview).toHaveText(providerMenus[language].find(provider => provider.id === "openaicodex").endpoint);
    await chooseProvider(page, "custom");
    await expect(preview).toBeHidden();
    const input = page.locator("#cfg-custom-endpoint");
    await input.fill("router.example/v1");
    await expect(preview).toHaveText("https://router.example/v1/chat/completions");
    await page.locator("#cfg-custom-protocol").selectOption("anthropic");
    await expect(preview).toHaveText("https://router.example/v1/messages");
    await input.fill("https://router.example/custom/generate?route=preferred");
    await expect(preview).toHaveText("https://router.example/custom/generate?route=preferred");
    await input.fill("");
    await expect(preview).toBeHidden();
  });
});

test("config and preset filling retain the endpoint for known and unavailable custom protocols", async ({ page }) => {
  const presets = [
    { id: "standard", name: "Standard", provider: "custom", model: "one", customProtocol: "anthropic", customEndpoint: "localhost:1234/v1" },
    { id: "retired", name: "Retired protocol", provider: "custom", model: "two", customProtocol: "retired-native", customEndpoint: "https://native.example/v1" },
  ];
  await boot(page, "en", { ...presets[0], activePresetId: "standard", presets, customProtocols: protocols });
  const preview = page.locator("#cfg-provider-endpoint");
  await expect(preview).toHaveText("http://localhost:1234/v1/messages");
  await page.locator("#cfg-preset").selectOption("retired");
  await expect(page.locator("#cfg-custom-protocol")).toHaveValue("retired-native");
  await expect(preview).toHaveText("https://native.example/v1");
  await page.locator("#cfg-custom-endpoint").fill("https://native.example/new/v1");
  await expect(preview).toHaveText("https://native.example/new/v1");
  await page.locator("#cfg-preset").selectOption("standard");
  await expect(preview).toHaveText("http://localhost:1234/v1/messages");
  await page.evaluate(() => window.__qzEmitPortMessage({ type: "config", config: {
    provider: "extension-without-endpoint", model: "test-model", providers: [{ id: "extension-without-endpoint", label: "Extension without a URL" }],
  } }));
  await expect(preview).toBeHidden();
  await expect(preview).toHaveText("");
});

test("refreshed provider metadata hides an already displayed endpoint without changing the provider", async ({ page, providerMenus }) => {
  await boot(page, "en", { provider: longProvider.id, model: "configured-model", providers: [...providerMenus.en, longProvider] });
  const preview = page.locator("#cfg-provider-endpoint");
  await expect(preview).toHaveText(longEndpoint);
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), {
    provider: longProvider.id, model: "configured-model", providers: [...providerMenus.en, { ...longProvider, hideEndpoint: true }],
  });
  await expect(page.locator("#cfg-provider")).toHaveValue(longProvider.id);
  await expect(page.locator("#cfg-model")).toHaveValue("configured-model");
  await expect(preview).toBeHidden();
  await expect(preview).toHaveText("");
});
