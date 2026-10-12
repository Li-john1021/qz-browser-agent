import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Instrument only the test driver; both product revisions retain their original source bytes.
export function instrumentComparisonDriver(source) {
  const edits = [
    ['browser.newContext({ viewport: VIEWPORT, colorScheme: COLOR_SCHEME })',
      'browser.newContext({ viewport: VIEWPORT, colorScheme: COLOR_SCHEME, locale: "zh-CN", timezoneId: "Asia/Shanghai", deviceScaleFactor: 1 })'],
    ['const pageErrors = [];', `const pageErrors = [];
  const resourceErrors = [];
  page.on("requestfailed", request => resourceErrors.push({ url: request.url(), failure: request.failure()?.errorText || "request failed" }));
  page.on("response", response => { if (response.status() >= 400) resourceErrors.push({ url: response.url(), status: response.status() }); });`],
    ['stage: "conversation-render",', 'stage: "conversation-render", browserVersion: browser.version(),'],
    ['    pageErrors,', '    pageErrors, resourceErrors,'],
    ['if (!group) {\n      return {\n        ok: false,\n        reason: "no-tool-timeline",', `if (!group) {
      const single = document.querySelector(".msg-tool:not(.msg-tool-timeline)");
      const summary = single?.querySelector(":scope > .tool-summary");
      if (summary) {
        summary.click();
        await settle();
        const details = single.querySelector(":scope > .tool-details");
        const expanded = summary.getAttribute("aria-expanded") === "true" && details && !details.classList.contains("hidden");
        const raw = single.querySelector(".tool-event-raw-btn:not(.hidden)");
        if (raw) { raw.click(); await settle(); }
        return { ok: Boolean(expanded) && (!raw || raw.getAttribute("aria-expanded") === "true"), reason: "single-tool",
          expanded: window.qingzhouConversationBenchmark.collectMetrics({ phase: "single-tool-expanded" }) };
      }
      return {
        ok: false,
        reason: "no-tool-timeline",`],
    ['await stabilizeVisualSnapshotPage(page);', `await stabilizeVisualSnapshotPage(page);
  const scrollBox = await page.locator("#messages").boundingBox();
  if (!scrollBox) throw new Error("Comparison requires a visible message scroller");
  await page.mouse.move(scrollBox.x + 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, -120);
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));`],
    ['page = await context.newPage();', `page = await context.newPage();
  await page.clock.setFixedTime(new Date(process.env.QZ_COMPARISON_TIME));
  const comparisonResources = new Map((fixture.comparisonResources || []).map(item => [item.url, item]));
  await page.route("**/*", route => {
    const asset = comparisonResources.get(route.request().url());
    if (asset) return route.fulfill({ status: 200, contentType: asset.contentType, body: Buffer.from(asset.bodyBase64, "base64") });
    if (route.request().url().startsWith(server.url + "/")) return route.continue();
    return route.abort("blockedbyclient");
  });`],
    ['const path = join(dir, `${position.name}.png`);', `await page.evaluate(async () => {
      await document.fonts.ready;
      const visibleImages = [...document.images].filter(image => {
        const rect = image.getBoundingClientRect();
        return rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight;
      });
      await Promise.all(visibleImages.map(image => image.decode().catch(error => console.error("Comparison image decode failed", image.currentSrc || image.src, error.message))));
    });
    const path = join(dir, \`\${position.name}.png\`);`],
    ['await page.screenshot({ path, fullPage: false });', `await page.waitForFunction(y => Math.abs(document.querySelector("#messages").scrollTop - y) <= 0.5, position.y, { timeout: 2000 });
    await page.evaluate(async y => {
      for (let frame = 0; frame < 6; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (Math.abs(document.querySelector("#messages").scrollTop - y) > 0.5) throw new Error("Comparison scroll position changed before screenshot");
      }
    }, position.y);
    const actualBefore = await page.locator("#messages").evaluate(el => el.scrollTop);
    await page.screenshot({ path, fullPage: false, animations: "disabled", caret: "hide" });
    const actualAfter = await page.locator("#messages").evaluate(el => el.scrollTop);
    if (Math.abs(actualBefore - position.y) > 0.5 || Math.abs(actualAfter - position.y) > 0.5) throw new Error("Comparison scroll position changed during screenshot");`],
    ['scrollTop: position.y,', 'scrollTop: actualAfter, requestedScrollTop: position.y, scrollTopBeforeScreenshot: actualBefore,'],
  ];
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error(`Comparison driver boundary changed: ${before}`);
    source = source.replace(before, after);
  }
  return source;
}

if (process.env.QZ_COMPARISON_DRIVER) {
  const target = resolve(process.env.QZ_COMPARISON_DRIVER);
  if (!Number.isFinite(Date.parse(process.env.QZ_COMPARISON_TIME))) throw new Error("Comparison requires a fixed wall-clock time");
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith("file:") && fileURLToPath(url) === target) {
      return { ...result, source: instrumentComparisonDriver(typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8")) };
    }
    return result;
  } });
}
