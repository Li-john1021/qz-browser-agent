import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

const config = { provider: "custom", apiKey: "test-key", model: "test-model", customEndpoint: "https://example.com/v1/chat/completions", customProtocol: "openai", contextWindow: 128000, vision: false, presets: [] };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, { config });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  await page.locator("#btn-settings").click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("128K");
});

async function save(page, context = "256K") {
  await page.locator("#cfg-context-preset").selectOption(context);
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await page.locator("#btn-save-settings").click();
  return page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_config").at(-1));
}

async function respond(page, request, error = "") {
  await page.evaluate(({ request, error }) => window.__qzEmitPortMessage(error
    ? { type: "error", requestId: request.requestId, message: error }
    : { type: "config_saved", requestId: request.requestId, config: request.config }), { request, error });
}

test("a completed save keeps edits made while the request was in flight", async ({ page }) => {
  const request = await save(page);
  await page.locator("#cfg-context-preset").selectOption("512K");
  await respond(page, request);
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("512K");
  await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
});

for (const error of ["", "old request failed"]) {
  test(`a ${error ? "failed" : "successful"} old save cannot alter a reopened panel or unlock a newer save`, async ({ page }) => {
    const first = await save(page);
    await page.locator("#btn-close-settings").click();
    await page.locator("#btn-settings").click();
    await expect(page.locator("#cfg-context-preset")).toHaveValue("128K");
    const second = await save(page, "512K");
    await respond(page, first, error);
    await expect(page.locator("#settings-panel")).toBeVisible();
    await expect(page.locator("#cfg-context-preset")).toHaveValue("512K");
    await expect(page.locator("#btn-save-settings")).toHaveText("保存中…");
    await expect(page.locator("#btn-save-settings")).toBeDisabled();
    await expect(page.locator("#settings-save-status")).not.toContainText("old request failed");
    await respond(page, second);
    await expect(page.locator("#settings-panel")).toBeHidden();
  });
}

test("current failures preserve the draft and a retry can complete", async ({ page }) => {
  const first = await save(page);
  await respond(page, first, "temporary save failure");
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#settings-save-status")).toHaveText("temporary save failure");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  const second = await save(page);
  await respond(page, second);
  await expect(page.locator("#settings-panel")).toBeHidden();
});

const customProtocols = [{ id: "openai", label: "OpenAI" }, { id: "anthropic", label: "Anthropic" }, { id: "vendor-native", label: "Native service" }];

test("registered protocols are selectable and saved without changing their endpoint", async ({ page }) => {
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), { ...config, customProtocols });
  const protocol = page.locator("#cfg-custom-protocol");
  await expect(protocol.locator("option")).toHaveText(["OpenAI", "Anthropic", "Native service"]);
  await protocol.selectOption("vendor-native");
  await page.locator("#cfg-custom-endpoint").fill("https://native.example/v1");
  const request = await save(page);
  expect(request.config.customProtocol).toBe("vendor-native");
  expect(request.config.customEndpoint).toBe("https://native.example/v1");
  await respond(page, request);
  await expect(page.locator("#settings-panel")).toBeHidden();
});

test("an old preset keeps its unavailable protocol across loading, selection and saving", async ({ page }) => {
  const preset = { ...config, id: "old-native", name: "Archived native", customProtocol: "retired-native", customEndpoint: "https://native.example/v1" };
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), { ...preset, activePresetId: preset.id, presets: [preset], customProtocols });
  await expect(page.locator("#cfg-custom-protocol")).toHaveValue("retired-native");
  await page.locator("#cfg-custom-protocol").selectOption("anthropic");
  await page.locator("#cfg-preset").selectOption("old-native");
  await expect(page.locator("#cfg-custom-protocol")).toHaveValue("retired-native");
  const request = await save(page);
  expect(request.config.customProtocol).toBe("retired-native");
  expect(request.config.customEndpoint).toBe("https://native.example/v1");
});

test("built-in protocol completion keeps its existing endpoint hints", async ({ page }) => {
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), { ...config, customProtocols });
  const endpoint = page.locator("#cfg-custom-endpoint");
  for (const [protocol, suffix] of [["anthropic", "messages"], ["openai", "chat/completions"]]) {
    await page.locator("#cfg-custom-protocol").selectOption(protocol);
    await expect(endpoint).toHaveAttribute("placeholder", `https://example.com/v1/${suffix}`);
    await endpoint.fill("https://router.example/v1");
    await endpoint.press("Tab");
    await expect(endpoint).toHaveValue(`https://router.example/v1/${suffix}`);
  }
});

test("an unmatched late save response cannot enter the broadcast config path", async ({ page }) => {
  await page.locator("#cfg-context-preset").selectOption("512K");
  await respond(page, { requestId: "timed-out-request", config: { ...config, contextWindow: 256000 } });
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("512K");
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config_saved", config }), config);
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("512K");
  // A fresh background snapshot still owns the ordinary config path.
  await page.evaluate(config => window.__qzEmitPortMessage({ type: "config", config }), config);
  await expect(page.locator("#cfg-context-preset")).toHaveValue("128K");
});

test("a Skill save cannot close or replace a newly opened form", async ({ page }) => {
  const setting = { id: "test::one", pluginId: "one", skillName: "test", skillDisplayName: "Test", configured: true, fields: [{ key: "value", type: "text", label: "Value", value: "initial" }] };
  const listing = await page.evaluate(() => window.__qzPostedMessages.find(message => message.type === "list_skill_settings"));
  await page.evaluate(({ listing, setting }) => window.__qzEmitPortMessage({ type: "skill_settings", requestId: listing.requestId, settings: [setting] }), { listing, setting });
  await page.locator("#settings-tab-skills").click();
  const field = page.locator('[data-skill-setting-field="value"]');
  await field.fill("submitted");
  await page.locator("#btn-save-settings").click();
  const first = await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_skill_settings").at(-1));
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await expect(field).toBeEnabled();
  await field.fill("new draft");
  await page.locator("#btn-save-settings").click();
  const second = await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_skill_settings").at(-1));
  await page.evaluate(({ first, setting }) => window.__qzEmitPortMessage({ type: "skill_settings_saved", requestId: first.requestId, setting: { ...setting, fields: [{ ...setting.fields[0], value: "submitted" }] } }), { first, setting });
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(field).toHaveValue("new draft");
  await expect(field).toBeDisabled();
  await expect(page.locator("#btn-save-settings")).toHaveText("保存中…");
  await respond(page, second, "Skill save failure");
  await expect(field).toBeEnabled();
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await expect(page.locator("#settings-save-status")).toHaveText("Skill save failure");
  await field.fill("recovered");
  await page.locator("#btn-save-settings").click();
  const third = await page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "save_skill_settings").at(-1));
  await page.evaluate(({ third, setting }) => window.__qzEmitPortMessage({ type: "skill_settings_saved", requestId: third.requestId, setting: { ...setting, fields: [{ ...setting.fields[0], value: "recovered" }] } }), { third, setting });
  await expect(page.locator("#settings-panel")).toBeHidden();
});
