import { expect, test } from "./fixtures.mjs";

const variants = [
  { name: "wide light", colorScheme: "light", viewport: { width: 660, height: 620 } },
  { name: "narrow light", colorScheme: "light", viewport: { width: 390, height: 620 } },
  { name: "wide dark", colorScheme: "dark", viewport: { width: 660, height: 620 } },
  { name: "narrow dark", colorScheme: "dark", viewport: { width: 390, height: 620 } },
];

for (const variant of variants) {
  test.describe(`plugin summary renderer · ${variant.name}`, () => {
    test.use({ colorScheme: variant.colorScheme, viewport: variant.viewport });

    test("keeps long stat values inside their cells", async ({ page }, testInfo) => {
      await page.goto("/tests/plugin-renderers/smoke.html", { waitUntil: "networkidle" });
      await expect(page.locator("#status")).toContainText(/^PASS\b/);

      const summary = page.locator('[data-case="summary"]');
      await expect(summary).toBeVisible();
      const metrics = await summary.evaluate(root => {
        const grid = root.querySelector(".tool-stat-grid");
        const cells = [...root.querySelectorAll(".tool-stat-item")].map(cell => {
          const value = cell.querySelector("b");
          const cellRect = cell.getBoundingClientRect();
          const valueRect = value.getBoundingClientRect();
          const style = getComputedStyle(value);
          return {
            label: cell.querySelector("em")?.textContent || "",
            title: value.title,
            cellRight: cellRect.right,
            valueRight: valueRect.right,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
          };
        });
        return {
          gridOverflow: grid.scrollWidth - grid.clientWidth,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cells,
        };
      });

      expect(metrics.gridOverflow).toBeLessThanOrEqual(1);
      expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
      expect(metrics.cells).toHaveLength(3);
      for (const cell of metrics.cells) {
        expect(cell.valueRight).toBeLessThanOrEqual(cell.cellRight + 0.5);
        expect(cell.overflow).toBe("hidden");
        expect(cell.textOverflow).toBe("ellipsis");
        expect(cell.whiteSpace).toBe("nowrap");
      }
      expect(metrics.cells.find(cell => cell.label === "Instance")?.title).toBe("2026071701474721gzbg3fjzyzc");

      await testInfo.attach(`plugin-summary-${variant.name.replace(/\s+/g, "-")}.png`, {
        body: await summary.screenshot(),
        contentType: "image/png",
      });
    });
  });
}

test("escapes quoted stat values in the title attribute", async ({ page }) => {
  await page.goto("/tests/plugin-renderers/smoke.html", { waitUntil: "networkidle" });
  await expect(page.locator("#status")).toContainText(/^PASS\b/);

  const result = await page.evaluate(async () => {
    const { renderToolEvent } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const value = 'instance" autofocus data-injected="yes';
    const event = renderToolEvent({
      name: "renderer_smoke__summary",
      args: {},
      result: {
        title: "Attribute boundary",
        subtitle: "Quoted metric",
        instanceId: value,
        status: "SUCCESS",
        elapsed: "1 s",
      },
    }, { expanded: true, standaloneFooter: false });
    document.body.append(event);
    const metric = [...event.querySelectorAll(".tool-stat-item")]
      .find(item => item.querySelector("em")?.textContent === "Instance");
    const valueElement = metric?.querySelector("b");
    return {
      title: valueElement?.getAttribute("title") || "",
      autofocus: valueElement?.hasAttribute("autofocus") || false,
      injected: valueElement?.hasAttribute("data-injected") || false,
    };
  });

  expect(result).toEqual({
    title: 'instance" autofocus data-injected="yes',
    autofocus: false,
    injected: false,
  });
});
