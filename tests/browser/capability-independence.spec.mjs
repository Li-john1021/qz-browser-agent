import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureCapabilityExtension, resolveTestAsset } from "../support/extension-build.mjs";

const config = {
  provider: "custom", apiKey: "synthetic-key", model: "independence-model", contextWindow: 128000,
  customProtocol: "openai", customEndpoint: "https://example.invalid/v1/chat/completions", presets: [],
};

async function openApp(page, omit = [], modelConfig = config) {
  const extensionDir = await ensureCapabilityExtension({ omit, example: true });
  await page.route("**/extension/**", route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const path = resolveTestAsset(pathname, { root: process.cwd(), extensionDir });
    return path ? route.fulfill({ path }) : route.abort();
  });
  // Use the normal app bootstrap and transport, without the benchmark host's composition helpers.
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, config: modelConfig });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-boot-fallback");
  await expect(page.locator("#input")).toBeVisible();
  await expect(page.locator("#input")).toBeEnabled();
  await expect(page.locator('[data-tab="example-page"]')).toBeVisible();
}

async function saveExample(page, value, error = "") {
  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.getByLabel("示例选项").fill(value);
  if (error) await page.evaluate(error => {
    const storage = chrome.storage.local;
    const set = storage.set.bind(storage);
    storage.set = async values => { storage.set = set; throw new Error(error); };
  }, error);
  await page.locator("#btn-save-settings").click();
  await expect(page.locator("#settings-save-status")).toHaveText(error ? "保存失败，请重试。" : "示例已保存");
  if (error) await expect(page.locator("#settings-save-status")).toHaveAttribute("data-tone", "error");
  if (!error) expect(await page.evaluate(async value => Object.values(await chrome.storage.local.get(null))
    .some(item => item && typeof item === "object" && item.value === value), value)).toBe(true);
}

test("removing the language capability keeps the complete app usable with the kernel's English fallback", async ({ page }) => {
  await openApp(page, ["i18n"]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator('[data-tab="chat"]')).toHaveText("Chat");
  await expect(page.locator("#btn-settings")).toHaveAttribute("title", "Settings");
  await page.locator("#btn-settings").click();
  await expect(page.locator("#btn-save-settings")).toHaveText("Save");
  await expect(page.locator("#cfg-model")).toHaveValue(config.model);
  await page.locator("#btn-close-settings").click();
  await page.locator("#input").fill("用户内容 stays unchanged");
  await expect(page.locator("#input")).toHaveValue("用户内容 stays unchanged");
});

for (const omitted of ["settings", "data"]) {
  test(`the complete app starts without the ${omitted} package and the other pages and settings remain usable`, async ({ page }) => {
    await openApp(page, [omitted]);
    if (omitted === "settings") {
      await expect(page.locator("#cfg-provider, #model-preset-switcher, #current-model-indicator")).toHaveCount(0);
      await expect(page.locator(".welcome-subtitle")).toBeVisible();
      await expect(page.locator(".welcome-subtitle")).toHaveText("万重山外，一舟轻渡");
      await expect(page.locator('[data-tab="data"]')).toBeVisible();
    } else {
      await expect(page.locator('[data-tab="data"], #data-panel')).toHaveCount(0);
    }
    await page.locator("#input").fill("可选能力缺席时，对话仍可编辑");
    await page.locator('[data-tab="sessions"]').click();
    await expect(page.locator("#sessions-panel")).toBeVisible();
    await page.locator('[data-tab="skills"]').click();
    await expect(page.locator("#skills-panel")).toBeVisible();
    await page.locator('[data-tab="example-page"]').click();
    await expect(page.locator("#example-page")).toBeVisible();
    await page.locator('[data-tab="chat"]').click();
    await expect(page.locator("#input")).toHaveValue("可选能力缺席时，对话仍可编辑");
    await page.locator("#btn-settings").click();
    await saveExample(page, `saved without ${omitted}`);
    if (omitted === "settings") {
      await expect(page.locator('[data-settings-tab="model"]')).toHaveCount(0);
      await expect(page.locator('[data-settings-tab="example-settings"]')).toBeVisible();
    } else {
      await page.locator('[data-settings-tab="model"]').click();
      await expect(page.locator("#cfg-model")).toHaveValue(config.model);
    }
    await page.locator("#btn-close-settings").click();
    await expect(page.locator("#input")).toBeEnabled();
  });
}

test("a copied settings group saves through the complete app without mutating or saving the built-in model group", async ({ page }) => {
  await openApp(page);
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("128K");
  await page.locator("#cfg-context-preset").selectOption("256K");
  await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
  await saveExample(page, "independent setting");
  expect(await page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "save_config"))).toEqual([]);
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
  await page.locator("#btn-save-settings").click();
  const request = await page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "save_config").at(-1));
  expect(request.config.contextWindow).toBe("256K");
  await page.evaluate(request => window.__qzEmitPortMessage({ type: "config_saved", requestId: request.requestId, config: request.config }), request);
  await expect(page.locator("#settings-panel")).toBeHidden();
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="example-settings"]').click();
  await expect(page.getByLabel("示例选项")).toHaveValue("independent setting");
});

test("settings groups retain independent failed drafts and ignore a previous group's late save", async ({ page }) => {
  await openApp(page);
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="model"]').click();
  await page.locator("#cfg-context-preset").selectOption("256K");
  await saveExample(page, "retry this independent draft", "independent save failed");
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
  await page.locator("#btn-save-settings").click();
  const request = await page.evaluate(() => window.__qzPostedMessages.filter(item => item.type === "save_config").at(-1));
  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.evaluate(request => window.__qzEmitPortMessage({ type: "error", requestId: request.requestId, message: "stale model failure" }), request);
  await expect(page.getByLabel("示例选项")).toHaveValue("retry this independent draft");
  await expect(page.locator("#settings-save-status")).toHaveText("保存失败，请重试。");
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#settings-save-status")).not.toContainText("stale model failure");
  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.locator("#btn-save-settings").click();
  await expect(page.locator("#settings-save-status")).toHaveText("示例已保存");
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-context-preset")).toHaveValue("128K");
});

const directoryConfig = {
  provider: "fixture-directory", apiKey: "original-account", model: "draft-model", contextWindow: 128000,
  providers: [{ id: "fixture-directory", label: "Fixture directory", requiresApiKey: true,
    endpoint: "https://example.invalid/v1/chat/completions" }],
  presets: [],
};
const directoryRequests = page => page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "list_models"));
const configRequestCount = page => page.evaluate(() => window.__qzPostedMessages.filter(message => message.type === "get_config").length);
async function replyWithModels(page, request, models) {
  await page.evaluate(({ request, models }) => window.__qzEmitPortMessage({
    type: "models", requestId: request.requestId, provider: request.provider, models,
  }), { request, models });
}

test("returning from another capability's settings resumes an interrupted model directory without replacing the draft", async ({ page }) => {
  await openApp(page, [], directoryConfig);
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-provider")).toHaveValue(directoryConfig.provider);
  await expect(page.locator("#cfg-model")).toHaveAttribute("title", /正在获取|Loading/i);
  await page.locator("#cfg-context-preset").selectOption("256K");
  const before = await directoryRequests(page);
  expect(before.length).toBeGreaterThan(0);
  const interrupted = before.at(-1);
  const configReads = await configRequestCount(page);

  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.getByLabel("示例选项").fill("independent draft survives navigation");
  await replyWithModels(page, interrupted, ["draft-model", "obsolete-model"]);
  await page.locator('[data-settings-tab="model"]').click();
  await expect.poll(async () => (await directoryRequests(page)).length).toBe(before.length + 1);
  const resumed = (await directoryRequests(page)).at(-1);
  expect(resumed.requestId).not.toBe(interrupted.requestId);
  expect(resumed.apiKey).toBe(directoryConfig.apiKey);
  await replyWithModels(page, resumed, ["draft-model", "current-model"]);

  await expect(page.locator("#cfg-model")).toHaveValue("draft-model");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-apikey")).toHaveValue(directoryConfig.apiKey);
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取|Loading/i);
  await page.locator("#cfg-model-toggle").click();
  await expect(page.locator(".model-suggestion-item")).toHaveCount(2);
  await expect(page.locator("#cfg-model-options")).toContainText("current-model");
  await expect(page.locator("#cfg-model-options")).not.toContainText("obsolete-model");
  expect(await configRequestCount(page)).toBe(configReads, "tab navigation must not reload saved config over the draft");
  await page.locator('[data-settings-tab="example-settings"]').click();
  await expect(page.getByLabel("示例选项")).toHaveValue("independent draft survives navigation");
});

test("returning from another capability's settings resumes a cancelled credential debounce with the edited key", async ({ page }) => {
  await openApp(page, [], directoryConfig);
  await page.locator("#btn-settings").click();
  await page.locator('[data-settings-tab="model"]').click();
  await expect(page.locator("#cfg-provider")).toHaveValue(directoryConfig.provider);
  const initial = (await directoryRequests(page)).at(-1);
  expect(initial).toBeTruthy();
  await replyWithModels(page, initial, ["draft-model", "original-account-model"]);
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取|Loading/i);
  await page.locator("#cfg-context-preset").selectOption("256K");
  const configReads = await configRequestCount(page);
  const before = (await directoryRequests(page)).length;
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  // An input-only credential edit (for example autofill) schedules discovery without a blur/change request.
  await page.evaluate(() => {
    const key = document.querySelector("#cfg-apikey");
    key.value = "edited-account";
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-settings-tab="example-settings"]').click();
  await page.clock.runFor(1000);
  expect((await directoryRequests(page)).length).toBe(before, "the hidden package must not start its cancelled timer");
  await page.locator('[data-settings-tab="model"]').click();
  await expect.poll(async () => (await directoryRequests(page)).length).toBe(before + 1);
  const resumed = (await directoryRequests(page)).at(-1);
  expect(resumed.apiKey).toBe("edited-account");
  await replyWithModels(page, resumed, ["draft-model", "edited-account-model"]);

  await expect(page.locator("#cfg-model")).toHaveValue("draft-model");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("256K");
  await expect(page.locator("#cfg-apikey")).toHaveValue("edited-account");
  await page.locator("#cfg-model-toggle").click();
  await expect(page.locator(".model-suggestion-item")).toHaveCount(2);
  await expect(page.locator("#cfg-model-options")).toContainText("edited-account-model");
  await expect(page.locator("#cfg-model-options")).not.toContainText("original-account-model");
  await page.clock.runFor(1000);
  expect((await directoryRequests(page)).length).toBe(before + 1, "resuming must not leave a second debounce request behind");
  expect(await configRequestCount(page)).toBe(configReads);
});

test("onboarding is reinserted after the complete app rebuilds the chat welcome view", async ({ page }) => {
  await openApp(page);
  await expect(page.locator("#welcome .welcome-onboarding")).toHaveCount(1);
  await page.evaluate(() => { window.__oldWelcome = document.querySelector("#welcome"); });
  await page.locator("#btn-new").click();
  await expect(page.locator("#welcome .welcome-onboarding")).toHaveCount(1);
  expect(await page.evaluate(() => window.__oldWelcome === document.querySelector("#welcome"))).toBe(false);
  await page.locator('[data-onboarding-action="summarize"]').click();
  await expect(page.locator("#input")).toHaveValue(/世界主要城市未来 7 天天气/);
});

test("Skill tool identities remain available when the optional Skills workspace is omitted", async ({ page }) => {
  await openApp(page, ["skills"]);
  await expect(page.locator('[data-tab="skills"], #skills-panel')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__qzPostedMessages
    .filter(message => message.type === "list_plugin_contributions").length)).toBeGreaterThan(0);
  const title = await page.evaluate(async () => {
    const registry = await import("/extension/sidepanel/tools/skill-tool-ui-registry.js");
    window.__qzEmitPortMessage({ type: "plugin_registry_update", snapshot: {
      plugins: [{ id: "optional-workspace-test", tools: [{ name: "standalone_skill_tool", title: "独立技能工具" }] }],
    } });
    return registry.getSkillToolUiMeta("standalone_skill_tool")?.tool.title;
  });
  expect(title).toBe("独立技能工具");
  await page.locator("#input").fill("工具展示不依赖管理页");
  await expect(page.locator("#input")).toHaveValue("工具展示不依赖管理页");
});
