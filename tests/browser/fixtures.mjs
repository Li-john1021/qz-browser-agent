import { expect, test as base } from "@playwright/test";
import { providerMenuFixtures } from "../support/provider-menu-fixture.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import {
  collectPageV8Coverage,
  createBrowserV8CoverageCollector,
} from "../support/browser-v8-coverage.mjs";

const testOrigin = `http://127.0.0.1:${Number(process.env.QINGZHOU_TEST_PORT || 4173)}`;
let providerMenuScript;

export function testAssetUrl(path) {
  return new URL(String(path || "").replace(/^\/+/, ""), `${testOrigin}/`).href;
}

export const test = base.extend({
  providerMenus: [async ({ page }, use) => {
    const menus = await providerMenuFixtures(await ensureTestExtension());
    // The immutable catalogs are serialized once; each page receives fresh objects.
    providerMenuScript ??= `window.__qzProviderMenus = ${JSON.stringify(menus)};`;
    await page.addInitScript({ content: providerMenuScript });
    await use(menus);
  }, { auto: true }],
  browserV8Coverage: [async ({}, use, workerInfo) => {
    const collector = createBrowserV8CoverageCollector({ workerIndex: workerInfo.workerIndex });
    await use(collector);
    await collector.flush();
  }, { scope: "worker" }],
  pageV8Coverage: [async ({ page, browserV8Coverage }, use) => {
    await collectPageV8Coverage(page, browserV8Coverage, use);
  }, { auto: true }],
  browserDiagnostics: [async ({ page }, use, testInfo) => {
    const diagnostics = { pageErrors: [], consoleErrors: [] };
    page.on("pageerror", error => diagnostics.pageErrors.push(String(error?.stack || error)));
    page.on("console", message => {
      if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
    });

    await use(diagnostics);

    if (diagnostics.pageErrors.length || diagnostics.consoleErrors.length) {
      await testInfo.attach("browser-diagnostics.json", {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: "application/json",
      });
    }
    expect(diagnostics.pageErrors, "unexpected page errors").toEqual([]);
    expect(diagnostics.consoleErrors, "unexpected console errors").toEqual([]);
  }, { auto: true }],
});

export { expect };
