import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const playwright = await loadPlaywright();
const chromeExecutable = findChromeExecutable(playwright.chromium.executablePath());
if (!chromeExecutable) {
  throw new Error("Data Grid browser smoke requires Chromium; run npx playwright install chromium or set CHROME_EXECUTABLE.");
}

const videoDir = process.env.DATA_GRID_SMOKE_VIDEO_DIR
  ? resolve(process.env.DATA_GRID_SMOKE_VIDEO_DIR)
  : "";
const recordingDemo = Boolean(videoDir);
const viewport = {
  width: clampViewport(process.env.DATA_GRID_SMOKE_WIDTH, 360, 2400, 960),
  height: clampViewport(process.env.DATA_GRID_SMOKE_HEIGHT, 360, 1800, 540),
};
if (videoDir) {
  rmSync(videoDir, { recursive: true, force: true });
  mkdirSync(videoDir, { recursive: true });
}

const browser = await playwright.chromium.launch({
  headless: process.env.DATA_GRID_SMOKE_HEADLESS !== "0",
  executablePath: chromeExecutable,
});
const context = await browser.newContext({
  locale: "zh-CN",
  viewport,
  ...(videoDir ? { recordVideo: { dir: videoDir, size: viewport } } : {}),
});
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", err => errors.push(err.message));

const tabulatorCss = readFileSync(join(root, "node_modules/tabulator-tables/dist/css/tabulator.min.css"), "utf8");
const tabulatorJs = readFileSync(join(root, "node_modules/tabulator-tables/dist/js/tabulator.min.js"), "utf8");
await page.setContent(`<!doctype html>
  <meta charset="utf-8">
  <title>Data Grid Smoke</title>
  <style>${tabulatorCss}</style>
  <style>
	    body { margin: 0; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8f8f7; color: #171717; }
	    .shell { padding: 22px; }
	    .toolbar { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; color: #8b8f94; }
	    .toolbar strong { color: #171717; font-weight: 650; }
	    .toolbar .spacer { flex: 1; }
	    .toolbar button { height: 28px; border: 1px solid rgba(0,0,0,.08); border-radius: 5px; background: rgba(255,255,255,.72); color: #5f6368; padding: 0 9px; font: inherit; box-shadow: inset 0 1px 0 rgba(255,255,255,.68); }
	    .toolbar button:not(:disabled):hover { background: #fff; color: #171717; }
	    .toolbar button:disabled { opacity: .42; }
	    .toolbar button.hidden { display: none; }
	    #status { min-width: 78px; color: #8b8f94; font-size: 12px; text-align: right; }
	    .dot { width: 7px; height: 7px; border-radius: 50%; background: #24845d; }
	    #grid { height: 360px; border: 1px solid rgba(0,0,0,.065); border-radius: 5px; overflow: hidden; background: #fff; box-shadow: inset 0 1px 0 rgba(255,255,255,.82); }
	    .tabulator { border: 0; background: #fff; color: #171717; font-size: 12px; line-height: 1.45; }
	    .tabulator .tabulator-header { border-bottom-color: rgba(0,0,0,.07); background: #fafaf9; color: #5f6368; }
	    .tabulator .tabulator-header .tabulator-col { min-height: 32px; border-right-color: rgba(0,0,0,.018); background: #fafaf9; color: #5f6368; }
	    .tabulator .tabulator-header .tabulator-col .tabulator-col-content { padding: 7px 8px; }
	    .tabulator .tabulator-header .tabulator-col.tabulator-range-highlight,
	    .tabulator .tabulator-header .tabulator-col.tabulator-range-selected { background: #fafaf9 !important; color: #5f6368 !important; }
	    .tabulator .tabulator-header .tabulator-col.tabulator-sortable .tabulator-col-title { padding-right: 0; }
	    .tabulator .tabulator-header .tabulator-col .tabulator-col-sorter { width: 0 !important; display: none !important; visibility: hidden !important; }
	    .tabulator .tabulator-header .tabulator-col .tabulator-col-sorter * { display: none !important; }
	    .tabulator .tabulator-tableholder, .tabulator .tabulator-tableholder .tabulator-table { background: #fff; color: #171717; }
	    .tabulator-row, .tabulator-row.tabulator-row-even { min-height: 30px; background: #fff; border-color: rgba(0,0,0,.04); color: #171717; }
	    .tabulator-row:hover { background: #f8f8f7; }
	    .tabulator-row.data-grid-row-checked { background: #f2f7f4; }
	    .tabulator-cell { min-height: 30px; border-color: rgba(0,0,0,.018); padding: 6px 8px; }
	    .tabulator-cell.tabulator-editing { border: 0 !important; border-right: 1px solid rgba(0,0,0,.018) !important; background: rgba(36,132,93,.04); box-shadow: inset 0 0 0 1px rgba(36,132,93,.18); padding: 6px 8px !important; }
	    .tabulator-cell.tabulator-editing input, .tabulator-cell.tabulator-editing select, .tabulator-cell.tabulator-editing textarea { width: 100%; min-height: 17px; margin: 0; border: 0 !important; background: transparent; color: #171717; font: inherit; line-height: inherit; outline: none; padding: 0; vertical-align: top; }
	    .tabulator-col { position: relative; }
	    .tabulator .tabulator-cell.tabulator-row-header,
	    .tabulator .tabulator-header .tabulator-col.tabulator-row-header { background: #fafaf9; border-right-color: rgba(0,0,0,.018); }
	    .tabulator .tabulator-cell.tabulator-row-header { display: inline-flex; align-items: center; justify-content: center; padding: 0 !important; border-bottom: 0 !important; box-shadow: none !important; }
	    .tabulator .tabulator-header .tabulator-col.tabulator-row-header .tabulator-col-content { height: 100%; display: flex; align-items: center; justify-content: center; padding: 0 !important; }
	    .data-grid-column-title { display: inline-flex; align-items: center; gap: 3px; min-width: 0; max-width: 100%; }
	    .data-grid-column-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	    .data-grid-column-sort-indicator { width: 8px; height: 14px; flex: 0 0 8px; display: none; align-items: center; justify-content: center; color: #a0a6ad; font-size: 10px; font-weight: 650; line-height: 1; opacity: 0; }
	    .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .data-grid-column-sort-indicator,
	    .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .data-grid-column-sort-indicator { display: inline-flex; color: #8b929c; opacity: 1; }
	    .tabulator .tabulator-header .tabulator-col[aria-sort="ascending"] .data-grid-column-sort-indicator::before { content: "↑"; }
	    .tabulator .tabulator-header .tabulator-col[aria-sort="descending"] .data-grid-column-sort-indicator::before { content: "↓"; }
	    .data-grid-column-filter-btn { width: 14px; height: 14px; border: 0; border-radius: 2px; background: transparent; color: #a0a6ad; opacity: 0; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
	    .data-grid-filter-mark { width: 9px; height: 8px; display: block; background: linear-gradient(currentColor,currentColor) 1px 1px/7px 1px no-repeat, linear-gradient(currentColor,currentColor) 2px 4px/5px 1px no-repeat, linear-gradient(currentColor,currentColor) 3px 7px/3px 1px no-repeat; border-radius: 999px; }
	    .tabulator-col:hover .data-grid-column-filter-btn, .data-grid-column-filter-btn.active { opacity: 1; }
	    .data-grid-column-filter-btn.active, .data-grid-column-filter-btn:hover { background: transparent; color: #24845d; }
	    .tabulator .tabulator-col-resize-handle { background: transparent !important; }
	    .tabulator .tabulator-col-resize-guide { width: 1px; background: #24845d; opacity: .42; }
	    .tabulator .tabulator-header .tabulator-col:last-child, .tabulator .tabulator-header .tabulator-col:last-of-type, .tabulator .tabulator-row .tabulator-cell:last-child, .tabulator .tabulator-row .tabulator-cell:last-of-type { border-right-color: transparent; }
		    #filter-popover { position: absolute; z-index: 10; width: 252px; max-width: calc(100% - 16px); box-sizing: border-box; padding: 10px; border: 1px solid rgba(0,0,0,.08); border-radius: 5px; background: rgba(255,255,255,.98); box-shadow: 0 12px 28px rgba(0,0,0,.09); }
	    #filter-popover, #filter-popover *, #filter-popover *::before, #filter-popover *::after { box-sizing: border-box; }
	    #filter-popover.hidden { display: none; }
	    #filter-popover .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; color: #222; font-weight: 650; }
	    #filter-popover .head button { width: 24px; height: 24px; border: 0; border-radius: 5px; background: transparent; color: #8b929c; font-size: 16px; }
	    #filter-summary { margin-bottom: 8px; color: #8b929c; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	    #filter-popover .head button:focus-visible, #filter-popover .actions button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(36,132,93,.07); border-color: rgba(36,132,93,.42); }
	    #filter-input { width: 100%; max-width: 100%; height: 32px; display: block; border: 1px solid #ddd; border-radius: 6px; padding: 0 9px; font: inherit; outline: none; }
		    #filter-input:focus { border-color: rgba(0,0,0,.26); box-shadow: 0 0 0 3px rgba(0,0,0,.035); }
		    #filter-popover .actions { display: flex; justify-content: flex-end; margin-top: 7px; }
		    #filter-popover .actions button { height: 24px; border: 0; border-radius: 5px; background: transparent; color: #686f78; font: inherit; font-size: 11px; }
	    .data-grid-row-check, .data-grid-row-check-all { width: 12px; height: 12px; margin: 0; appearance: none; -webkit-appearance: none; position: relative; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 12px; box-sizing: border-box; border: 1px solid rgba(0,0,0,.18); border-radius: 3px; background: #fff; box-shadow: none; line-height: 0; outline: none; cursor: pointer; }
	    .data-grid-row-check:hover, .data-grid-row-check-all:hover { border-color: rgba(36,132,93,.52); }
	    .data-grid-row-check:checked, .data-grid-row-check-all:checked, .data-grid-row-check-all:indeterminate { border-color: #24845d; background: #24845d; }
	    .data-grid-row-check:checked::after, .data-grid-row-check-all:checked::after { content: ""; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; background: #fff; transform: translate(-50%, -50%); -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2.15 5.05 4.25 7.1 7.85 3.25' fill='none' stroke='black' stroke-width='1.45' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 8px 8px no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M2.15 5.05 4.25 7.1 7.85 3.25' fill='none' stroke='black' stroke-width='1.45' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / 8px 8px no-repeat; }
	    .data-grid-row-check-all:indeterminate::after { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 1.5px; border-radius: 999px; background: #fff; transform: translate(-50%, -50%); }
	    .tabulator-row .tabulator-cell.tabulator-range-selected:not(.tabulator-range-only-cell-selected):not(.tabulator-range-row-header),
	    .tabulator-row.tabulator-range-highlight .tabulator-cell.tabulator-range-row-header { background: rgba(36,132,93,.06) !important; }
	    .tabulator-row.tabulator-range-highlight.tabulator-range-selected .tabulator-cell.tabulator-range-row-header,
	    .tabulator-row.tabulator-range-selected .tabulator-cell.tabulator-range-row-header { background: #f0f6f3 !important; color: #171717 !important; }
	    .tabulator .tabulator-tableholder .tabulator-range-overlay { overflow: visible; z-index: 18; }
	    .tabulator-range, .tabulator-range-cell-active { border: 0 !important; box-sizing: border-box; }
	    .tabulator .tabulator-tableholder .tabulator-range-overlay .tabulator-range { border: 0 !important; box-shadow: inset 0 0 0 1px #24845d; }
	    .tabulator .tabulator-tableholder .tabulator-range-overlay .tabulator-range-cell-active { border: 0 !important; box-shadow: inset 0 0 0 2px #24845d; }
	    .tabulator .tabulator-tableholder .tabulator-range-overlay .tabulator-range.tabulator-range-active::after { background: #24845d !important; box-shadow: 0 0 0 2px #fff; }
  </style>
  <div class="shell">
    <div class="toolbar">
      <span class="dot"></span><strong>数据表</strong><span>区域选择 · 列值过滤 · 行勾选</span>
      <span class="spacer"></span>
      <button id="copy-range" disabled>复制选区</button>
      <button id="clear-filters" class="hidden">清除过滤</button>
      <span id="status"></span>
    </div>
	    <div id="grid"></div>
	      <div id="filter-popover" class="hidden">
	        <div class="head"><span id="filter-title"></span><button id="filter-close" type="button" aria-label="关闭">×</button></div>
	        <div id="filter-summary"></div>
	        <div id="filter-custom"><input id="filter-input" autocomplete="off"></div>
	        <div class="actions"><button id="filter-clear" type="button">清除</button></div>
	      </div>
	  </div>
  <script>${tabulatorJs}</script>`);

await page.evaluate(() => {
  window.selectedRows = new Set();
  window.activeFilters = new Map();
  window.openFilterField = "";
  function rowHeaderFormatter(cell) {
    const id = cell.getRow().getData()._rowId;
    return `<input class="data-grid-row-check" type="checkbox" data-row-id="${id}" aria-label="选择行">`;
  }
  function rowHeaderTitleFormatter() {
    return `<input class="data-grid-row-check-all" type="checkbox" aria-label="选择全部可见行">`;
  }
  function columnTitleFormatter(header) {
    const field = header.getColumn().getField();
    const label = header.getValue();
    const active = window.activeFilters.has(field);
    return `<span class="data-grid-column-title ${active ? "is-filtered" : ""}">
      <span class="data-grid-column-title-text">${label}</span>
      <span class="data-grid-column-sort-indicator" aria-hidden="true"></span>
      <button class="data-grid-column-filter-btn ${active ? "active" : ""}" type="button" data-filter-field="${field}" aria-label="${label}筛选">
        <span class="data-grid-filter-mark" aria-hidden="true"></span>
      </button>
    </span>`;
  }
  function formatValue(value) {
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
  function numberFilter(query, rowValue) {
    const value = Number(rowValue);
    if (!Number.isFinite(value)) return false;
    const comparison = String(query).replace(/\s+/g, "").match(/^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/);
    if (!comparison) return String(rowValue ?? "").includes(String(query));
    const operator = comparison[1] || "=";
    const expected = Number(comparison[2]);
    if (operator === ">") return value > expected;
    if (operator === ">=") return value >= expected;
    if (operator === "<") return value < expected;
    if (operator === "<=") return value <= expected;
    return value === expected;
  }
  function headerFilter(headerValue, rowValue, _rowData, params = {}) {
    const query = String(headerValue ?? "").trim();
    if (!query) return true;
    if (params.type === "number") return numberFilter(query, rowValue);
    return formatValue(rowValue).toLowerCase().includes(query.toLowerCase());
  }
  function filterPredicate(data) {
    for (const [field, value] of window.activeFilters.entries()) {
      const type = field === "score" ? "number" : "";
      if (!headerFilter(value, data[field], data, { type })) return false;
    }
    return true;
  }
  function applyFilters() {
    if (window.activeFilters.size) window.demoTable.setFilter(filterPredicate);
    else window.demoTable.clearFilter();
    renderFilterStates();
    updateToolbar();
  }
  function renderFilterStates() {
    window.demoTable?.getColumns?.().forEach(column => {
      const field = column.getField();
      const active = window.activeFilters.has(field);
      column.getElement().classList.toggle("data-grid-col-filtered", active);
      column.getElement().querySelector(".data-grid-column-filter-btn")?.classList.toggle("active", active);
    });
  }
  function renderFilterMenu(field) {
    const activeValue = window.activeFilters.get(field) || "";
    document.getElementById("filter-summary").textContent = activeValue
      ? `当前：${activeValue}`
      : (field === "score" ? "支持 >、>=、<、<=、=，例如 >= 8.5" : "输入关键词，筛选包含该文本的行");
    document.getElementById("filter-input").value = activeValue;
  }
  function openFilter(field, anchor) {
    window.openFilterField = field;
    const popover = document.getElementById("filter-popover");
    const input = document.getElementById("filter-input");
    document.getElementById("filter-title").textContent = field === "score" ? "筛选 评分" : `筛选 ${field}`;
    renderFilterMenu(field);
    input.placeholder = field === "score" ? ">= 8" : "输入关键词";
    const shell = document.querySelector(".shell").getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    popover.style.left = `${Math.max(8, Math.min(rect.left - shell.left - 12, shell.width - 260))}px`;
    popover.style.top = `${rect.bottom - shell.top + 7}px`;
    popover.classList.remove("hidden");
    requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
  }
  function syncChecks() {
    document.querySelectorAll(".data-grid-row-check").forEach(input => {
      input.checked = window.selectedRows.has(input.dataset.rowId);
      input.closest(".tabulator-row")?.classList.toggle("data-grid-row-checked", input.checked);
    });
  }
	  function rangeTsv() {
	    const ranges = window.demoTable?.getRanges?.() || [];
	    const range = ranges[ranges.length - 1];
	    const rows = range?.getStructuredCells?.() || [];
	    return rows.map(row => row.map(cell => String(cell?.getValue?.() ?? "")).join("\t")).filter(Boolean).join("\n");
	  }
	  function parsePasteRows(text) {
	    return String(text || "").trimEnd().split(/\r?\n/).map(row => row.split("\t")).filter(row => row.some(Boolean));
	  }
	  function pasteTextIntoGrid(text) {
	    const ranges = window.demoTable?.getRanges?.() || [];
	    const range = ranges[ranges.length - 1];
	    const anchor = range?.getStructuredCells?.()?.flat?.()?.find(cell => cell?.getField?.());
	    if (!anchor) return 0;
	    const fields = ["name", "city", "score"];
	    const rows = window.demoTable.getRows("active");
	    const startCol = fields.indexOf(anchor.getField());
	    const startRow = rows.findIndex(row => row.getData()._rowId === anchor.getRow().getData()._rowId);
	    if (startCol < 0 || startRow < 0) return 0;
	    let changed = 0;
	    parsePasteRows(text).forEach((pasteRow, rowOffset) => {
	      const row = rows[startRow + rowOffset];
	      if (!row) return;
	      const patch = {};
	      pasteRow.forEach((value, colOffset) => {
	        const field = fields[startCol + colOffset];
	        if (!field) return;
	        patch[field] = field === "score" ? Number(value) : value;
	        changed += 1;
	      });
	      row.update(patch);
	    });
	    return changed;
	  }
	  function updateToolbar() {
	    syncChecks();
	    const filters = [...window.activeFilters.values()].filter(value => String(value ?? "").trim());
    const active = window.demoTable.getRows("active").length;
    const total = window.demoTable.getRows().length;
    document.getElementById("clear-filters").classList.toggle("hidden", filters.length === 0);
    document.getElementById("copy-range").disabled = !rangeTsv();
    document.getElementById("status").textContent = filters.length ? `过滤后 ${active}/${total}` : "";
  }
	  const grid = document.getElementById("grid");
	  grid.tabIndex = 0;
  grid.addEventListener("pointerdown", event => {
    if (!event.target.closest(".data-grid-column-filter-btn")) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
	  grid.addEventListener("pointerdown", event => {
	    if (!event.target.closest("input, textarea, button")) grid.focus({ preventScroll: true });
	  });
    grid.addEventListener("click", event => {
      const btn = event.target.closest(".data-grid-column-filter-btn");
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      openFilter(btn.dataset.filterField, btn);
    }, true);
	  grid.addEventListener("mousedown", event => {
	    if (event.target.closest(".data-grid-row-check, .data-grid-row-check-all")) event.stopPropagation();
	  });
  grid.addEventListener("change", event => {
    const target = event.target;
    if (!target.classList.contains("data-grid-row-check")) return;
	    if (target.checked) window.selectedRows.add(target.dataset.rowId);
	    else window.selectedRows.delete(target.dataset.rowId);
	    syncChecks();
	  });
	  grid.addEventListener("paste", event => {
	    if (event.target.closest("input, textarea")) return;
	    const text = event.clipboardData?.getData("text/plain") || "";
	    if (!text.trim()) return;
	    event.preventDefault();
	    window.pastedCells = pasteTextIntoGrid(text);
	    document.getElementById("status").textContent = `已粘贴 ${window.pastedCells} 格`;
	    updateToolbar();
	  });
	  document.getElementById("copy-range").addEventListener("click", () => {
	    window.copiedRange = rangeTsv();
    document.getElementById("status").textContent = "已复制选区";
  });
	  document.getElementById("clear-filters").addEventListener("click", () => {
	    window.activeFilters.clear();
	    document.getElementById("filter-popover").classList.add("hidden");
	    applyFilters();
    document.getElementById("status").textContent = "过滤已清除";
  });
	  document.getElementById("filter-input").addEventListener("input", event => {
	    const value = event.target.value.trim();
	    if (value) window.activeFilters.set(window.openFilterField, value);
	    else window.activeFilters.delete(window.openFilterField);
	    applyFilters();
    renderFilterMenu(window.openFilterField);
	  });
	  document.getElementById("filter-input").addEventListener("keydown", event => {
	    if (event.key === "Enter" || event.key === "Escape") document.getElementById("filter-popover").classList.add("hidden");
	  });
	  document.getElementById("filter-close").addEventListener("click", () => document.getElementById("filter-popover").classList.add("hidden"));
		  document.getElementById("filter-clear").addEventListener("click", () => {
		    window.activeFilters.delete(window.openFilterField);
		    document.getElementById("filter-input").value = "";
		    applyFilters();
    renderFilterMenu(window.openFilterField);
		  });
  document.querySelector(".shell").addEventListener("pointerdown", event => {
    const popover = document.getElementById("filter-popover");
    if (popover.classList.contains("hidden")) return;
    if (event.target.closest("#filter-popover, .data-grid-column-filter-btn")) return;
    popover.classList.add("hidden");
    window.openFilterField = "";
  }, true);
	  window.demoTable = new Tabulator(grid, {
    data: [
      { _rowId: "r1", name: "杭州西湖", city: "杭州", score: 9.3 },
      { _rowId: "r2", name: "灵隐寺", city: "杭州", score: 8.7 },
      { _rowId: "r3", name: "夫子庙", city: "南京", score: 7.5 },
      { _rowId: "r4", name: "苏州博物馆", city: "苏州", score: 9.1 },
    ],
    columns: [
      { title: "名称", field: "name", editor: "input", minWidth: 88, titleFormatter: columnTitleFormatter },
      { title: "城市", field: "city", editor: "input", minWidth: 88, titleFormatter: columnTitleFormatter },
      { title: "评分", field: "score", editor: "number", sorter: "number", minWidth: 88, titleFormatter: columnTitleFormatter },
    ],
    index: "_rowId",
    height: "100%",
    layout: "fitDataFill",
    nestedFieldSeparator: false,
    selectableRange: true,
    selectableRangeRows: true,
    selectableRangeColumns: true,
    selectableRangeInitializeDefault: false,
    selectableRangeClearCells: false,
	    clipboard: true,
	    clipboardCopyRowRange: "range",
	    clipboardCopyStyled: false,
	    clipboardPasteAction: false,
	    rowHeader: {
      formatter: rowHeaderFormatter,
      titleFormatter: rowHeaderTitleFormatter,
      headerSort: false,
      hozAlign: "center",
      width: 36,
    },
  });
  window.demoTable.on("renderComplete", updateToolbar);
  window.demoTable.on("dataFiltered", updateToolbar);
  window.demoTable.on("rangeAdded", updateToolbar);
  window.demoTable.on("rangeChanged", updateToolbar);
  window.demoTable.on("rangeRemoved", updateToolbar);
});

await page.waitForSelector(".tabulator-cell[tabulator-field='name']");
await waitForDemoStep(500);
await page.locator(".data-grid-column-filter-btn[data-filter-field='score']").click({ force: true });
await page.waitForSelector("#filter-popover:not(.hidden)");
await assertDemoVisualIntegrity("filter popover opened");
await waitForDemoStep(1100);
await page.locator("#filter-input").fill(">=8.8");
await page.waitForFunction(() => window.demoTable.getRows("active").length === 2);
await assertDemoVisualIntegrity("filter input applied");
await waitForDemoStep(700);
await page.locator(".data-grid-row-check").first().check();
await page.waitForFunction(() => window.selectedRows.size === 1);
await assertDemoVisualIntegrity("row checked");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.getElementById("filter-popover").classList.contains("hidden"));
await waitForDemoStep(1100);

const firstName = await page.locator(".tabulator-cell[tabulator-field='name']").first().boundingBox();
const secondScore = await page.locator(".tabulator-cell[tabulator-field='score']").nth(1).boundingBox();
assert.ok(firstName, "first name cell should be visible");
assert.ok(secondScore, "second score cell should be visible");
await page.mouse.move(firstName.x + 12, firstName.y + firstName.height / 2);
await page.mouse.down();
await page.mouse.move(secondScore.x + secondScore.width - 12, secondScore.y + secondScore.height / 2, { steps: 8 });
await page.mouse.up();
await page.waitForSelector(".tabulator-range, .tabulator-range-cell-active, .tabulator-range-selected");
await page.waitForFunction(() => !document.getElementById("copy-range").disabled);
await assertDemoVisualIntegrity("range selected");
await waitForDemoStep(500);
await page.locator("#copy-range").click();
await page.waitForFunction(() => window.copiedRange && window.copiedRange.includes("杭州西湖"));
await waitForDemoStep(1000);
await page.locator("#clear-filters").click();
await page.waitForFunction(() => window.demoTable.getRows("active").length === 4);
await waitForDemoStep(700);

const firstNameAfterClear = await page.locator(".tabulator-cell[tabulator-field='name']").first().boundingBox();
assert.ok(firstNameAfterClear, "first name cell should remain visible after clearing filters");
await page.mouse.move(firstNameAfterClear.x + 12, firstNameAfterClear.y + firstNameAfterClear.height / 2);
await page.mouse.down();
await page.mouse.up();
await page.waitForFunction(() => !document.getElementById("copy-range").disabled);
await page.evaluate(() => {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData(type) {
        return type === "text/plain" ? "西溪湿地\t杭州\t8.9\n拙政园\t苏州\t9" : "";
      },
    },
  });
  document.getElementById("grid").dispatchEvent(event);
});
await page.waitForFunction(() => window.pastedCells === 6);
await waitForDemoStep(900);

const result = await page.evaluate(() => ({
  activeRows: window.demoTable.getRows("active").length,
  checkedRows: window.selectedRows.size,
  rangeMarks: document.querySelectorAll(".tabulator-range, .tabulator-range-cell-active, .tabulator-range-selected").length,
  copiedRange: window.copiedRange,
  pastedCells: window.pastedCells,
  firstRow: window.demoTable.getRows()[0].getData(),
}));

await page.evaluate(() => window.demoTable.setSort("score", "asc"));
await page.waitForFunction(() => document.querySelector(".tabulator-col[tabulator-field='score']")?.getAttribute("aria-sort") === "ascending");
await assertDemoVisualIntegrity("score sorted");
await waitForDemoStep(900);

await context.close();
await browser.close();

assert.deepEqual(errors, [], "browser page should not emit errors");
assert.equal(result.activeRows, 4, "clear filter should restore all rows");
assert.equal(result.checkedRows, 1, "custom row checkbox should select one row");
assert.ok(result.rangeMarks > 0, "cell range drag should render a selected range");
assert.match(result.copiedRange, /杭州西湖\t杭州\t9\.3/, "range copy should include the first visible row");
assert.match(result.copiedRange, /苏州博物馆\t苏州\t9\.1/, "range copy should include the second visible row after numeric filtering");
assert.equal(result.pastedCells, 6, "keyboard paste should update a selected 2x3 range");
assert.equal(result.firstRow.name, "西溪湿地", "pasted range should update visible cell data");

console.log("data grid browser smoke passed");
if (videoDir) console.log(`video dir: ${videoDir}`);

async function loadPlaywright() {
  try {
    return normalizePlaywrightImport(await import("playwright"));
  } catch (error) {
    const explicitPath = process.env.PLAYWRIGHT_PATH || "";
    if (explicitPath) return normalizePlaywrightImport(await import(pathToFileURL(explicitPath).href));
    throw new Error("Data Grid browser smoke requires Playwright; run npm ci or set PLAYWRIGHT_PATH.", { cause: error });
  }
}

function normalizePlaywrightImport(module) {
  return module?.chromium ? module : (module?.default?.chromium ? module.default : module);
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

function clampViewport(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function waitForDemoStep(ms) {
  if (!recordingDemo) return;
  await page.waitForTimeout(ms);
}

async function assertDemoVisualIntegrity(label) {
  const issues = await page.evaluate(() => {
    const found = [];
    const viewportWidth = document.documentElement.clientWidth;
    const pageWidth = Math.ceil(document.documentElement.scrollWidth);
    if (pageWidth > viewportWidth + 1) {
      found.push(`page overflows horizontally: ${pageWidth} > ${viewportWidth}`);
    }

    const popover = document.getElementById("filter-popover");
    const input = document.getElementById("filter-input");
    if (popover && input && !popover.classList.contains("hidden")) {
      const p = popover.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      if (p.left < -0.5 || p.right > window.innerWidth + 0.5) {
        found.push(`filter popover escapes viewport: ${Math.round(p.left)}..${Math.round(p.right)}`);
      }
      if (i.left < p.left - 0.5 || i.right > p.right + 0.5) {
        found.push(`filter input escapes popover: input ${Math.round(i.left)}..${Math.round(i.right)}, popover ${Math.round(p.left)}..${Math.round(p.right)}`);
      }
    }

    document.querySelectorAll(".data-grid-column-title-text").forEach(el => {
      if (el.scrollWidth > el.clientWidth + 1) {
        found.push(`header text clipped: ${el.textContent?.trim() || ""}`);
      }
    });

    document.querySelectorAll(".data-grid-row-check, .data-grid-row-check-all").forEach(inputEl => {
      const host = inputEl.closest(".tabulator-cell, .tabulator-col");
      if (!host) return;
      const child = inputEl.getBoundingClientRect();
      const parent = host.getBoundingClientRect();
      if (child.left < parent.left - 0.5 || child.right > parent.right + 0.5 || child.top < parent.top - 0.5 || child.bottom > parent.bottom + 0.5) {
        found.push("row checkbox escapes its header cell");
      }
    });

    document.querySelectorAll(".tabulator-range-overlay .tabulator-range, .tabulator-range-overlay .tabulator-range-cell-active").forEach(el => {
      const style = getComputedStyle(el);
      if (style.boxShadow === "none") {
        found.push("range overlay is missing inset drawing");
      }
      if (style.borderTopWidth !== "0px") {
        found.push("range overlay still relies on border drawing");
      }
    });

    return found;
  });
  assert.deepEqual(issues, [], `${label} visual integrity`);
}
