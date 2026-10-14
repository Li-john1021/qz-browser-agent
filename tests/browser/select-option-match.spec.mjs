import { expect, test, testAssetUrl } from "./fixtures.mjs";

const contentScripts = [
  "extension/content/article-extractor.js",
  "extension/content/content-script.js",
];

async function installContentScript(page, html) {
  await page.setContent(`<base href="https://example.test/form/">${html}`);
  await page.evaluate(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    const runtime = {
      getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
      onMessage: {
        addListener(nextListener) {
          listener = nextListener;
        },
      },
      sendMessage: async () => ({ ok: true }),
    };
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: runtime,
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") {
        reject(new Error("content-script listener is not installed"));
        return;
      }
      try {
        listener({ action, ...params }, {}, resolve);
      } catch (error) {
        reject(error);
      }
    });
  });
  for (const script of contentScripts) {
    await page.addScriptTag({ url: testAssetUrl(script) });
  }
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function callContent(page, action, params = {}) {
  return page.evaluate(
    ({ nextAction, nextParams }) => window.__callQingzhouContent(nextAction, nextParams),
    { nextAction: action, nextParams: params },
  );
}

const selectHtml = `
  <label for="city">城市</label>
  <select id="city">
    <option value="">请选择</option>
    <option value="sh">上海</option>
    <option value="bj">北京</option>
  </select>
`;

test("select matches option textContent when value differs", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callContent(page, "actOnElement", {
    selector: "#city",
    action: "select",
    value: "北京",
  });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("bj");
  expect(result.selectedText).toBe("北京");
  expect(await page.locator("#city").inputValue()).toBe("bj");
});

test("select still matches option.value exactly", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callContent(page, "actOnElement", {
    selector: "#city",
    action: "select",
    value: "sh",
  });
  expect(result.error).toBeUndefined();
  expect(result.selected).toBe("sh");
  expect(result.selectedText).toBe("上海");
});

test("select returns OPTION_NOT_FOUND when neither text nor value matches", async ({ page }) => {
  await installContentScript(page, selectHtml);
  const result = await callContent(page, "actOnElement", {
    selector: "#city",
    action: "select",
    value: "广州",
  });
  expect(result.code).toBe("OPTION_NOT_FOUND");
  expect(await page.locator("#city").inputValue()).toBe("");
});
