import { expect, test } from "./fixtures.mjs";

test("switching image tables revokes late asset URLs and keeps the replacement load", async ({ page }) => {
  await page.route("**/shared/asset-store.js", route => route.fulfill({
    contentType: "text/javascript",
    body: `export * from './asset-store.js?actual';
      export const getImageAssetObjectUrl = id => new Promise(resolve => window.pendingAssets.push({ id, resolve }));`,
  }));
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    document.body.innerHTML = '<div id="preview"></div>';
    window.pendingAssets = [];
    window.revokedUrls = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke(url); };
    const image = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: "image/svg+xml" });
    window.oldUrl = URL.createObjectURL(image);
    window.newUrl = URL.createObjectURL(image);
    const { createDataImageCollection } = await import("/extension/capabilities/data/workspace/data-image-collection.js");
    window.collection = createDataImageCollection({ preview: document.querySelector("#preview") });
    window.imageRows = [{ id: "row", table: "images", data: { assetId: "same-image" }, createdAt: "", updatedAt: "" }];
    window.collection.renderInto(window.imageRows);
  });
  await expect.poll(() => page.evaluate(() => window.pendingAssets.length)).toBe(1);
  await page.evaluate(() => {
    window.collection.resetForTable();
    window.collection.renderInto(window.imageRows);
  });
  await expect.poll(() => page.evaluate(() => window.pendingAssets.length)).toBe(2);
  await page.evaluate(() => window.pendingAssets[0].resolve({ objectUrl: window.oldUrl }));
  await expect.poll(() => page.evaluate(() => window.revokedUrls)).toEqual([await page.evaluate(() => window.oldUrl)]);
  await expect(page.locator("#preview img")).toHaveCount(0);
  await page.evaluate(() => window.pendingAssets[1].resolve({ objectUrl: window.newUrl }));
  await expect(page.locator("#preview img")).toHaveAttribute("src", await page.evaluate(() => window.newUrl));
  await expect.poll(() => page.locator("#preview img").evaluate(image => image.complete ? image.naturalWidth : 0)).toBeGreaterThan(0);
  await page.locator("#preview img").evaluate(image => image.decode());
  await page.evaluate(() => { window.collection.clearObjectUrls(); window.collection.clearObjectUrls(); });
  expect(await page.evaluate(() => window.revokedUrls)).toEqual(await page.evaluate(() => [window.oldUrl, window.newUrl]));
});
