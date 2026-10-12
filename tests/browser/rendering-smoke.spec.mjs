import { expect, test } from "./fixtures.mjs";

const viewports = {
  desktop: { width: 980, height: 900 },
  mobile: { width: 390, height: 844 },
};

const harnesses = [
  {
    name: "message rendering",
    path: "/tests/message-rendering/smoke.html",
    resultKey: "__messageRenderingSmoke",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "plugin renderers",
    path: "/tests/plugin-renderers/smoke.html",
    resultKey: "__pluginRendererSmoke",
    viewports: ["desktop", "mobile"],
  },
  {
    name: "MathJax rendering",
    path: "/tests/mathjax/smoke.html",
    resultKey: "__mathSmoke",
    viewports: ["desktop"],
  },
];

for (const harness of harnesses) {
  for (const viewportName of harness.viewports) {
    test.describe(`${harness.name} · ${viewportName}`, () => {
      test.use({ viewport: viewports[viewportName] });

      test("passes harness assertions", async ({ page }) => {
        await page.goto(harness.path, { waitUntil: "networkidle" });
        const status = page.locator("#status");
        await expect(status).toHaveAttribute("data-result", /.+/);
        await expect(status).toContainText(/^PASS\b/);

        const result = await page.evaluate(resultKey => window[resultKey], harness.resultKey);
        expect(result, `${harness.name} should publish its structured result`).toBeTruthy();
        expect(result.failures || [], `${harness.name} internal assertions`).toEqual([]);
      });
    });
  }
}
