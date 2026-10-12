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
const updatedAt = "2026-09-20 12:34:56";
const session = { id: "automation-artifacts-session", title: "Daily report", status: "idle", createdAt: updatedAt, updatedAt };
const automation = {
  id: "automation-artifacts", title: "Daily report", instruction: "Collect photos and export a report.",
  enabled: true, schedule: { type: "daily", time: "09:00" }, nextRunAt: "2026-09-21 09:00:00",
  lastRunId: "automation-run", lastRunStatus: "completed", lastRunAt: updatedAt, createdAt: updatedAt, updatedAt,
};
const run = {
  id: "automation-run", automationId: automation.id, sessionId: session.id,
  status: "completed", triggerType: "scheduled", plannedAt: updatedAt,
  startedAt: "2026-09-20 12:33:00", endedAt: updatedAt, createdAt: updatedAt, updatedAt,
  lastMessage: "photos · data · report.txt",
};
const artifacts = {
  imageCollections: [{ type: "imageCollection", table: "photos", kindLabel: "图集", totalRows: 12345, updatedAt }],
  dataTables: [{ type: "dataTable", table: "data", kindLabel: "数据表", totalRows: 67890, updatedAt }],
  files: [{ filename: "report.txt", kindLabel: "文件", downloadId: 7, size: 12582912, updatedAt }],
};

// Exercise the actual workspace, transport hydration and capability-owned UI.
function installAutomationReplies({ automation, run, session, artifacts }) {
  const connect = chrome.runtime.connect;
  chrome.runtime.connect = (...args) => {
    const port = connect(...args), post = port.postMessage;
    port.postMessage = message => {
      let reply;
      if (message.type === "list_sessions") reply = { type: "list_sessions_result", sessions: [session] };
      if (message.type === "list_automations") reply = { type: "automations", automations: [automation], runs: { [automation.id]: [run] } };
      if (message.type === "get_session_artifacts") reply = { type: "session_artifacts", sessionId: session.id, artifacts };
      if (reply) {
        window.__qzPostedMessages.push(structuredClone(message));
        queueMicrotask(() => window.__qzEmitPortMessage({ ...reply, requestId: message.requestId }));
      } else post(message);
    };
    return port;
  };
}

for (const [language, chromeLocale] of languages) for (const colorScheme of ["light", "dark"]) {
  test.describe(`automation artifacts · ${language} · ${colorScheme}`, () => {
    test.use({ locale: language, colorScheme, viewport: { width: 390, height: 860 } });
    test("keeps translated artifact labels, counts and actions readable at narrow widths", async ({ page }, testInfo) => {
      const localeMessages = JSON.parse(await readFile(resolve(await ensureTestExtension(), `_locales/${chromeLocale}/messages.json`), "utf8"));
      const options = { uiLanguage: language, localeMessages, localStorage: { _sessions: { [session.id]: session } } };
      await page.addInitScript({ content: `(${installBenchmarkChromeStub.toString()})(${JSON.stringify(options)}); (${installAutomationReplies.toString()})(${JSON.stringify({ automation, run, session, artifacts })});` });
      await page.goto("/extension/sidepanel/sidepanel.html", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.qingzhouConversationBenchmark));
      await page.locator('[data-tab="sessions"]').click();
      await page.locator('[data-sessions-mode="automation"]').click();
      const card = page.locator(`[data-automation-id="${automation.id}"]`);
      await expect(card.locator(".automation-artifact-line")).toBeVisible();
      await card.locator(".automation-expand-btn").click();
      await expect(card.locator(".automation-artifact-row")).toHaveCount(3);
      const labels = await page.evaluate(async () => {
        const { t } = await import("/extension/capabilities/sessions/i18n.js");
        return { image: t("imageCollection"), data: t("dataTable"), file: t("file"), count: t("imageCount", { count: 12345 }), succeeded: t("succeeded") };
      });
      await expect(card.locator(".automation-run-signal")).toHaveAttribute("aria-label", labels.succeeded);
      const photos = card.locator(".automation-artifact-row").filter({ has: page.locator(".automation-artifact-name", { hasText: "photos" }) });
      await expect(photos.locator(".automation-artifact-kind")).toHaveText(labels.image);
      await expect(photos.locator(".automation-artifact-meta")).toContainText(labels.count);
      await expect(photos.locator(".automation-artifact-meta")).toContainText("09-20 12:34");
      await expect(card.locator(".automation-artifact-row").filter({ has: page.locator(".automation-artifact-name", { hasText: /^data$/ }) }).locator(".automation-artifact-kind")).toHaveText(labels.data);
      await expect(card.locator(".automation-artifact-row").filter({ hasText: "report.txt" }).locator(".automation-artifact-kind")).toHaveText(labels.file);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 860 });
        await captureArtifactLayout(page, ".automation-card", { language, colorScheme, width, scenario: "automation" }, testInfo);
      }
      expect(await page.evaluate(() => window.__qzPostedMessages.some(message => ["run_automation", "prompt"].includes(message.type)))).toBe(false);
    });
  });
}
