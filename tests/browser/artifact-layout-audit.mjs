import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "./fixtures.mjs";

const output = resolve("tests/results/i18n/artifacts-review");

/** Check text against its own grid/flex cell as well as the viewport; page width misses overlaps. */
export async function captureArtifactLayout(page, selector, scenario, testInfo) {
  const { language, colorScheme, width } = scenario;
  const name = `${language}-${colorScheme}-${width}-${scenario.scenario}`;
  const root = page.locator(selector).first();
  await root.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.fonts.ready);
  const report = await root.evaluate(element => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const describe = node => node.id || node.className || node.tagName;
    const productLabels = ".artifact-strip-title, .artifact-strip-count, .artifact-strip-kind, .artifact-strip-name small, .artifact-strip-actions button, .artifacts-header h3, .artifacts-row-kind, .artifacts-row-meta, .artifact-row-action, .artifacts-summary, .automation-artifact-kind, .automation-artifact-line-kind, .automation-artifact-meta, .automation-artifact-open, .automation-artifact-line-open, .automation-artifact-shelf-title";
    const problems = [];
    for (const label of element.querySelectorAll(productLabels)) {
      if (!visible(label)) continue;
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      let text;
      while ((text = walker.nextNode())) {
        if (!text.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        const rects = [...range.getClientRects()];
        let ancestor = text.parentElement;
        while (ancestor) {
          const bounds = ancestor.getBoundingClientRect();
          if (rects.some(rect => rect.left < bounds.left - 1.5 || rect.right > bounds.right + 1.5
            || rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2)) {
            problems.push({ element: describe(label), container: describe(ancestor), text: text.textContent.trim(), reason: "text exceeds its cell" });
            break;
          }
          if (ancestor === element) break;
          ancestor = ancestor.parentElement;
        }
      }
    }
    for (const title of element.querySelectorAll(".artifact-strip-name > span, .artifacts-row-title, .automation-artifact-name")) {
      if (visible(title) && title.textContent.trim() && title.getBoundingClientRect().width < 23
        && title.scrollWidth > title.clientWidth + 1) {
        problems.push({ element: describe(title), text: title.textContent, reason: "title squeezed below two characters" });
      }
    }
    const viewportOverflow = [...element.querySelectorAll(".artifact-strip-item, .artifacts-row, .automation-artifact-row, button")]
      .filter(visible).filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.left < -1 || rect.right > innerWidth + 1;
      }).map(describe);
    return { problems, viewportOverflow, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  });
  await mkdir(output, { recursive: true });
  await root.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  await page.screenshot({ path: resolve(output, `${name}-page.png`), animations: "disabled" });
  await writeFile(resolve(output, `${name}.json`), JSON.stringify({ ...scenario, ...report }, null, 2));
  await testInfo.attach(`${name}.png`, { path: resolve(output, `${name}.png`), contentType: "image/png" });
  expect.soft(report.problems, `${name}: text fits its own cell without covering adjacent content`).toEqual([]);
  expect.soft(report.viewportOverflow, `${name}: rows and controls stay in the side panel`).toEqual([]);
  expect.soft(report.pageWidth, `${name}: no horizontal page overflow`).toBeLessThanOrEqual(report.viewportWidth);
}
