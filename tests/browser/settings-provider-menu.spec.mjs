import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

const languages = ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "fr", "de", "pt-BR", "ru", "ar", "hi"];

for (const language of languages) test.describe(language, () => {
  test.use({ locale: language });
  test("provider declarations own the localized menu, including Codex", async ({ page, providerMenus }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    const localeMessages = JSON.parse(await readFile(join(await ensureTestExtension(), "_locales", language.replace("-", "_"), "messages.json"), "utf8"));
    await page.addInitScript(installBenchmarkChromeStub, { localeMessages });
    await page.goto("/extension/sidepanel/sidepanel.html");
    await page.locator("#btn-settings").click();
    const select = page.locator("#cfg-provider");
    await expect(select).toHaveValue("custom");
    await expect(select.locator("option")).toHaveCount(providerMenus[language].length);
    const entries = await select.locator("option").evaluateAll(options => options.map(option => ({
      id: option.value, label: option.textContent, group: option.parentElement.dataset.providerGroup || "",
      groupLabel: option.parentElement.label || "",
    })));
    const byId = (a, b) => a.id.localeCompare(b.id, "en");
    expect(entries.sort(byId)).toEqual(providerMenus[language].map(provider => ({
      id: provider.id, label: provider.label, group: provider.group?.id || "", groupLabel: provider.group?.label || "",
    })).sort(byId));
    const groupIds = await select.locator("optgroup").evaluateAll(groups => groups.map(group => group.dataset.providerGroup));
    const priorities = groupIds.map(id => Math.max(...providerMenus[language].filter(provider => provider.group?.id === id).map(provider => provider.group.priority || 0)));
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    const declaredGroups = [...new Set(providerMenus[language].map(provider => provider.group?.id).filter(Boolean))];
    expect([...groupIds].sort()).toEqual(declaredGroups.sort());
    const all = select.locator('optgroup[data-provider-group="all"]');
    expect(await all.locator("option").evaluateAll(options => options.map(option => option.value)))
      .toEqual(expect.arrayContaining(["fireworks", "openaicodex", "opencodego", "opencodezen"]));
    await chooseProvider(page, "openaicodex");
    await expect(select).toHaveValue("openaicodex");
    await expect(page.locator("#btn-provider-login")).toBeVisible();
    if (["en", "zh-CN"].includes(language)) {
      const output = resolve("tests/results/provider-picker");
      await mkdir(output, { recursive: true });
      await page.locator("#cfg-provider-trigger").click();
      await page.locator("#cfg-provider-picker").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({ path: join(output, `catalog-${language}-${colorScheme}-320.png`), animations: "disabled" });
      }
      await page.locator("#cfg-provider-search").fill("open");
      await page.screenshot({ path: join(output, `catalog-${language}-search-320.png`), animations: "disabled" });
    }
  });
});

test("refresh replaces stale entries and group labels without losing the configured provider", async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub);
  await page.goto("/extension/sidepanel/sidepanel.html");
  await page.locator("#btn-settings").click();
  const provider = (id, group) => ({ id, label: id, requiresApiKey: true, group });
  const providers = [
    provider("selected", { id: "z", label: "Zulu" }),
    provider("remove", { id: "z", label: "Zulu" }),
    provider("alpha", { id: "a", label: "Alpha" }),
    provider("first", { id: "first", label: "First", priority: 1 }),
    provider("ungrouped"),
  ];
  const emit = providers => page.evaluate(providers => window.__qzEmitPortMessage({ type: "config", config: {
    provider: "selected", model: "test-model", providers,
  } }), providers);
  const select = page.locator("#cfg-provider");
  await emit(providers);
  await expect(select).toHaveValue("selected");
  expect(await select.locator("optgroup").evaluateAll(groups => groups.map(group => group.label)))
    .toEqual(["First", "Alpha", "Zulu"]);
  await expect(select.locator(":scope > option")).toHaveText("ungrouped");

  await emit([{ ...providers[0], label: "Updated provider", group: { id: "new", label: "Updated group" } }]);
  await expect(select).toHaveValue("selected");
  await expect(select.locator("option")).toHaveCount(1);
  await expect(select.locator("option")).toHaveText("Updated provider");
  await expect(select.locator("optgroup")).toHaveAttribute("label", "Updated group");
  await emit([]);
  await expect(select.locator("option, optgroup")).toHaveCount(0);
});
