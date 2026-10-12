import { expect, test } from "./fixtures.mjs";

const sceneNames = [
  "header",
  "chat",
  "onboarding",
  "goal",
  "waiting",
  "timeline",
  "sessions",
  "data",
  "settings",
  "forms",
  "editing",
  "filters",
  "resources",
  "automation",
  "lightbox",
  "tokens",
];

const variants = [
  { name: "desktop light", colorScheme: "light", viewport: { width: 820, height: 620 } },
  { name: "narrow light", colorScheme: "light", viewport: { width: 340, height: 720 } },
  { name: "desktop dark", colorScheme: "dark", viewport: { width: 820, height: 620 } },
  { name: "narrow dark", colorScheme: "dark", viewport: { width: 340, height: 720 } },
];

for (const variant of variants) {
  test.describe(`button system · ${variant.name}`, () => {
    test.use({ viewport: variant.viewport, colorScheme: variant.colorScheme });

    test("keeps layout and interaction semantics", async ({ page }, testInfo) => {
      await page.goto("/tests/button-system/smoke.html", { waitUntil: "networkidle" });
      const status = page.locator("#status");
      await expect(status).toHaveAttribute("data-result", "pass");

      const smoke = await page.evaluate(() => window.__buttonSystemSmoke);
      expect(smoke.failures).toEqual([]);

      const layout = await page.evaluate(() => ({
        sceneNames: [...document.querySelectorAll("[data-scene]")].map(scene => scene.dataset.scene),
        clippedButtons: [...document.querySelectorAll("[data-scene] button")]
          .filter(button => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1)
          .map(button => button.getAttribute("aria-label") || button.textContent.trim()),
        overflowingScenes: [...document.querySelectorAll("[data-scene]")]
          .filter(scene => scene.scrollWidth > scene.clientWidth + 1)
          .map(scene => scene.dataset.scene),
      }));
      expect(layout.sceneNames).toEqual(sceneNames);
      expect(layout.clippedButtons).toEqual([]);
      expect(layout.overflowingScenes).toEqual([]);

      const semantics = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--red)";
        document.body.append(probe);
        const red = getComputedStyle(probe).color;
        probe.remove();
        const style = id => getComputedStyle(document.getElementById(id));
        const contrast = (foreground, background) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1;
          canvas.height = 1;
          const context = canvas.getContext("2d");
          context.fillStyle = background;
          context.fillRect(0, 0, 1, 1);
          context.fillStyle = foreground;
          context.fillRect(0, 0, 1, 1);
          const [redChannel, greenChannel, blueChannel] = context.getImageData(0, 0, 1, 1).data;
          const linear = value => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          };
          const foregroundLuminance = 0.2126 * linear(redChannel) + 0.7152 * linear(greenChannel) + 0.0722 * linear(blueChannel);

          context.fillStyle = background;
          context.fillRect(0, 0, 1, 1);
          const [backgroundRed, backgroundGreen, backgroundBlue] = context.getImageData(0, 0, 1, 1).data;
          const backgroundLuminance = 0.2126 * linear(backgroundRed) + 0.7152 * linear(backgroundGreen) + 0.0722 * linear(backgroundBlue);
          const light = Math.max(foregroundLuminance, backgroundLuminance);
          const dark = Math.min(foregroundLuminance, backgroundLuminance);
          return (light + 0.05) / (dark + 0.05);
        };
        const checkbox = style("form-checkbox");
        const radio = style("form-radio");
        const field = style("form-field");
        const choiceHoverProbe = document.createElement("span");
        choiceHoverProbe.style.border = "1px solid var(--choice-border-hover)";
        document.body.append(choiceHoverProbe);
        const choiceHoverBorder = getComputedStyle(choiceHoverProbe).borderTopColor;
        choiceHoverProbe.remove();
        return {
          primaryHasFill: style("primary").backgroundColor !== "rgba(0, 0, 0, 0)",
          primaryHasContrast: style("primary").backgroundColor !== style("primary").color,
          ghostBorder: style("ghost").borderTopColor,
          dangerMatchesToken: style("danger").color === red,
          checkboxBorder: checkbox.borderTopColor,
          radioBorder: radio.borderTopColor,
          choiceHoverBorder,
          choiceBorderContrast: contrast(checkbox.borderTopColor, checkbox.backgroundColor),
          fieldBorderContrast: contrast(field.borderTopColor, field.backgroundColor),
        };
      });
      expect(semantics).toMatchObject({
        primaryHasFill: true,
        primaryHasContrast: true,
        ghostBorder: "rgba(0, 0, 0, 0)",
        dangerMatchesToken: true,
      });
      expect(semantics.checkboxBorder).toBe(semantics.radioBorder);
      expect(semantics.choiceBorderContrast).toBeGreaterThan(semantics.fieldBorderContrast + 0.15);

      await page.locator("#primary").hover();
      const primaryHover = await computedInteraction(page, "#primary");
      expect(primaryHover).toEqual({ border: "rgba(0, 0, 0, 0)", transform: "none" });

      await page.locator("#secondary").hover();
      const secondaryHover = await computedInteraction(page, "#secondary");
      expect(secondaryHover.transform).toBe("none");

      await page.locator("#secondary").focus();
      await expect.poll(async () => (await computedFocus(page, "#secondary")).visible).toBe(true);
      await expect.poll(async () => (await computedFocus(page, "#secondary")).shadow)
        .not.toContain(" 0px 0px 0px 0px");
      const secondaryFocus = await computedFocus(page, "#secondary");
      expect(secondaryFocus.shadow).not.toBe("none");

      await page.locator("#form-field").focus();
      await expect.poll(async () => (await computedFocus(page, "#form-field")).visible).toBe(true);
      await expect.poll(async () => (await computedFocus(page, "#form-field")).shadow).not.toBe("none");
      const fieldFocus = await computedFocus(page, "#form-field");
      expect(fieldFocus.shadow).not.toBe("none");

      await page.locator("#form-checkbox").hover();
      await expect.poll(async () => computedBorder(page, "#form-checkbox")).toBe(semantics.choiceHoverBorder);
      await page.locator("#form-radio").hover();
      await expect.poll(async () => computedBorder(page, "#form-radio")).toBe(semantics.choiceHoverBorder);

      await page.mouse.move(0, 0);
      await page.locator("#form-checkbox").focus();
      await expect.poll(async () => (await computedFocus(page, "#form-checkbox")).visible).toBe(true);
      const checkboxFocus = await computedFocus(page, "#form-checkbox");
      expect(checkboxFocus.shadow).not.toBe("none");
      await expect.poll(async () => computedBorder(page, "#form-checkbox")).toBe(semantics.choiceHoverBorder);

      const overview = await page.screenshot({ fullPage: true });
      expect(overview.byteLength).toBeGreaterThan(1_500);
      await testInfo.attach("overview.png", { body: overview, contentType: "image/png" });
    });
  });
}

function computedInteraction(page, selector) {
  return page.locator(selector).evaluate(element => ({
    border: getComputedStyle(element).borderTopColor,
    transform: getComputedStyle(element).transform,
  }));
}

function computedFocus(page, selector) {
  return page.locator(selector).evaluate(element => ({
    visible: element.matches(":focus-visible"),
    shadow: getComputedStyle(element).boxShadow,
  }));
}

function computedBorder(page, selector) {
  return page.locator(selector).evaluate(element => getComputedStyle(element).borderTopColor);
}
