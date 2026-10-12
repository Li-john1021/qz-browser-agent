import { expect, test as base } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

export const test = base.extend({
  sidepanelChromeOptions: [{}, { option: true }],
  sidepanelBenchmarkReady: [async ({ page, sidepanelChromeOptions }, use) => {
    await page.addInitScript(installBenchmarkChromeStub, sidepanelChromeOptions);
    await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
    await use();
  }, { auto: true }],
});

export { expect };
