import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

test("model list failures silently preserve manual model input", async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, {
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      vision: false,
    },
    listModelsError: "models.dev unavailable",
  });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));

  await page.locator("#btn-settings").click();
  const input = page.locator("#cfg-model");
  await expect(input).toHaveValue("deepseek-v4-flash");
  await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "list_models"));
  await expect(input).not.toHaveAttribute("title");
  await expect(page.getByText("models.dev unavailable")).toHaveCount(0);
  await expect(page.getByText(/模型列表获取失败|未获取到模型列表/u)).toHaveCount(0);

  await input.fill("unknown-model-without-capabilities");
  await expect(input).toHaveValue("unknown-model-without-capabilities");
  await expect(page.locator("#cfg-context-preset")).toHaveValue("");
  await expect(page.locator("#cfg-vision")).toHaveValue("false");
  await expect(page.locator("#settings-save-status")).toHaveText("请选择上下文长度");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();

  await page.locator("#cfg-context-preset").selectOption("256K");
  await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
});
