import { expect, test } from "./sidepanel-fixtures.mjs";
import { chooseProvider } from "./provider-picker-fixture.mjs";

for (const colorScheme of ["light", "dark"]) {
  test.describe(`custom endpoint autocomplete · ${colorScheme}`, () => {
    test.use({ colorScheme, viewport: { width: 430, height: 900 } });

    test("completes OpenAI and Anthropic endpoint paths without disturbing custom paths", async ({ page }, testInfo) => {
      await page.locator("#btn-settings").click();
      await chooseProvider(page, "custom");

      const endpoint = page.locator("#cfg-custom-endpoint");
      const completion = page.locator("#cfg-custom-endpoint-completion");
      await endpoint.fill("https://router.example/openai/v1");
      await expect(completion).toBeVisible();
      await expect(completion).toHaveText("/chat/completions");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const layout = await completion.evaluate((element) => {
        const completionRect = element.getBoundingClientRect();
        const inputRect = document.querySelector("#cfg-custom-endpoint")?.getBoundingClientRect();
        return {
          top: completionRect.top,
          bottom: completionRect.bottom,
          inputTop: inputRect?.top || 0,
          inputBottom: inputRect?.bottom || 0,
          valueLeft: completionRect.left,
          valueRight: completionRect.right,
          inputRight: inputRect?.right || 0,
          pointerEvents: getComputedStyle(element).pointerEvents,
        };
      });
      expect(layout.top).toBeGreaterThanOrEqual(layout.inputTop - 1);
      expect(layout.bottom).toBeLessThanOrEqual(layout.inputBottom + 1);
      expect(layout.valueLeft).toBeGreaterThan(0);
      expect(layout.valueRight).toBeLessThanOrEqual(layout.inputRight - 5);
      expect(layout.pointerEvents).toBe("none");

      await testInfo.attach(`custom-endpoint-suggestion-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      await endpoint.press("Tab");
      await expect(endpoint).toHaveValue("https://router.example/openai/v1/chat/completions");
      await expect(completion).toBeHidden();
      await expect(endpoint).toHaveClass(/is-auto-completed/);

      await page.locator("#cfg-custom-protocol").selectOption("anthropic");
      await expect(endpoint).toHaveValue("https://router.example/openai/v1/messages");

      await endpoint.fill("asdfasdf.com/v1");
      await expect(completion).toHaveText("/messages");
      await endpoint.press("Tab");
      await expect(endpoint).toHaveValue("https://asdfasdf.com/v1/messages");

      await endpoint.fill("https://api.anthropic.com");
      await expect(completion).toHaveText("/v1/messages");
      await endpoint.press("Tab");
      await expect(endpoint).toHaveValue("https://api.anthropic.com/v1/messages");

      await endpoint.fill("https://router.example/proxy/v1/");
      await expect(completion).toHaveText("messages");
      await endpoint.press("ArrowRight");
      await expect(endpoint).toHaveValue("https://router.example/proxy/v1/messages");

      await endpoint.fill("https://router.example/proxy/v1");
      await expect(completion).toHaveText("/messages");
      await endpoint.press("ArrowRight");
      await expect(endpoint).toHaveValue("https://router.example/proxy/v1/messages");

      await endpoint.fill("https://router.example/blur/v1");
      await page.locator("#cfg-model").focus();
      await expect(endpoint).toHaveValue("https://router.example/blur/v1/messages");
      await expect(completion).toBeHidden();

      await page.locator("#cfg-custom-protocol").selectOption("openai");
      const longPrefix = "https://router.example/tenant/with/a/long/routing/prefix/v1";
      await endpoint.fill(longPrefix);
      await expect(completion).toHaveText("/chat/completions");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const longLayout = await endpoint.evaluate((input) => {
        const inputRect = input.getBoundingClientRect();
        const valueRect = document.querySelector("#cfg-custom-endpoint-completion")?.getBoundingClientRect();
        return {
          scrollLeft: input.scrollLeft,
          inputLeft: inputRect.left,
          valueLeft: valueRect?.left || 0,
          valueRight: valueRect?.right || 0,
          inputRight: inputRect.right,
        };
      });
      expect(longLayout.scrollLeft).toBeGreaterThan(0);
      expect(longLayout.valueLeft).toBeGreaterThanOrEqual(longLayout.inputLeft);
      expect(longLayout.valueRight).toBeLessThanOrEqual(longLayout.inputRight - 5);
      await endpoint.press("Tab");
      await expect(endpoint).toHaveValue(`${longPrefix}/chat/completions`);

      await endpoint.fill("https://router.example/custom/generate");
      await expect(completion).toBeHidden();
      await expect(endpoint).toHaveValue("https://router.example/custom/generate");
    });
  });
}
