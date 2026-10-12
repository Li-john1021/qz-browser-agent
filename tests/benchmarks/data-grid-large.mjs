import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const ROWS = clampNumber(process.env.DATA_GRID_BENCH_ROWS, 1, 1_000_000, 50_000);
const COLS = clampNumber(process.env.DATA_GRID_BENCH_COLS, 1, 1_000, 100);
const STEP_TIMEOUT_MS = clampNumber(process.env.DATA_GRID_BENCH_STEP_TIMEOUT_MS, 5_000, 600_000, 180_000);
const RUNTIME_SYNC = process.env.DATA_GRID_BENCH_RUNTIME_SYNC !== "0";
const RANGE_SELECTION = process.env.DATA_GRID_BENCH_RANGE_SELECTION !== "0";
const viewport = {
  width: clampNumber(process.env.DATA_GRID_BENCH_WIDTH, 640, 3840, 1440),
  height: clampNumber(process.env.DATA_GRID_BENCH_HEIGHT, 480, 2160, 900),
};
const TABLE_HEIGHT = normalizeTableHeight(
  process.env.DATA_GRID_BENCH_TABLE_HEIGHT || `${viewport.height - 32}`,
);

const playwright = await loadPlaywright();
const chromeExecutable = findChromeExecutable(playwright.chromium.executablePath());
if (!chromeExecutable) {
  throw new Error("Data Grid benchmark requires Chromium; run npx playwright install chromium or set CHROME_EXECUTABLE.");
}

const browser = await playwright.chromium.launch({
  headless: process.env.DATA_GRID_BENCH_HEADLESS !== "0",
  executablePath: chromeExecutable,
  args: [
    "--enable-precise-memory-info",
    "--js-flags=--expose-gc",
  ],
});

let page;
let cdp;
try {
  const context = await browser.newContext({ locale: "zh-CN", viewport });
  page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  page.on("console", msg => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  const tabulatorCss = readFileSync(join(root, "node_modules/tabulator-tables/dist/css/tabulator.min.css"), "utf8");
  const tabulatorJs = readFileSync(join(root, "node_modules/tabulator-tables/dist/js/tabulator.min.js"), "utf8");
  await page.setContent(`<!doctype html>
    <meta charset="utf-8">
    <title>Qingzhou Data Grid Benchmark</title>
    <style>${tabulatorCss}</style>
    <style>
      :root {
        --green: #24845d;
        --text-primary: #171717;
        --text-secondary: #8b929c;
        --border-subtle: rgba(0, 0, 0, .065);
      }
      body {
        margin: 0;
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8f8f7;
        color: var(--text-primary);
      }
      #grid {
        width: calc(100vw - 32px);
        height: calc(100vh - 32px);
        margin: 16px;
        border: 1px solid var(--border-subtle);
        border-radius: 5px;
        overflow: hidden;
        background: #fff;
      }
      .tabulator {
        border: 0;
        background: #fff;
        color: var(--text-primary);
        font-size: 12px;
        line-height: 1.45;
      }
      .tabulator .tabulator-header {
        border-bottom-color: rgba(0,0,0,.07);
        background: #fafaf9;
        color: #5f6368;
      }
      .tabulator .tabulator-header .tabulator-col {
        min-height: 32px;
        border-right-color: rgba(0,0,0,.018);
        background: #fafaf9;
        color: #5f6368;
      }
      .tabulator .tabulator-header .tabulator-col .tabulator-col-content {
        padding: 7px 8px;
      }
      .tabulator .tabulator-header .tabulator-col.tabulator-sortable .tabulator-col-title {
        padding-right: 0;
      }
      .tabulator .tabulator-header .tabulator-col .tabulator-col-sorter {
        width: 0 !important;
        display: none !important;
        visibility: hidden !important;
      }
      .tabulator .tabulator-tableholder,
      .tabulator .tabulator-tableholder .tabulator-table {
        background: #fff;
        color: var(--text-primary);
      }
      .tabulator-row,
      .tabulator-row.tabulator-row-even {
        min-height: 30px;
        background: #fff;
        border-color: rgba(0,0,0,.04);
        color: var(--text-primary);
      }
      .tabulator-cell {
        min-height: 30px;
        border-color: rgba(0,0,0,.018);
        padding: 6px 8px;
      }
      .tabulator-cell.tabulator-editing {
        border: 0 !important;
        border-right: 1px solid rgba(0,0,0,.018) !important;
        background: rgba(36,132,93,.04);
        box-shadow: inset 0 0 0 1px rgba(36,132,93,.18);
        padding: 6px 8px !important;
      }
      .tabulator-cell.tabulator-editing input,
      .tabulator-cell.tabulator-editing select,
      .tabulator-cell.tabulator-editing textarea {
        width: 100%;
        min-height: 17px;
        margin: 0;
        border: 0 !important;
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        line-height: inherit;
        outline: none;
        padding: 0;
        vertical-align: top;
      }
      .tabulator .tabulator-cell.tabulator-row-header,
      .tabulator .tabulator-header .tabulator-col.tabulator-row-header {
        background: #fafaf9;
        border-right-color: rgba(0,0,0,.018);
      }
      .tabulator .tabulator-cell.tabulator-row-header {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 !important;
        border-bottom: 0 !important;
        box-shadow: none !important;
      }
      .data-grid-column-title {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
        max-width: 100%;
      }
      .data-grid-column-title-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .data-grid-column-sort-indicator {
        width: 8px;
        height: 14px;
        flex: 0 0 8px;
        display: none;
        align-items: center;
        justify-content: center;
        color: #a0a6ad;
        font-size: 10px;
        font-weight: 650;
        line-height: 1;
        opacity: 0;
      }
      .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .data-grid-column-sort-indicator,
      .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .data-grid-column-sort-indicator {
        display: inline-flex;
        color: #8b929c;
        opacity: 1;
      }
      .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .data-grid-column-sort-indicator::before { content: "↑"; }
      .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .data-grid-column-sort-indicator::before { content: "↓"; }
      .data-grid-column-filter-btn {
        width: 14px;
        height: 14px;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: #a0a6ad;
        opacity: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .data-grid-filter-mark {
        width: 9px;
        height: 8px;
        display: block;
        background:
          linear-gradient(currentColor,currentColor) 1px 1px/7px 1px no-repeat,
          linear-gradient(currentColor,currentColor) 2px 4px/5px 1px no-repeat,
          linear-gradient(currentColor,currentColor) 3px 7px/3px 1px no-repeat;
      }
      .data-grid-row-check,
      .data-grid-row-check-all {
        width: 12px;
        height: 12px;
        margin: 0;
        appearance: none;
        -webkit-appearance: none;
        display: inline-grid;
        place-items: center;
        border: 1px solid rgba(0,0,0,.18);
        border-radius: 3px;
        background: #fff;
        box-shadow: none;
        line-height: 0;
        outline: none;
      }
      .data-grid-row-check:checked,
      .data-grid-row-check-all:checked,
      .data-grid-row-check-all:indeterminate {
        border-color: var(--green);
        background: var(--green);
      }
      .tabulator-row .tabulator-cell.tabulator-range-selected:not(.tabulator-range-only-cell-selected):not(.tabulator-range-row-header),
      .tabulator-row.tabulator-range-highlight .tabulator-cell.tabulator-range-row-header {
        background: rgba(36,132,93,.06) !important;
      }
      .tabulator .tabulator-tableholder .tabulator-range-overlay {
        overflow: visible;
        z-index: 18;
      }
      .tabulator-range,
      .tabulator-range-cell-active {
        border: 0 !important;
        box-sizing: border-box;
      }
      .tabulator .tabulator-tableholder .tabulator-range-overlay .tabulator-range {
        border: 0 !important;
        box-shadow: inset 0 0 0 1px var(--green);
      }
      .tabulator .tabulator-tableholder .tabulator-range-overlay .tabulator-range-cell-active {
        border: 0 !important;
        box-shadow: inset 0 0 0 2px var(--green);
      }
    </style>
    <div id="grid"></div>
    <script>${tabulatorJs}</script>`);

  await page.evaluate(({ rows, cols, tableHeight, runtimeSync, rangeSelection }) => {
    const columnNames = Array.from({ length: cols }, (_, index) => `c${String(index).padStart(2, "0")}`);
    const state = {
      rows,
      cols,
      columnNames,
      sourceRows: null,
      tableRows: null,
      table: null,
      selectedRowIds: new Set(),
      runtimeCalls: 0,
      runtimeTotalMs: 0,
      runtimeMaxMs: 0,
      lastRuntime: null,
    };

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
      }[ch]));
    }

    function dataGridColumnTitleFormatter(header) {
      const column = header?.getColumn?.();
      const field = column?.getField?.() || "";
      const label = header?.getValue?.() || field;
      return `
        <span class="data-grid-column-title" title="${escapeHtml(label)}">
          <span class="data-grid-column-title-text">${escapeHtml(label)}</span>
          <span class="data-grid-column-sort-indicator" aria-hidden="true"></span>
          <button class="data-grid-column-filter-btn" type="button" data-filter-field="${escapeHtml(field)}" aria-label="${escapeHtml(label)}筛选">
            <span class="data-grid-filter-mark" aria-hidden="true"></span>
          </button>
        </span>
      `;
    }

    function dataGridRowHeaderFormatter(cell) {
      const rowId = cell?.getRow?.()?.getData?.()?._rowId || "";
      return `<input class="data-grid-row-check" type="checkbox" data-row-id="${escapeHtml(rowId)}" aria-label="选择行">`;
    }

    function dataGridRowHeaderTitleFormatter() {
      return `<input class="data-grid-row-check-all" type="checkbox" aria-label="选择全部可见行">`;
    }

    function formatDataGridCellValue(value) {
      if (value == null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }

    function dataGridCellFormatter(cell) {
      const text = formatDataGridCellValue(cell.getValue());
      return text ? escapeHtml(text) : `<span class="data-grid-cell-empty"></span>`;
    }

    function getColumnType(column) {
      const sample = state.sourceRows?.[0]?.data?.[column];
      if (typeof sample === "number") return "number";
      if (typeof sample === "boolean") return "boolean";
      if (/^\d{4}-\d{2}-\d{2}/.test(String(sample ?? ""))) return "date";
      return "text";
    }

    function dataGridSorterForType(type) {
      if (type === "number") return "number";
      if (type === "boolean") return "boolean";
      if (type === "date") return "date";
      return "string";
    }

    function buildDataGridColumn(column) {
      const type = getColumnType(column);
      return {
        title: column,
        field: column,
        minWidth: 88,
        headerMenu: [],
        titleFormatter: dataGridColumnTitleFormatter,
        editor: type === "number" ? "number" : "input",
        formatter: dataGridCellFormatter,
        sorter: dataGridSorterForType(type),
      };
    }

    function dataGridRowFromRecord(record) {
      const row = {
        _rowId: record.id || "",
        createdAt: record.createdAt || "",
        updatedAt: record.updatedAt || "",
      };
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
      for (const column of state.columnNames) row[column] = data[column];
      for (const [key, value] of Object.entries(data)) {
        if (!(key in row)) row[key] = value;
      }
      return row;
    }

    function getActiveRowIds() {
      if (!state.table) return [];
      const rows = state.table.getRows?.("active") || state.table.getRows?.() || [];
      return rows.map(row => row?.getData?.()?._rowId).filter(Boolean);
    }

    function syncRuntimeState() {
      if (!state.table) return { active: 0, visible: 0, selected: 0, inputs: 0 };
      const activeIds = new Set(getActiveRowIds());
      for (const id of state.selectedRowIds) {
        if (!activeIds.has(id)) state.selectedRowIds.delete(id);
      }
      const rows = state.table.getRows?.("visible") || state.table.getRows?.() || [];
      rows.forEach(row => {
        const rowId = row?.getData?.()?._rowId || "";
        row?.getElement?.()?.classList.toggle("data-grid-row-checked", state.selectedRowIds.has(rowId));
      });
      const inputs = document.querySelectorAll(".data-grid-row-check");
      inputs.forEach(input => {
        const rowId = input.dataset.rowId || "";
        input.checked = state.selectedRowIds.has(rowId);
      });
      const allInput = document.querySelector(".data-grid-row-check-all");
      if (allInput) {
        const ids = [...activeIds];
        const selectedCount = ids.filter(id => state.selectedRowIds.has(id)).length;
        allInput.checked = ids.length > 0 && selectedCount === ids.length;
        allInput.indeterminate = selectedCount > 0 && selectedCount < ids.length;
      }
      return { active: activeIds.size, visible: rows.length, selected: state.selectedRowIds.size, inputs: inputs.length };
    }

    function updateRuntimeState() {
      const start = performance.now();
      const result = syncRuntimeState();
      const duration = performance.now() - start;
      state.runtimeCalls += 1;
      state.runtimeTotalMs += duration;
      state.runtimeMaxMs = Math.max(state.runtimeMaxMs, duration);
      state.lastRuntime = { ...result, durationMs: duration };
    }

    function waitFrames(count = 2) {
      return new Promise(resolve => {
        const step = () => {
          count -= 1;
          if (count <= 0) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }

    function waitForRows() {
      if (document.querySelector("#grid .tabulator-row")) return waitFrames(2);
      return new Promise(resolve => {
        const observer = new MutationObserver(() => {
          if (document.querySelector("#grid .tabulator-row")) {
            observer.disconnect();
            waitFrames(2).then(resolve);
          }
        });
        observer.observe(document.getElementById("grid"), { childList: true, subtree: true });
      });
    }

    window.qingzhouDataGridBench = {
      buildColumns() {
        state.columns = state.columnNames.map(name => ({ name }));
        return { columns: state.columnNames.length };
      },
      buildSourceRows() {
        const sourceRows = new Array(state.rows);
        const dateBase = Date.UTC(2026, 0, 1);
        for (let rowIndex = 0; rowIndex < state.rows; rowIndex += 1) {
          const data = {};
          for (let colIndex = 0; colIndex < state.cols; colIndex += 1) {
            const field = state.columnNames[colIndex];
            const kind = colIndex % 4;
            if (kind === 0) data[field] = rowIndex * 10 + colIndex;
            else if (kind === 1) data[field] = `row-${rowIndex}-field-${colIndex}`;
            else if (kind === 2) data[field] = new Date(dateBase + rowIndex * 86400000).toISOString().slice(0, 10);
            else data[field] = rowIndex % 2 === 0;
          }
          sourceRows[rowIndex] = {
            id: `row_${String(rowIndex).padStart(6, "0")}`,
            createdAt: "2026-07-08 00:00:00",
            updatedAt: "2026-07-08 00:00:00",
            data,
          };
        }
        state.sourceRows = sourceRows;
        return { rows: sourceRows.length, cells: state.rows * state.cols };
      },
      flattenRows() {
        state.tableRows = state.sourceRows.map(dataGridRowFromRecord);
        return { rows: state.tableRows.length, columns: state.columnNames.length };
      },
      createTable() {
        const tableOptions = {
          data: state.tableRows,
          columns: state.columnNames.map(buildDataGridColumn),
          index: "_rowId",
          height: tableHeight,
          layout: "fitDataFill",
          movableColumns: true,
          nestedFieldSeparator: false,
          placeholder: "空表",
          selectableRange: rangeSelection,
          selectableRangeRows: rangeSelection,
          selectableRangeColumns: rangeSelection,
          selectableRangeInitializeDefault: false,
          selectableRangeClearCells: false,
          clipboard: true,
          clipboardCopyRowRange: "range",
          clipboardCopyStyled: false,
          clipboardPasteAction: false,
          history: true,
          rowHeader: {
            formatter: dataGridRowHeaderFormatter,
            titleFormatter: dataGridRowHeaderTitleFormatter,
            headerSort: false,
            hozAlign: "center",
            width: 36,
          },
          columnDefaults: {
            headerSort: true,
            resizable: true,
            tooltip: true,
          },
        };
        const table = new Tabulator(document.getElementById("grid"), tableOptions);
        state.table = table;
        if (runtimeSync) {
          table.on("renderComplete", updateRuntimeState);
          table.on("dataFiltered", updateRuntimeState);
          table.on("rangeAdded", updateRuntimeState);
          table.on("rangeChanged", updateRuntimeState);
          table.on("rangeRemoved", updateRuntimeState);
        }
        return { tableCreated: true };
      },
      async waitFirstRender() {
        await waitForRows();
        return this.snapshot();
      },
      runtimeSync() {
        const start = performance.now();
        const result = syncRuntimeState();
        return { ...result, durationMs: performance.now() - start };
      },
      async scrollVertical() {
        const holder = document.querySelector("#grid .tabulator-tableholder");
        const positions = [0, .1, .25, .5, .75, .9, 1];
        const max = Math.max(0, holder.scrollHeight - holder.clientHeight);
        const start = performance.now();
        for (const ratio of positions) {
          holder.scrollTop = max * ratio;
          holder.dispatchEvent(new Event("scroll", { bubbles: true }));
          await waitFrames(2);
        }
        return { durationMs: performance.now() - start, maxScrollTop: Math.round(max), ...this.snapshot() };
      },
      async scrollHorizontal() {
        const holder = document.querySelector("#grid .tabulator-tableholder");
        const positions = [0, .25, .5, .75, 1];
        const max = Math.max(0, holder.scrollWidth - holder.clientWidth);
        const start = performance.now();
        for (const ratio of positions) {
          holder.scrollLeft = max * ratio;
          holder.dispatchEvent(new Event("scroll", { bubbles: true }));
          await waitFrames(2);
        }
        return { durationMs: performance.now() - start, maxScrollLeft: Math.round(max), ...this.snapshot() };
      },
      async applyNumberFilter() {
        const start = performance.now();
        state.table.setFilter(data => Number(data.c00) >= Math.floor(state.rows * 10 * .8));
        await waitFrames(2);
        return { durationMs: performance.now() - start, activeRows: state.table.getRows("active").length, ...this.snapshot() };
      },
      async clearFilter() {
        const start = performance.now();
        state.table.clearFilter(true);
        await waitFrames(2);
        return { durationMs: performance.now() - start, activeRows: state.table.getRows("active").length, ...this.snapshot() };
      },
      async sortNumberColumn() {
        const start = performance.now();
        state.table.setSort("c00", "desc");
        await waitFrames(2);
        const first = state.table.getRows("active")[0]?.getData?.()?.c00 ?? null;
        return { durationMs: performance.now() - start, first, ...this.snapshot() };
      },
      async updateOneCell() {
        const row = state.table.getRow("row_000100");
        const start = performance.now();
        await row.update({ c01: "edited-value" });
        await waitFrames(2);
        return { durationMs: performance.now() - start, value: row.getData().c01, ...this.snapshot() };
      },
      destroy() {
        state.table?.destroy?.();
        state.table = null;
        return { destroyed: true };
      },
      snapshot() {
        const rows = document.querySelectorAll("#grid .tabulator-row").length;
        const cells = document.querySelectorAll("#grid .tabulator-cell").length;
        const holder = document.querySelector("#grid .tabulator-tableholder");
        return {
          domRows: rows,
          domCells: cells,
          scrollTop: Math.round(holder?.scrollTop || 0),
          scrollLeft: Math.round(holder?.scrollLeft || 0),
          runtimeCalls: state.runtimeCalls,
          runtimeTotalMs: round(state.runtimeTotalMs),
          runtimeMaxMs: round(state.runtimeMaxMs),
          lastRuntime: state.lastRuntime ? { ...state.lastRuntime, durationMs: round(state.lastRuntime.durationMs) } : null,
        };
      },
    };

    function round(value) {
      return Math.round(value * 10) / 10;
    }
  }, { rows: ROWS, cols: COLS, tableHeight: TABLE_HEIGHT, runtimeSync: RUNTIME_SYNC, rangeSelection: RANGE_SELECTION });

  log("start", {
    rows: ROWS,
    columns: COLS,
    cells: ROWS * COLS,
    viewport,
    stepTimeoutMs: STEP_TIMEOUT_MS,
    tableHeight: TABLE_HEIGHT,
    runtimeSync: RUNTIME_SYNC,
    rangeSelection: RANGE_SELECTION,
    chromeExecutable,
    headless: process.env.DATA_GRID_BENCH_HEADLESS !== "0",
    heap: await readHeap(),
  });

  await runStep("columns-built", () => page.evaluate(() => qingzhouDataGridBench.buildColumns()));
  await runStep("source-rows-built", () => page.evaluate(() => qingzhouDataGridBench.buildSourceRows()));
  await runStep("table-rows-flattened", () => page.evaluate(() => qingzhouDataGridBench.flattenRows()));
  await runStep("tabulator-created", () => page.evaluate(() => qingzhouDataGridBench.createTable()));
  await runStep("first-render", async () => {
    const snapshot = await page.evaluate(() => qingzhouDataGridBench.waitFirstRender());
    assertVirtualized(snapshot);
    return { ...snapshot, virtualized: ROWS <= 200 || snapshot.domRows < ROWS };
  });
  await runStep("runtime-sync-manual", () => page.evaluate(() => qingzhouDataGridBench.runtimeSync()));
  await runStep("scroll-vertical", () => page.evaluate(() => qingzhouDataGridBench.scrollVertical()));
  await runStep("scroll-horizontal", () => page.evaluate(() => qingzhouDataGridBench.scrollHorizontal()));
  await runStep("filter-number", () => page.evaluate(() => qingzhouDataGridBench.applyNumberFilter()));
  await runStep("filter-clear", () => page.evaluate(() => qingzhouDataGridBench.clearFilter()));
  await runStep("sort-number-desc", () => page.evaluate(() => qingzhouDataGridBench.sortNumberColumn()));
  await runStep("update-one-cell", () => page.evaluate(() => qingzhouDataGridBench.updateOneCell()));
  await runStep("destroy", () => page.evaluate(() => qingzhouDataGridBench.destroy()));

  log("done", { ok: true, pageErrors: errors, heap: await readHeap() });
} finally {
  await browser.close().catch(() => {});
}

async function runStep(stage, action) {
  const start = performance.now();
  try {
    const result = await withTimeout(action(), STEP_TIMEOUT_MS, stage);
    log(stage, {
      ok: true,
      elapsedMs: round(performance.now() - start),
      ...normalizeNumbers(result),
      heap: await readHeap(),
    });
  } catch (err) {
    log(stage, {
      ok: false,
      elapsedMs: round(performance.now() - start),
      error: String(err?.stack || err),
    });
    throw err;
  }
}

function assertVirtualized(snapshot = {}) {
  if (ROWS <= 200) return;
  assert.ok(
    Number(snapshot.domRows) <= 200,
    `Data grid virtual DOM is inactive: rendered ${snapshot.domRows} of ${ROWS} rows`,
  );
  assert.ok(
    Number(snapshot.domCells) < ROWS * (COLS + 1),
    `Data grid virtual DOM is inactive: rendered all ${snapshot.domCells} cells`,
  );
}

async function readHeap() {
  const heap = {
    jsHeapUsedMB: null,
    jsHeapTotalMB: null,
    performanceUsedMB: null,
    performanceTotalMB: null,
  };
  try {
    const metrics = await cdp.send("Performance.getMetrics");
    const byName = new Map(metrics.metrics.map(metric => [metric.name, metric.value]));
    heap.jsHeapUsedMB = roundBytes(byName.get("JSHeapUsedSize"));
    heap.jsHeapTotalMB = roundBytes(byName.get("JSHeapTotalSize"));
  } catch (_err) {}
  try {
    const memory = await page.evaluate(() => {
      const item = performance.memory;
      return item
        ? { used: item.usedJSHeapSize, total: item.totalJSHeapSize, limit: item.jsHeapSizeLimit }
        : null;
    });
    if (memory) {
      heap.performanceUsedMB = roundBytes(memory.used);
      heap.performanceTotalMB = roundBytes(memory.total);
      heap.performanceLimitMB = roundBytes(memory.limit);
    }
  } catch (_err) {}
  return heap;
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function log(stage, details = {}) {
  console.log(JSON.stringify({ stage, ...normalizeNumbers(details) }));
}

function normalizeNumbers(value) {
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    typeof item === "number" ? round(item) : normalizeNumbers(item),
  ]));
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 10) / 10;
}

function roundBytes(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value / 1024 / 1024 * 10) / 10;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeTableHeight(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "false" || text === "0") return false;
  const numberValue = Number(text);
  if (Number.isFinite(numberValue)) return `${Math.max(1, Math.round(numberValue))}px`;
  return text;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    const explicitPath = process.env.PLAYWRIGHT_PATH || "";
    if (explicitPath) return import(pathToFileURL(explicitPath).href);
    throw new Error("Data Grid benchmark requires Playwright; run npm ci or set PLAYWRIGHT_PATH.", { cause: error });
  }
}

function findChromeExecutable(bundled = "") {
  const candidates = [
    process.env.CHROME_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    bundled,
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) || "";
}
