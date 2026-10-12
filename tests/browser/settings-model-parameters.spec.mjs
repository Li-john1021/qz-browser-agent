import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`model parameters editor · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 900 } });

    test("edits typed parameters with a compact Qingzhou suggestion menu", async ({ page }) => {
      await page.addInitScript(installBenchmarkChromeStub, {
        config: {
          provider: "deepseek",
          apiKey: "test-key",
          model: "deepseek-v4-flash",
          modelParameters: { temperature: 0.2 },
          contextWindow: 1_000_000,
          vision: false,
          trimOldToolResults: true,
          requestRateLimit: false,
          debugMode: false,
        },
      });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await page.locator("#btn-settings").click();

      const editor = page.locator(".model-parameters-editor");
      const addButton = page.locator("#btn-add-model-parameter");
      const rows = page.locator(".model-parameter-row");
      await expect(page.locator("#cfg-model-parameters-label")).toBeVisible();
      await expect(page.locator("#cfg-model-parameters-label")).toHaveText("自定义参数");
      await expect(addButton).toHaveText("＋ 添加自定义参数");
      await expect(rows).toHaveCount(1);
      await expect(rows.nth(0).locator('[data-model-parameter-field="key"]')).toHaveValue("temperature");
      await expect(rows.nth(0).locator('[data-model-parameter-field="value"]')).toHaveValue("0.2");
      await expect(page.getByText(/参数按 JSON 类型透传/u)).toHaveCount(0);
      await expect(page.locator("#cfg-model-parameter-keys")).toHaveCount(0);

      const menu = page.locator("#cfg-model-parameter-suggestions");
      await rows.nth(0).locator('[data-model-parameter-field="value"]').click();
      await expect(menu.locator("[data-model-parameter-suggestion-index]")).toHaveCount(4);

      const placement = await editor.evaluate((element) => {
        const visionElement = element.previousElementSibling;
        const vision = visionElement?.getBoundingClientRect();
        const visionLabel = visionElement?.querySelector(".qz-field-label")?.getBoundingClientRect();
        const visionControl = visionElement?.querySelector(".qz-field")?.getBoundingClientRect();
        const editorRect = element.getBoundingClientRect();
        const parameterLabel = element.querySelector(".qz-field-label")?.getBoundingClientRect();
        const row = element.querySelector(".model-parameter-row")?.getBoundingClientRect();
        const add = element.querySelector("#btn-add-model-parameter")?.getBoundingClientRect();
        return {
          fieldGap: (editorRect?.top || 0) - (vision?.bottom || 0),
          visionControlGap: (visionControl?.top || 0) - (visionLabel?.bottom || 0),
          parameterControlGap: (row?.top || 0) - (parameterLabel?.bottom || 0),
          parameterActionGap: (add?.top || 0) - (row?.bottom || 0),
          addColor: getComputedStyle(element.querySelector("#btn-add-model-parameter")).color,
        };
      });
      expect(placement.fieldGap).toBeGreaterThanOrEqual(5);
      expect(placement.fieldGap).toBeLessThanOrEqual(7);
      expect(Math.abs(placement.parameterControlGap - placement.visionControlGap)).toBeLessThanOrEqual(1);
      expect(placement.parameterActionGap).toBeGreaterThanOrEqual(4);
      expect(placement.addColor).toBeTruthy();

      await addButton.click();
      await expect(menu).toBeVisible();
      expect(await menu.locator("[data-model-parameter-suggestion-index]").count()).toBeGreaterThan(20);
      const reasoningRow = rows.nth(1);
      const reasoningKey = reasoningRow.locator('[data-model-parameter-field="key"]');
      await reasoningKey.fill("reas");
      await expect(menu).toBeVisible();
      await expect(menu.getByText("reasoning_effort", { exact: true })).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(7);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(423);
      await menu.getByText("reasoning_effort", { exact: true }).click();
      const reasoningValue = reasoningRow.locator('[data-model-parameter-field="value"]');
      await expect(reasoningValue).toBeFocused();
      await expect(menu.getByText("high", { exact: true })).toBeVisible();
      await menu.getByText("high", { exact: true }).click();
      await expect(reasoningKey).toHaveValue("reasoning_effort");
      await expect(reasoningValue).toHaveValue("high");

      await addButton.click();
      const thinkingRow = rows.nth(2);
      const thinkingKey = thinkingRow.locator('[data-model-parameter-field="key"]');
      const thinkingValue = thinkingRow.locator('[data-model-parameter-field="value"]');
      await thinkingKey.fill("think");
      await thinkingKey.press("ArrowDown");
      await thinkingKey.press("Enter");
      await expect(thinkingKey).toHaveValue("thinking");
      await thinkingValue.fill("budget_tokens");
      await thinkingValue.press("ArrowDown");
      await thinkingValue.press("Enter");
      await expect(thinkingValue).toHaveValue('{"type":"enabled","budget_tokens":4096}');
      await rows.nth(0).locator('[data-model-parameter-field="value"]').fill("0.7");
      await expect(page.locator("#settings-save-status")).toHaveText("有未保存修改");

      await addButton.click();
      const reservedRow = rows.nth(3);
      await reservedRow.locator('[data-model-parameter-field="key"]').fill("messages");
      await reservedRow.locator('[data-model-parameter-field="value"]').fill("[]");
      await expect(page.locator("#settings-save-status")).toContainText("messages 由轻舟管理");
      await expect(page.locator("#btn-save-settings")).toBeDisabled();
      await reservedRow.locator("[data-remove-model-parameter]").click();
      await expect(page.locator("#btn-save-settings")).toBeEnabled();

      await reasoningKey.focus();
      await expect(menu).toBeVisible();
      await reasoningKey.press("Escape");
      await expect(menu).toBeHidden();
      await expect(page.locator("#settings-panel")).toBeVisible();

      await page.locator("#btn-save-settings").click();
      await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "save_config"));
      const saved = await page.evaluate(() => {
        return window.__qzPostedMessages.filter(message => message.type === "save_config").at(-1)?.config;
      });
      expect(saved.modelParameters).toEqual({
        temperature: 0.7,
        reasoning_effort: "high",
        thinking: { type: "enabled", budget_tokens: 4096 },
      });
      expect(Object.keys(saved).some(key => key.startsWith("_modelParameters"))).toBe(false);
    });
  });
}

test("reveals the custom-parameter label only while parameters exist", async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, {
    config: {
      provider: "deepseek",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      modelParameters: {},
      contextWindow: 1_000_000,
      vision: false,
      trimOldToolResults: true,
      requestRateLimit: false,
      debugMode: false,
    },
  });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
  await page.locator("#btn-settings").click();

  const label = page.locator("#cfg-model-parameters-label");
  await expect(label).toBeHidden();
  await page.locator("#btn-add-model-parameter").click();
  await expect(label).toBeVisible();
  await page.locator("[data-remove-model-parameter]").click();
  await expect(label).toBeHidden();
});
