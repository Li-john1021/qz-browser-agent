import { expect, test } from "./fixtures.mjs";

async function mountLocalizedTemplates(page) {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    const { localizeDocument } = await import("/extension/sidepanel/i18n/dom.js");
    localizeDocument(document);
    for (const id of ["sessions-ui-template"]) {
      const template = document.querySelector(`#${id}`);
      if (template) document.body.append(template.content.cloneNode(true));
    }
  });
}

for (const locale of ["zh-CN", "en-US"]) {
  test.describe(locale, () => {
    test.use({ locale });

    test("automation controls and dynamic editor text follow browser language", async ({ page }) => {
      await mountLocalizedTemplates(page);
      const output = await page.evaluate(async () => {
        const { createAutomationsFeature } = await import("/extension/capabilities/sessions/automations/automations-feature.js");
        const controller = new AbortController();
        const feature = createAutomationsFeature({ root: document, signal: controller.signal, isActive: () => true,
          request: async () => ({ automations: [{ id: "automation-i18n", title: '保存 "<img src=x>"', instruction: "用户原文", enabled: true, schedule: { type: "interval", everyMinutes: 5 }, createdAt: "2026-09-19 08:00:00" }], runs: {} }),
          morphListHtml: (element, html) => { element.innerHTML = html; },
        });
        await feature.renderNow();
        const run = document.querySelector('[data-automation-action="run"]');
        const title = document.querySelector('.automation-title')?.textContent || document.querySelector('.automation-card').textContent;
        const images = document.querySelector('.automation-card').querySelectorAll('img').length;
        const action = run.getAttribute('aria-label');
        const tooltip = run.dataset.tooltip;
        feature.openEditor();
        const editor = document.querySelector('#automation-editor-title').textContent;
        controller.abort();
        feature.reset();
        return { title, action, tooltip, editor, images };
      });
      expect(output.title).toContain('保存 "<img src=x>"');
      expect(output.images).toBe(0);
      expect(output.action).toBe(locale === "en-US" ? "Run now" : "立即运行");
      expect(output.tooltip).toBe(output.action);
      expect(output.editor).toBe(locale === "en-US" ? "New automation" : "新建定时任务");
    });

    test("task progress localizes complete counts and preserves custom units", async ({ page }) => {
      await mountLocalizedTemplates(page);
      const counts = await page.evaluate(async () => {
        const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
        const { SESSIONS_KEY } = await import("/extension/shared/session/session-store.js");
        const { createSessionState, trackerModeTitle, trackerModeUnit } = await import("/extension/sidepanel/features/sessions/session-state.js");
        const { createSessionsFeature } = await import("/extension/capabilities/sessions/sessions-feature.js");
        const trackers = {
          pages: { mode: "pagination", current: 1, total: 5 },
          steps: { mode: "steps", completed: 1, total: 5 },
          custom: { mode: "generic", current: 1, total: 5, unit: "组 <b>" },
          unknownTotal: { mode: "pagination", current: 2, total: 0 },
          unitless: { mode: "generic", current: 1, total: 5 },
        };
        const records = Object.entries(trackers).map(([id, tracker]) => ({
          id, tracker, title: id, parentSessionId: "0", status: "running", updatedAt: "2026-09-19 12:00:00",
        }));
        globalThis.chrome = { storage: { local: createMemoryStorage({
          [SESSIONS_KEY]: Object.fromEntries(records.map(record => [record.id, record])),
        }) } };
        const state = createSessionState();
        const controller = new AbortController();
        const feature = createSessionsFeature({
          root: document, signal: controller.signal, isActive: () => true,
          request: async () => ({ sessions: records }), sessionState: state,
          getRuntime: id => state.getRuntime(id), trackerModeTitle, trackerModeUnit,
          artifactsFeature: { scheduleSummaryBackfill() {}, scheduleListHydration() {},
            openPanel() {}, getSummaryFromRecord: () => null, renderSessionChip: () => "" },
          sessionExportFeature: { exportSession() {}, isPreparing: () => false },
        });
        await feature.renderNow({ requestFreshState: true });
        const result = Object.fromEntries(Object.keys(trackers).map(id => [id,
          document.querySelector(`.session-card[data-id="${id}"] .session-tracker-count`).textContent,
        ]));
        result.injected = document.querySelectorAll(".session-tracker-count b").length;
        controller.abort();
        return result;
      });
      expect(counts).toEqual(locale === "en-US"
        ? { pages: "1/5 pages", steps: "1/5 steps", custom: "1/5 组 <b>", unknownTotal: "2 pages", unitless: "1/5", injected: 0 }
        : { pages: "第 1/5页", steps: "1/5步", custom: "1/5组 <b>", unknownTotal: "2页", unitless: "1/5", injected: 0 });
    });

    test("artifact totals use complete translated labels for one and several items", async ({ page }) => {
      await mountLocalizedTemplates(page);
      await page.evaluate(async () => {
        const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
        globalThis.chrome = { storage: { local: createMemoryStorage() } };
        const { createArtifactsFeature } = await import("/extension/capabilities/sessions/artifacts/artifacts-feature.js");
        const controller = new AbortController();
        const feature = createArtifactsFeature({
          root: document, signal: controller.signal,
          request: async (_type, { sessionId }) => ({ artifacts: { dataTables:
            Array.from({ length: Number(sessionId) }, (_, index) => ({ table: `用户表-${index}`, count: 1 })),
          } }),
          sessionState: { getRecord: () => null, mergeRecord() {} }, openTable() {},
        });
        window.__artifactCounts = { feature, controller };
        feature.openPanel("1");
      });
      await expect(page.locator(".artifacts-summary-title")).toHaveText(locale === "en-US" ? "Artifacts: 1" : "1 个产物");
      await page.evaluate(() => window.__artifactCounts.feature.openPanel("2"));
      await expect(page.locator(".artifacts-summary-title")).toHaveText(locale === "en-US" ? "Artifacts: 2" : "2 个产物");
      await page.evaluate(() => window.__artifactCounts.controller.abort());
    });

    test("translated column attributes escape quotes and preserve user-provided names", async ({ page }) => {
      await mountLocalizedTemplates(page);
      const output = await page.evaluate(async () => {
        const { createDataGridColumns } = await import("/extension/capabilities/data/workspace/data-grid-columns.js");
        const name = '保存 " data-injected="true <img src=x>';
        const menu = document.createElement("div");
        document.body.append(menu);
        const controller = new AbortController();
        const feature = createDataGridColumns({ root: document, signal: controller.signal, menu,
          state: { currentDataTable: "test", currentDataTableMeta: { name: "test" }, currentDataRows: [], currentDataColumns: [name], dataTablesCache: [] },
          getGridAdapter: () => ({ getSortProfileLabel: () => "Text" }),
        });
        feature.renderMenu();
        const row = menu.querySelector('.data-column-option');
        const actions = menu.querySelector('.data-column-option-actions');
        const result = { name, title: row.title, label: actions.getAttribute('aria-label'),
          value: row.querySelector('input').value, injected: Boolean(menu.querySelector('[data-injected], img')) };
        controller.abort();
        return result;
      });
      expect(output.title).toBe(output.name);
      expect(output.value).toBe(output.name);
      expect(output.label).toBe(locale === "en-US" ? `Actions for column ${output.name}` : `${output.name} 字段操作`);
      expect(output.injected).toBe(false);
    });

    test("static Data accessibility labels and placeholders are localized", async ({ page }) => {
      await mountLocalizedTemplates(page);
      const output = await page.evaluate(() => {
        const template = document.querySelector('#data-ui-template');
        const root = template?.content || document;
        return {
          placeholder: root.querySelector('#data-import-table').getAttribute('placeholder'),
          clearSelection: root.querySelector('#btn-clear-image-selection').getAttribute('aria-label'),
          deleteRows: root.querySelector('#btn-delete-data-rows').getAttribute('aria-label'),
        };
      });
      expect(output.placeholder).toBe(locale === "en-US" ? "Enter a table name" : "请输入表名");
      expect(output.clearSelection).toBe(locale === "en-US" ? "Clear image selection" : "取消图片选择");
      expect(output.deleteRows).toBe(locale === "en-US" ? "Delete selected rows" : "删除选中行");
    });
  });
}
