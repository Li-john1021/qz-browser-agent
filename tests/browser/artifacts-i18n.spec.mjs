import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";
import { captureArtifactLayout } from "./artifact-layout-audit.mjs";

const languages = [
  ["en", "en"], ["zh-CN", "zh_CN"], ["zh-TW", "zh_TW"], ["ja", "ja"],
  ["ko", "ko"], ["es", "es"], ["fr", "fr"], ["de", "de"],
  ["pt-BR", "pt_BR"], ["ru", "ru"], ["ar", "ar"], ["hi", "hi"],
];
const sessionId = "artifact-language";
// Simulate persisted records from an older Chinese installation, including labels
// that disagree with the stable kind. Source names and descriptions stay verbatim.
const runtimeArtifacts = {
  imageCollections: [{ table: "照片", kindLabel: "数据表", totalRows: 2 }],
  dataTables: [{ table: "数据", type: "dataTable", kindLabel: "图集", totalRows: 3, meta: "用户说明 / Original / نص" }],
  files: [{ filename: "报告.txt", kindLabel: "文件", downloadId: 7 }],
};

function installArtifactReplies(artifacts) {
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args), post = port.postMessage;
    port.postMessage = message => {
      if (message.type === "get_session_artifacts") {
        // The second scenario must use its tool transcript projection, not a richer
        // runtime response that could conceal a stale generated count description.
        const response = message.sessionId === "legacy-media" ? {} : artifacts;
        queueMicrotask(() => window.__qzEmitPortMessage({ type: "session_artifacts", sessionId: message.sessionId, requestId: message.requestId, artifacts: response }));
      } else post(message);
    };
    return port;
  };
}

for (const width of [320, 390]) for (const [language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`artifact labels · ${language} · ${colorScheme} · ${width}px`, () => {
    test.use({ locale: language, colorScheme, viewport: { width, height: 760 } });
    test("localizes legacy artifact cards and hydrated panels while preserving source text", async ({ page }, testInfo) => {
      const capture = (selector, scenario) => captureArtifactLayout(page, selector, { language, colorScheme, width, scenario }, testInfo);
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify({ uiLanguage: language, localeMessages })}); (${installArtifactReplies.toString()})(${JSON.stringify(runtimeArtifacts)});` });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      const labels = await page.evaluate(async ({ sessionId }) => {
        const { t } = await import("/extension/capabilities/sessions/i18n.js");
        await window.qingzhouConversationBenchmark.runSnapshotRender({
          sessionId,
          title: "原始任务",
          transcript: [{ type: "artifacts", summary: {
            sessionId, signature: "legacy-labels", total: 3,
            data: [
              { id: "photos", table: "照片", title: "照片", type: "data", kind: "image_collection", kindLabel: "数据表", count: 2 },
              { id: "rows", table: "数据", title: "数据", type: "data", kind: "data_table", kindLabel: "图集", count: 3, meta: "用户说明 / Original / نص" },
            ],
            files: [{ id: "file", title: "报告.txt", type: "file", kindLabel: "文件", downloadId: "7" }],
          } }],
        });
        return { image: t("imageCollection"), data: t("dataTable"), file: t("file"), count: t("imageCount", { count: 2 }) };
      }, { sessionId });
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      const imageCard = page.locator(".artifact-strip-item").filter({ has: page.locator('.artifact-strip-name > span', { hasText: "照片" }) });
      const dataCard = page.locator(".artifact-strip-item").filter({ has: page.locator('.artifact-strip-name > span', { hasText: "数据" }) });
      const fileCard = page.locator(".artifact-strip-item").filter({ has: page.locator('.artifact-strip-name > span', { hasText: "报告.txt" }) });
      await expect(imageCard.locator(".artifact-strip-kind")).toHaveText(labels.image);
      await expect(imageCard.locator("small")).toContainText(labels.count);
      await expect(dataCard.locator(".artifact-strip-kind")).toHaveText(labels.data);
      await expect(dataCard.locator("small")).toContainText("用户说明 / Original / نص");
      await expect(fileCard.locator(".artifact-strip-kind")).toHaveText(labels.file);
      await capture(".msg-artifacts", "cards");
      await page.locator(".artifact-strip-open").click();
      await expect(page.locator("#artifacts-panel")).toBeVisible();
      const panelImage = page.locator(".artifacts-row").filter({ hasText: "照片" });
      const panelData = page.locator(".artifacts-row").filter({ hasText: "数据" });
      const panelFile = page.locator(".artifacts-row").filter({ hasText: "报告.txt" });
      await expect(panelImage.locator(".artifacts-row-kind")).toHaveText(labels.image);
      await expect(panelData.locator(".artifacts-row-kind")).toHaveText(labels.data);
      await expect(panelFile.locator(".artifacts-row-kind")).toHaveText(labels.file);
      await expect(panelData).toContainText("用户说明 / Original / نص");
      await capture(".artifacts-card", "panel");
      await page.locator("#btn-close-artifacts").click();

      await page.evaluate(async () => {
        const legacyArtifact = { type: "data", kindLabel: "图集", table: "旧照片", title: "旧照片", rowCount: 2, meta: "2 张图片", score: 3 };
        await window.qingzhouConversationBenchmark.runSnapshotRender({
          sessionId: "legacy-media",
          title: "原始任务",
          transcript: [
            { type: "tool", name: "collect_images", args: { table: "旧照片" }, result: { table: "旧照片", kind: "image_collection", totalRows: 2, artifacts: [legacyArtifact] } },
            { type: "tool", name: "third_party_collection", args: {}, result: { artifacts: [{ ...legacyArtifact, table: "第三方", title: "第三方" }] } },
          ],
        });
      });
      const legacyMediaCard = page.locator(".artifact-strip-item").filter({ has: page.locator('.artifact-strip-name > span', { hasText: "旧照片" }) });
      const thirdPartyCard = page.locator(".artifact-strip-item").filter({ has: page.locator('.artifact-strip-name > span', { hasText: "第三方" }) });
      await expect(legacyMediaCard.locator(".artifact-strip-kind")).toHaveText(labels.image);
      await expect(legacyMediaCard.locator("small")).toContainText(labels.count);
      await expect(thirdPartyCard.locator("small")).toContainText("2 张图片");
      await capture(".msg-artifacts", "legacy");
    });
  });
}
