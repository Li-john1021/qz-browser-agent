import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

test("assembled capability templates and their live clones keep unique DOM identities", async ({ page }) => {
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false, config: {
    provider: "custom", apiKey: "synthetic-key", model: "dom-contract", contextWindow: 128000,
    customProtocol: "openai", customEndpoint: "https://example.invalid/v1/chat/completions", presets: [],
  } });
  await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  const result = await page.evaluate(async () => {
    const html = await fetch(location.href).then(response => response.text());
    const source = new DOMParser().parseFromString(html, "text/html");
    const duplicateIds = root => {
      const counts = new Map();
      for (const element of root.querySelectorAll("[id]")) counts.set(element.id, (counts.get(element.id) || 0) + 1);
      return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
    };
    const templates = [];
    function cloneTemplates(root) {
      for (const template of root.querySelectorAll("template")) {
        templates.push({ id: template.id, duplicates: duplicateIds(template.content), ids: [...template.content.querySelectorAll("[id]")].map(element => element.id) });
        const clone = template.content.cloneNode(true);
        cloneTemplates(clone);
        template.after(clone);
      }
    }
    cloneTemplates(source);
    return { templates, cloned: duplicateIds(source), live: duplicateIds(document) };
  });
  expect(result.templates.map(item => item.id)).toEqual(expect.arrayContaining(["settings-ui-template", "i18n-language-template"]));
  for (const template of result.templates) expect(template.duplicates, `duplicate IDs inside ${template.id}`).toEqual([]);
  expect(result.templates.flatMap(item => item.ids)).toEqual(expect.arrayContaining(["cfg-model", "i18n-language-select"]));
  expect(result.cloned, "package templates cloned once must not collide with each other or static DOM").toEqual([]);
  expect(result.live, "actual package mounts must retain unique IDs").toEqual([]);
  await expect(page.locator("#cfg-model")).toHaveCount(1);
  await expect(page.locator("#i18n-language-select")).toHaveCount(1);
  for (let index = 0; index < 2; index += 1) {
    await page.locator("#btn-settings").click();
    await page.locator("#btn-close-settings").click();
    await page.locator("#btn-new").click();
    await expect(page.locator("#welcome .welcome-onboarding")).toHaveCount(1);
  }
  expect(await page.evaluate(() => {
    const counts = new Map();
    for (const element of document.querySelectorAll("[id]")) counts.set(element.id, (counts.get(element.id) || 0) + 1);
    return [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  }), "repeated settings display and chat welcome cloning cannot duplicate IDs").toEqual([]);
});
