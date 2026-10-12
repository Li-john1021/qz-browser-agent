import { expect, test } from "./sidepanel-fixtures.mjs";

const models = [
  { id: "model-alpha", label: "Alpha Model" },
  { id: "model-beta", label: "Beta Model" },
  { id: "model-gamma", label: "Gamma Model" },
];

test.use({
  viewport: { width: 430, height: 900 },
  sidepanelChromeOptions: {
    config: { provider: "deepseek", apiKey: "fixture-key", model: "", contextWindow: 128_000, vision: false },
    modelCapabilityMatch: { matched: true, contextWindow: 128_000, vision: false },
  },
});

async function openModelSettings(page) {
  await page.locator("#btn-settings").click();
  await page.waitForFunction(() => window.__qzPostedMessages.some(message => message.type === "list_models"));
  await page.evaluate(models => {
    const request = window.__qzPostedMessages.find(message => message.type === "list_models");
    window.__qzEmitPortMessage({ type: "models", requestId: request.requestId, provider: request.provider, models });
  }, models);
  await expect(page.locator("#cfg-model")).not.toHaveAttribute("title", /正在获取/);
}

async function chooseModel(page, model, { touch = false } = {}) {
  const input = page.locator("#cfg-model");
  await input.fill(model.label.split(" ")[0]);
  const option = page.locator("#cfg-model-options").getByRole("option", { name: model.label, exact: true });
  if (touch) await option.tap();
  else await option.click();
  await expect(input).toHaveValue(model.label);
  await expect(input).toHaveAttribute("data-model-id", model.id);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#cfg-model-options")).toBeHidden();
}

async function expectFullMenu(page, selected) {
  const input = page.locator("#cfg-model");
  await expect(page.locator("#cfg-model-options")).toBeVisible();
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveText(models.map(model => model.label));
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveValue(selected.label);
  await expect(input).toHaveAttribute("data-model-id", selected.id);
}

test("one arrow click reopens all models after every selection", async ({ page }) => {
  await openModelSettings(page);
  for (const model of models) {
    await chooseModel(page, model);
    await expect(page.locator("#cfg-model")).toBeFocused();
    await page.locator("#cfg-model-toggle").click();
    await expectFullMenu(page, model);
    await page.locator("#cfg-model-toggle").click();
    await expect(page.locator("#cfg-model-options")).toBeHidden();
  }
});

test("one arrow click also reopens after the selected model loses focus", async ({ page }) => {
  await openModelSettings(page);
  await chooseModel(page, models[1]);
  await page.locator("#cfg-apikey").click();
  await page.locator("#cfg-model-toggle").click();
  await expectFullMenu(page, models[1]);
});

test("one input click reopens the selected model without editing its identity", async ({ page }) => {
  await openModelSettings(page);
  await chooseModel(page, models[1]);
  await page.locator("#cfg-model").click();
  await expectFullMenu(page, models[1]);
});

test("one arrow key reopens after selection and Escape keeps the selected model", async ({ page }) => {
  await openModelSettings(page);
  for (const [index, key] of ["ArrowDown", "ArrowUp"].entries()) {
    await chooseModel(page, models[index]);
    await page.locator("#cfg-model").press(key);
    await expectFullMenu(page, models[index]);
    await page.locator("#cfg-model").press("Escape");
    await expect(page.locator("#cfg-model-options")).toBeHidden();
    await expect(page.locator("#settings-panel")).toBeVisible();
    await expect(page.locator("#cfg-model")).toHaveAttribute("data-model-id", models[index].id);
  }
  await page.locator("#cfg-model").press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
});

test("typing resumes filtering and exact input stays closed on focus alone", async ({ page }) => {
  await openModelSettings(page);
  await chooseModel(page, models[1]);
  await page.locator("#cfg-model-toggle").click();
  await expectFullMenu(page, models[1]);

  const input = page.locator("#cfg-model");
  await input.fill("Ga");
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveText(["Gamma Model"]);
  await expect(input).not.toHaveAttribute("data-model-id");
  await input.fill("Gamma Model");
  await expect(page.locator("#cfg-model-options")).toBeHidden();
  await page.locator("#cfg-apikey").click();
  await input.focus();
  await expect(page.locator("#cfg-model-options")).toBeHidden();
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await input.press("ArrowDown");
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveText(models.map(model => model.label));
  await input.fill("Be");
  await expect(page.locator("#cfg-model-options").getByRole("option")).toHaveText(["Beta Model"]);
});

test("IME confirmation does not select a model or move the active suggestion", async ({ page }) => {
  await openModelSettings(page);
  const input = page.locator("#cfg-model");
  await input.fill("Model");
  const activeId = await input.getAttribute("aria-activedescendant");
  for (const key of ["ArrowDown", "Enter"]) {
    await input.dispatchEvent("keydown", { key, isComposing: true });
    await expect(input).toHaveValue("Model");
    await expect(input).not.toHaveAttribute("data-model-id");
    await expect(input).toHaveAttribute("aria-activedescendant", activeId);
    await expect(page.locator("#cfg-model-options")).toBeVisible();
  }
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("one tap reopens after touch selection and after moving focus away", async ({ page }) => {
    await openModelSettings(page);
    for (const model of models.slice(0, 2)) {
      await chooseModel(page, model, { touch: true });
      await page.locator("#cfg-model-toggle").tap();
      await expectFullMenu(page, model);
      await page.locator("#cfg-apikey").tap();
      await expect(page.locator("#cfg-model-options")).toBeHidden();
      await page.locator("#cfg-model-toggle").tap();
      await expectFullMenu(page, model);
    }
  });
});
