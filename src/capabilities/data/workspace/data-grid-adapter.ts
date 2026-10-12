import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import type { DataRow, DataColumnMeta, updateDataRow as persistDataRow } from "#sdk/shared/data";
import type { GridCell, GridColumn, GridRow, GridRecord, GridSorter, GridInstance, GridConstructor } from "./data-grid-vendor.js";
import { loadDataGrid } from "./data-grid-loader.js";
import { escapeHtml } from "#sdk/sidepanel/dom";
import { countDelimiter, parseDelimitedRows } from "./data-import-parser.js";
import { createDataGridFilterModel, type DataGridFilter } from "./data-grid-filter-model.js";
import { createDataGridSortProfiles, type DataSortProfile } from "./data-grid-sort-profiles.js";
import { createDataGridLifecycle } from "./data-grid-lifecycle.js";

interface GridOptions {
  signal?: AbortSignal;
  dataPreview: HTMLElement;
  isActive?(): boolean;
  startTrace?(event: string, detail?: Record<string, unknown>): (detail?: Record<string, unknown>) => void;
  gridTrace?(event: string, detail: Record<string, unknown>): void;
  getCurrentTable?(): string | null; getRows?(): DataRow[]; getColumns?(): string[]; getVisibleColumns?(): Set<string>;
  getDataColumnMeta?(column: string): DataColumnMeta;
  formatDataCell?(record: DataRow, column: string): string;
  openDataCellEditor?(id: string, field: string): void; closeCurrentDataCellEditor?(): void;
  isEditableDataColumn?(column: string): boolean; isEditableDataColumnName?(column: string): boolean;
  isCurrentImageCollectionTable?(): boolean; updateDataGridSelectionControls?(): void;
  dataFieldValue?(row: DataRow, field: string): unknown; highlightDataCellText?(text: string): string;
  replaceCurrentDataRow?(row: DataRow | null): void;
  setDataEditStatus?(message: string, state?: string, options?: { timeout?: number }): void;
  refreshDataTablesCacheQuietly?(): void; updateDataRow?: typeof persistDataRow;
  persistDataGridColumnOrder?(): void; persistDataGridColumnLayout?(): void; renderCurrentDataTable?(): void;
  normalizeDataUserColumnOrder?(order: string[]): string[]; normalizeDataColumnPrompt?(value: unknown): string;
  setLegacySortState?(column: string, dir: string): void;
  minTableHeight?: number; minColumnWidth?: number; longCellThreshold?: number;
  categoricalOptionLimit?: number; sortSampleLimit?: number; sortMinParseRatio?: number; widthSampleRows?: number;
}

export function createDataGridAdapter(options: GridOptions) {
  const lifecycleSignal = options.signal;
  const {
    dataPreview,
    isActive = () => false,
    startTrace = () => () => {},
    gridTrace = () => {},
    getCurrentTable = () => "",
    getRows = () => [],
    getColumns = () => [],
    getVisibleColumns = () => new Set(),
    getDataColumnMeta = (): DataColumnMeta => ({}),
    formatDataCell = value => String(value ?? ""),
    openDataCellEditor = () => {},
    closeCurrentDataCellEditor = () => {},
    isEditableDataColumn = () => false,
    isEditableDataColumnName = () => false,
    isCurrentImageCollectionTable = () => false,
    updateDataGridSelectionControls = () => {},
    dataFieldValue = () => undefined,
    highlightDataCellText = text => escapeHtml(text),
    replaceCurrentDataRow = () => {},
    setDataEditStatus = () => {},
    refreshDataTablesCacheQuietly = () => {},
    updateDataRow = async () => null,
    persistDataGridColumnOrder = () => {},
    persistDataGridColumnLayout = () => {},
    renderCurrentDataTable = () => {},
    normalizeDataUserColumnOrder = order => [...order],
    normalizeDataColumnPrompt = value => String(value || "").trim(),
    setLegacySortState = () => {},
  } = options;

  const DATA_GRID_MIN_TABLE_HEIGHT = Number(options.minTableHeight || 220);
  const DATA_GRID_MIN_COLUMN_WIDTH = Number(options.minColumnWidth || 96);
  const DATA_GRID_LONG_CELL_THRESHOLD = Number(options.longCellThreshold || 72);
  const DATA_GRID_CATEGORICAL_OPTION_LIMIT = Number(options.categoricalOptionLimit || 80);
  let dataGridInstance: GridInstance | null = null;
  let Tabulator: GridConstructor | null = null;
  let pendingRender = 0;
  let needsRender = false;
  let dataGridRenderKey = "";
  let dataGridRenderedTableName = "";
  const dataGridSortStateByTable = new Map<string, GridSorter[]>();
  let dataGridResizeObserver: ResizeObserver | null = null;
  let dataGridResizeFrame = 0;
  let dataGridLastHeight = 0;
  let dataGridScrollHolder: HTMLElement | null = null;
  let dataGridViewportSyncFrame = 0;
  let dataGridViewportSettleTimer = 0;
  let dataGridViewportLateTimer = 0;
  let dataGridSortStabilizeTimer = 0;
  let dataGridCopyFeedbackTimer = 0;
  let dataGridBaseRows: GridRecord[] = [];
  let dataGridSortProfiles = new Map<string, DataSortProfile>();
  let dataGridFilterPopoverField = "";
  let dataGridSuppressColumnMoved = false;
  let selectedDataGridRowIds = new Set<string>();
  const lifecycle = createDataGridLifecycle();

  const dataGridSortEngine = createDataGridSortProfiles({
    sampleLimit: Number(options.sortSampleLimit || 100),
    minParseRatio: Number(options.sortMinParseRatio || 0.85),
    widthSampleRows: Number(options.widthSampleRows || 10),
    getCurrentTable,
    getRows,
    getProfiles: () => dataGridSortProfiles,
    formatCellValue: formatDataGridCellValue,
    formatCell: formatDataCell,
  });
  const dataGridFilterModel = createDataGridFilterModel({
    getRows: () => dataGridBaseRows,
    formatCellValue: formatDataGridCellValue,
  });

  function normalizeDataGridSortState(sorters: GridSorter[] = [], columns: string[] | null = null) {
    const allowed = Array.isArray(columns) && columns.length ? new Set(columns) : null;
    const seen = new Set();
    return (Array.isArray(sorters) ? sorters : [])
      .map(sorter => {
        const component = sorter?.column;
        const field = String(
          sorter?.field
          || (typeof component === "string" ? component : component?.getField?.())
          || ""
        ).trim();
        const dir: "asc" | "desc" = String(sorter?.dir || "asc").toLowerCase() === "desc" ? "desc" : "asc";
        return { column: field, dir };
      })
      .filter(sorter => sorter.column && (!allowed || allowed.has(sorter.column)))
      .filter(sorter => {
        if (seen.has(sorter.column)) return false;
        seen.add(sorter.column);
        return true;
      });
  }

  function getDataGridSortState(tableName = getCurrentTable(), columns = getColumns()) {
    const table = String(tableName || "").trim();
    if (!table) return [];
    const state = normalizeDataGridSortState(dataGridSortStateByTable.get(table), columns);
    if (state.length) dataGridSortStateByTable.set(table, state);
    else dataGridSortStateByTable.delete(table);
    return state;
  }

  function rememberDataGridSortState(sorters: GridSorter[] | null = null, tableName = dataGridRenderedTableName || getCurrentTable(), columns: string[] | null = null) {
    const table = String(tableName || "").trim();
    if (!table) return [];
    let source = sorters;
    if (!Array.isArray(source)) {
      try {
        source = dataGridInstance?.getSorters?.() || [];
      } catch (_err) {
        source = [];
      }
    }
    const state = normalizeDataGridSortState(source, columns);
    if (state.length) dataGridSortStateByTable.set(table, state);
    else dataGridSortStateByTable.delete(table);
    if (table === getCurrentTable()) {
      setLegacySortState(state[0]?.column || "", state[0]?.dir || "asc");
    }
    return state;
  }

  function restoreDataGridSortState(tableName = getCurrentTable(), columns = getColumns()) {
    const state = getDataGridSortState(tableName, columns);
    setLegacySortState(state[0]?.column || "", state[0]?.dir || "asc");
    return state;
  }


  function applyDataGridColumnOrderFast(order: string[] = []) {
    if (!dataGridInstance || isCurrentImageCollectionTable()) return false;
    const desired = normalizeDataUserColumnOrder(order).filter(column => getVisibleColumns().has(column));
    if (!desired.length) return true;
    const getComponentsByField = () => {
      const map = new Map<string, GridColumn>();
      (dataGridInstance?.getColumns?.() || []).forEach(component => {
        const field = normalizeDataColumnPrompt(component?.getField?.());
        if (isEditableDataColumnName(field)) map.set(field, component);
      });
      return map;
    };
    const currentFields = () => [...getComponentsByField().keys()];
    const before = currentFields();
    if (sameStringArray(before, desired)) return true;
    if (desired.some(field => !before.includes(field))) {
      gridTrace("column_reorder fast_skip", {
        table: getCurrentTable(),
        reason: "missing_visible_component",
        desired,
        current: before,
      });
      return false;
    }

    dataGridSuppressColumnMoved = true;
    try {
      for (let index = 0; index < desired.length; index += 1) {
        const current = currentFields();
        if (current[index] === desired[index]) continue;
        const components = getComponentsByField();
        const moving = components.get(desired[index]);
        if (!moving) return false;
        if (index === 0) {
          const target = components.get(current[0]);
          if (target && target !== moving) moving.move(target, false);
        } else {
          const previous = components.get(desired[index - 1]);
          if (previous && previous !== moving) moving.move(previous, true);
        }
      }
    } catch (err) {
      gridTrace("column_reorder fast_error", {
        table: getCurrentTable(),
        error: (err instanceof Error ? err.message : String(err)),
        desired,
        current: before,
      });
      return false;
    } finally {
      dataGridSuppressColumnMoved = false;
    }

    requestAnimationFrame(() => {
      updateDataGridRuntimeState();
      syncDataGridRangeOverlay();
    });
    gridTrace("column_reorder fast_apply", {
      table: getCurrentTable(),
      before,
      after: currentFields(),
    });
    return true;
  }

  function sameStringArray(a: string[] = [], b: string[] = []) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }


  function renderDataGrid(rows: DataRow[], columns: string[], metaText = "") {
    const request = ++pendingRender;
    if (lifecycleSignal?.aborted) return;
    needsRender = true;
    if (!isActive()) return;
    needsRender = false;
    if (columns.length && !Tabulator) {
      const table = getCurrentTable();
      const isCurrent = () => request === pendingRender && !lifecycleSignal?.aborted
        && isActive() && table === getCurrentTable();
      needsRender = true;
      dataPreview.innerHTML = `<div class="data-table-empty" role="status">${escapeHtml(t("loadingTable"))}</div>`;
      void loadDataGrid().then(vendor => {
        Tabulator = vendor.Tabulator;
        if (isCurrent()) renderDataGrid(rows, columns, metaText);
      }).catch(error => {
        if (!isCurrent()) return;
        gridTrace("render_grid.load_error", { table, error: error instanceof Error ? error.message : String(error) });
        dataPreview.innerHTML = `<div class="data-table-empty" role="status">${escapeHtml(t("couldNotLoadTheTableModuleReopenTheSide"))}</div>`;
      });
      return;
    }
    const endTrace = startTrace("render_grid", {
      table: getCurrentTable() || "",
      rows: Array.isArray(rows) ? rows.length : 0,
      columns: Array.isArray(columns) ? columns.length : 0,
    });
    if (!columns.length) {
      destroyDataGrid();
      dataPreview.innerHTML = `
        <div class="data-grid-shell">
          <div class="data-table-empty">${escapeHtml(t("selectAColumnOrAddOne"))}</div>
          ${metaText ? `<div class="data-preview-meta">${escapeHtml(metaText)}</div>` : ""}
        </div>
      `;
      endTrace({ path: "empty_columns" });
      return;
    }
    if (!Tabulator) return;

    const tableRows = rows.map(dataGridRowFromRecord);
    const nextSortProfiles = dataGridSortEngine.inferProfiles(tableRows, columns);
    const nextRenderKey = createDataGridRenderKey(columns, nextSortProfiles);
    dataGridFilterModel.pruneColumns(columns);
    if (dataGridInstance && dataGridRenderKey === nextRenderKey) {
      dataGridBaseRows = tableRows;
      dataGridSortProfiles = nextSortProfiles;
      if (refreshDataGridInstance(tableRows, metaText)) {
        endTrace({ path: "tabulator_replace", rows: tableRows.length });
        return;
      }
    }

    destroyDataGrid();
    const gridGeneration = lifecycle.begin("building");
    dataGridBaseRows = tableRows;
    dataGridSortProfiles = nextSortProfiles;

    dataPreview.innerHTML = `
      <div class="data-grid-shell">
        <div class="data-grid-table" aria-label="${escapeHtmlAttribute(t("dataGrid"))}"></div>
        <div class="qz-popover data-grid-filter-popover hidden" data-data-grid-filter-popover>
          <div class="data-grid-filter-head">
            <span data-data-grid-filter-title></span>
            <button class="qz-icon-btn qz-icon-btn--xs" type="button" data-data-grid-filter-close aria-label="${escapeHtmlAttribute(t("closeFilter"))}">×</button>
          </div>
          <div class="data-grid-filter-summary" data-data-grid-filter-summary></div>
          <div class="data-grid-filter-custom" data-data-grid-filter-custom>
            <input class="qz-field qz-field--sm" data-data-grid-filter-input type="text" autocomplete="off">
          </div>
          <div class="data-grid-filter-options hidden" data-data-grid-filter-options></div>
          <div class="data-grid-filter-actions">
            <button class="qz-btn qz-btn--ghost qz-btn--xs" type="button" data-data-grid-filter-clear>${escapeHtml(t("clear"))}</button>
          </div>
        </div>
        ${metaText ? `<div class="data-preview-meta" data-data-grid-meta data-base-text="${escapeHtmlAttribute(metaText)}">${escapeHtml(metaText)}</div>` : ""}
      </div>
    `;
    const tableEl = dataPreview.querySelector<HTMLElement>(".data-grid-table")!;
    tableEl.tabIndex = 0;
    const tableHeight = measureDataGridTableHeight(tableEl);
    tableEl.style.height = `${tableHeight}px`;
    dataGridLastHeight = tableHeight;
    const ctorEndTrace = startTrace("render_grid.tabulator_ctor", {
      table: getCurrentTable() || "",
      rows: tableRows.length,
      columns: columns.length,
      height: tableHeight,
    });
    try {
      dataGridInstance = new Tabulator(tableEl, {
      data: tableRows,
      columns: columns.map(buildDataGridColumn),
      initialSort: getDataGridSortState(getCurrentTable(), columns),
      index: "_rowId",
      height: `${tableHeight}px`,
      layout: "fitColumns",
      movableColumns: true,
      nestedFieldSeparator: false,
      placeholder: t("emptyTable"),
      editTriggerEvent: "dblclick",
      rowFormatter: applyDataGridRowSelectionState,
      selectableRange: true,
      selectableRangeRows: true,
      selectableRangeColumns: true,
      selectableRangeInitializeDefault: false,
      selectableRangeClearCells: false,
      clipboard: true,
      clipboardCopyRowRange: "range",
      clipboardCopyConfig: {
        rowHeaders: false,
        columnHeaders: true,
        columnCalcs: false,
      },
      clipboardCopyFormatter: dataGridClipboardCopyFormatter,
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
      },
      });
    } catch (error) {
      lifecycle.invalidate("empty");
      ctorEndTrace({ error: (error instanceof Error ? error.message : String(error)) });
      throw error;
    }
    const gridInstance = dataGridInstance;
    dataGridRenderKey = nextRenderKey;
    dataGridRenderedTableName = getCurrentTable() || "";
    lifecycle.transition("ready", gridGeneration);
    ctorEndTrace();
    bindDataGridViewportSync(tableEl);
    bindDataGridFilterPopover();
    tableEl.addEventListener("pointerdown", handleDataGridColumnFilterPointer, { capture: true, signal: lifecycleSignal });
    tableEl.addEventListener("click", handleDataGridColumnFilterClick, { capture: true, signal: lifecycleSignal });
    tableEl.addEventListener("pointerdown", focusDataGridOnPointerDown, { signal: lifecycleSignal });
    tableEl.addEventListener("change", handleDataGridRowHeaderChange, { signal: lifecycleSignal });
    // Intercept before Tabulator's range handlers can focus/scroll the grid.
    // Native checkbox activation and the delegated change handler stay intact.
    tableEl.addEventListener("mousedown", handleDataGridRowHeaderPointer, { capture: true, signal: lifecycleSignal });
    tableEl.addEventListener("click", handleDataGridRowHeaderPointer, { capture: true, signal: lifecycleSignal });
    tableEl.addEventListener("copy", handleDataGridCopy, { signal: lifecycleSignal });
    tableEl.addEventListener("paste", handleDataGridPaste, { signal: lifecycleSignal });
    const guard = <A extends unknown[], R>(callback: (...args: A) => R) => guardGridCallback(callback, gridGeneration, gridInstance);
    dataGridInstance.on("cellClick", guard(handleDataGridCellClick));
    dataGridInstance.on("cellDblClick", guard(handleDataGridCellDoubleClick));
    dataGridInstance.on("cellEditing", guard(handleDataGridInlineCellEditing));
    dataGridInstance.on("cellEdited", guard(handleDataGridCellEdited));
    dataGridInstance.on("columnMoved", guard(() => {
      if (dataGridSuppressColumnMoved) return;
      persistDataGridColumnOrder();
    }));
    dataGridInstance.on("columnResized", guard(() => persistDataGridColumnLayout()));
    dataGridInstance.on("tableBuilt", guard(handleDataGridTableBuilt));
    dataGridInstance.on("renderComplete", guard(handleDataGridRenderComplete));
    dataGridInstance.on("dataSorting", guard(handleDataGridSorting));
    dataGridInstance.on("dataSorted", guard(handleDataGridSorted));
    dataGridInstance.on("dataFiltered", guard(updateDataGridRuntimeState));
    dataGridInstance.on("rangeAdded", guard(updateDataGridRuntimeState));
    dataGridInstance.on("rangeChanged", guard(updateDataGridRuntimeState));
    dataGridInstance.on("rangeRemoved", guard(updateDataGridRuntimeState));
    dataGridInstance.on("scrollVertical", guard(handleDataGridViewportScroll));
    dataGridInstance.on("scrollHorizontal", guard(handleDataGridViewportScroll));
    observeDataGridResize(tableEl);
    updateDataGridRuntimeState();
    requestAnimationFrame(guard(() => {
      bindDataGridViewportSync(tableEl);
      updateDataGridRuntimeState();
    }));
    endTrace({ path: "tabulator", height: tableHeight });
  }

  function createDataGridRenderKey(columns: string[] = [], sortProfiles = dataGridSortProfiles) {
    return JSON.stringify([
      getCurrentTable() || "",
      (columns || []).map(column => {
        const meta = getDataColumnMeta(column);
        return [
          column,
          sortProfiles.get(column)?.kind || "text",
          meta.frozen === true,
          isEditableDataColumn(column),
        ];
      }),
    ]);
  }

  function refreshDataGridInstance(tableRows: GridRecord[], metaText = "") {
    const instance = dataGridInstance;
    if (!instance || typeof instance.replaceData !== "function") return false;
    const generation = lifecycle.generation;
    lifecycle.transition("updating", generation);
    updateDataGridMeta(metaText);
    let refresh;
    try {
      refresh = instance.replaceData(tableRows);
    } catch (_err) {
      return false;
    }
    Promise.resolve(refresh)
      .then(() => {
        if (dataGridInstance !== instance || !lifecycle.isCurrent(generation)) return;
        lifecycle.transition("ready", generation);
        const tableEl = dataPreview?.querySelector<HTMLElement>(".data-grid-table");
        bindDataGridViewportSync(tableEl);
        syncDataGridHeight(tableEl);
        updateDataGridRuntimeState();
      })
      .catch(err => {
        if (dataGridInstance !== instance || !lifecycle.isCurrent(generation)) return;
        lifecycle.transition("ready", generation);
        console.warn("[轻舟数据] refresh data grid failed", err);
        dataGridRenderKey = "";
        renderCurrentDataTable();
      });
    return true;
  }

  function updateDataGridMeta(metaText = "") {
    const metaEl = dataPreview?.querySelector<HTMLElement>("[data-data-grid-meta]");
    if (!metaEl) return;
    metaEl.dataset.baseText = String(metaText || "");
    metaEl.textContent = String(metaText || "");
  }

  function resumeDataGridAfterTabShow() {
    if (needsRender && isActive()) {
      renderCurrentDataTable();
      return;
    }
    const instance = dataGridInstance;
    const generation = lifecycle.generation;
    const tableEl = dataPreview?.querySelector<HTMLElement>(".data-grid-table");
    if (!instance || !tableEl) return;
    requestAnimationFrame(() => {
      if (!isActive() || dataGridInstance !== instance || !lifecycle.isCurrent(generation) || !tableEl.isConnected) return;
      syncDataGridHeight(tableEl);
      instance.redraw?.();
      scheduleDataGridViewportSync();
    });
  }

  function handleDataGridTableBuilt() {
    applyDataGridColumnFilters();
    updateDataGridRuntimeState();
  }

  function destroyDataGrid() {
    pendingRender += 1;
    needsRender = false;
    lifecycle.invalidate("empty");
    disconnectDataGridResizeObserver();
    disconnectDataGridViewportSync();
    const instance = dataGridInstance;
    if (instance) {
      rememberDataGridSortState(null, dataGridRenderedTableName || getCurrentTable());
      try {
        instance.destroy();
      } catch (_err) {}
    }
    dataGridInstance = null;
    dataGridRenderKey = "";
    dataGridRenderedTableName = "";
    dataGridBaseRows = [];
    dataGridSortProfiles = new Map();
    selectedDataGridRowIds.clear();
    closeDataGridFilterPopover();
    updateDataGridSelectionControls();
  }

  function guardGridCallback<A extends unknown[], R>(callback: (...args: A) => R, generation: number, instance: GridInstance) {
    return lifecycle.guard((...args: A) => {
      if (dataGridInstance !== instance) return undefined;
      return callback(...args);
    }, generation);
  }

  function measureDataGridTableHeight(tableEl: HTMLElement | null) {
    const shell = tableEl?.closest<HTMLElement>(".data-grid-shell");
    const shellRect = shell?.getBoundingClientRect?.();
    if (shellRect && shellRect.height > 0) {
      const metaEl = shell?.querySelector<HTMLElement>(".data-preview-meta");
      const metaHeight = metaEl?.getBoundingClientRect?.().height || 0;
      const available = Math.floor(shellRect.height - metaHeight);
      if (available > 0) return Math.max(DATA_GRID_MIN_TABLE_HEIGHT, available);
    }

    const tableRect = tableEl?.getBoundingClientRect?.();
    if (tableRect && tableRect.height > 0) {
      return Math.max(DATA_GRID_MIN_TABLE_HEIGHT, Math.floor(tableRect.height));
    }

    const viewportHeight = Math.max(360, window.innerHeight || 640);
    return Math.max(DATA_GRID_MIN_TABLE_HEIGHT, Math.min(720, Math.floor(viewportHeight * 0.62)));
  }

  function observeDataGridResize(tableEl: HTMLElement | null) {
    disconnectDataGridResizeObserver();
    if (!tableEl || typeof ResizeObserver !== "function") return;
    const resizeTarget = tableEl.closest<HTMLElement>(".data-grid-shell") || tableEl.parentElement || tableEl;
    dataGridResizeObserver = new ResizeObserver(() => scheduleDataGridHeightSync(tableEl));
    dataGridResizeObserver.observe(resizeTarget);
  }

  function scheduleDataGridHeightSync(tableEl: HTMLElement | null) {
    if (dataGridResizeFrame) cancelAnimationFrame(dataGridResizeFrame);
    dataGridResizeFrame = requestAnimationFrame(() => {
      dataGridResizeFrame = 0;
      syncDataGridHeight(tableEl);
    });
  }

  function syncDataGridHeight(tableEl: HTMLElement | null) {
    if (!dataGridInstance || !tableEl?.isConnected) return;
    const nextHeight = measureDataGridTableHeight(tableEl);
    if (!Number.isFinite(nextHeight) || Math.abs(nextHeight - dataGridLastHeight) < 1) return;
    dataGridLastHeight = nextHeight;
    tableEl.style.height = `${nextHeight}px`;
    try {
      dataGridInstance.setHeight?.(`${nextHeight}px`);
      dataGridInstance.redraw?.(true);
    } catch (err) {
      console.warn("[轻舟数据] resize data grid failed", err);
    }
  }

  function disconnectDataGridResizeObserver() {
    if (dataGridResizeFrame) {
      cancelAnimationFrame(dataGridResizeFrame);
      dataGridResizeFrame = 0;
    }
    if (dataGridResizeObserver) {
      dataGridResizeObserver.disconnect();
      dataGridResizeObserver = null;
    }
    dataGridLastHeight = 0;
  }

  function bindDataGridViewportSync(tableEl: HTMLElement | null) {
    const holder = tableEl?.querySelector<HTMLElement>(".tabulator-tableholder");
    if (!holder || holder === dataGridScrollHolder) return;
    disconnectDataGridViewportSync();
    dataGridScrollHolder = holder;
    holder.addEventListener("scroll", handleDataGridViewportScroll, { passive: true, signal: lifecycleSignal });
  }

  function disconnectDataGridViewportSync() {
    if (dataGridScrollHolder) {
      dataGridScrollHolder.removeEventListener("scroll", handleDataGridViewportScroll);
      dataGridScrollHolder = null;
    }
    if (dataGridViewportSyncFrame) {
      cancelAnimationFrame(dataGridViewportSyncFrame);
      dataGridViewportSyncFrame = 0;
    }
    if (dataGridViewportSettleTimer) {
      clearTimeout(dataGridViewportSettleTimer);
      dataGridViewportSettleTimer = 0;
    }
    if (dataGridViewportLateTimer) {
      clearTimeout(dataGridViewportLateTimer);
      dataGridViewportLateTimer = 0;
    }
    if (dataGridSortStabilizeTimer) {
      clearTimeout(dataGridSortStabilizeTimer);
      dataGridSortStabilizeTimer = 0;
    }
    clearDataGridCopyFeedback();
    setDataGridSortingVisualState(false);
  }

  function handleDataGridSorting() {
    setDataGridSortingVisualState(true);
    syncDataGridRangeOverlay();
  }

  function handleDataGridSorted(sorters: GridSorter[]) {
    rememberDataGridSortState(sorters, dataGridRenderedTableName || getCurrentTable(), getColumns());
    scheduleDataGridViewportSync();
    releaseDataGridSortingVisualStateSoon();
  }

  function handleDataGridRenderComplete() {
    updateDataGridRuntimeState();
    if (dataPreview?.querySelector<HTMLElement>(".data-grid-table.is-sorting")) {
      releaseDataGridSortingVisualStateSoon();
    }
  }

  function releaseDataGridSortingVisualStateSoon() {
    if (dataGridSortStabilizeTimer) clearTimeout(dataGridSortStabilizeTimer);
    requestAnimationFrame(() => {
      syncDataGridRangeOverlay();
      dataGridSortStabilizeTimer = setTimeout(() => {
        dataGridSortStabilizeTimer = 0;
        setDataGridSortingVisualState(false);
        scheduleDataGridViewportSync();
      }, 90);
    });
  }

  function setDataGridSortingVisualState(active: boolean) {
    dataPreview?.querySelector<HTMLElement>(".data-grid-table")?.classList.toggle("is-sorting", Boolean(active));
  }

  function handleDataGridViewportScroll() {
    scheduleDataGridViewportSync();
    if (dataGridViewportSettleTimer) clearTimeout(dataGridViewportSettleTimer);
    if (dataGridViewportLateTimer) clearTimeout(dataGridViewportLateTimer);
    dataGridViewportSettleTimer = setTimeout(() => {
      dataGridViewportSettleTimer = 0;
      scheduleDataGridViewportSync();
    }, 80);
    dataGridViewportLateTimer = setTimeout(() => {
      dataGridViewportLateTimer = 0;
      scheduleDataGridViewportSync();
    }, 260);
  }

  function scheduleDataGridViewportSync() {
    if (dataGridViewportSyncFrame) return;
    dataGridViewportSyncFrame = requestAnimationFrame(() => {
      dataGridViewportSyncFrame = 0;
      syncDataGridRangeOverlay();
      syncDataGridRowSelectionUi();
      syncDataGridCellOverflowActions();
    });
  }

  function syncDataGridRangeOverlay() {
    const rangeModule = dataGridInstance?.modules?.selectRange;
    if (!rangeModule) return;
    if (syncDataGridEmptySelectionState()) return;
    try {
      if (typeof rangeModule.layoutElement === "function") rangeModule.layoutElement(true);
      else if (typeof rangeModule.layoutRanges === "function") rangeModule.layoutRanges();
    } catch (_err) {}
  }

  function syncDataGridEmptySelectionState() {
    const tableEl = dataPreview?.querySelector<HTMLElement>(".data-grid-table");
    if (!tableEl || !dataGridInstance) return false;
    const empty = getDataGridRowsSafe("active").length === 0;
    tableEl.classList.toggle("is-empty-view", empty);
    return empty;
  }

  function handleDataGridCopy(event: ClipboardEvent) {
    if (!dataGridInstance || isCurrentImageCollectionTable()) return;
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("input, textarea, [contenteditable='true'], .tabulator-editing")) return;
    const cells = getCurrentDataRangeCells();
    if (!cells.length) return;
    if (syncDataGridEmptySelectionState()) return;
    flashDataGridCopyFeedback({ singleCell: cells.length === 1 });
  }

  function dataGridClipboardCopyFormatter(type: string, output: string) {
    if (type === "html") return "";
    const cells = getCurrentDataRangeCells();
    return cells.length === 1 ? formatDataGridCellValue(cells[0]?.getValue?.()) : output;
  }

  function flashDataGridCopyFeedback({ singleCell = false } = {}) {
    const tableEl = dataPreview?.querySelector<HTMLElement>(".data-grid-table");
    if (!tableEl) return;
    clearDataGridCopyFeedback();
    tableEl.classList.toggle("copy-single-cell", singleCell);
    void tableEl.offsetWidth;
    tableEl.classList.add("copy-confirmed");
    dataGridCopyFeedbackTimer = setTimeout(clearDataGridCopyFeedback, 620);
  }

  function clearDataGridCopyFeedback() {
    if (dataGridCopyFeedbackTimer) {
      clearTimeout(dataGridCopyFeedbackTimer);
      dataGridCopyFeedbackTimer = 0;
    }
    dataPreview?.querySelector<HTMLElement>(".data-grid-table")?.classList.remove("copy-confirmed", "copy-single-cell");
  }

  function buildDataGridColumn(column: string) {
    const meta = getDataColumnMeta(column);
    const editable = isEditableDataColumn(column);
    const sortProfile = dataGridSortEngine.getProfile(column);
    return {
      title: column,
      field: column,
      widthGrow: dataGridSortEngine.resolveColumnWidthGrow(column, meta),
      minWidth: editable ? DATA_GRID_MIN_COLUMN_WIDTH : 80,
      frozen: meta.frozen === true,
      titleFormatter: dataGridColumnTitleFormatter,
      editable: editable ? dataGridCellAllowsInlineEdit : false,
      editor: editable ? dataGridTextEditor : false,
      formatter: dataGridCellFormatter,
      cssClass: editable ? "" : "data-grid-system-cell",
      sorter: dataGridSortEngine.createColumnSorter(sortProfile),
      sorterParams: dataGridSortEngine.sorterParams,
    };
  }

  function applyDataGridRowSelectionState(row: GridRow) {
    const rowId = row?.getData?.()?._rowId || "";
    const checked = Boolean(rowId && selectedDataGridRowIds.has(rowId));
    const element = row?.getElement?.();
    element?.classList?.toggle?.("data-grid-row-checked", checked);
    const input = element?.querySelector<HTMLInputElement>(".data-grid-row-check");
    if (input) input.checked = checked;
  }

  function dataGridRowHeaderFormatter(cell: GridCell) {
    const rowId = cell?.getRow?.()?.getData?.()?._rowId || "";
    return `<input class="qz-checkbox data-grid-row-check" type="checkbox" data-row-id="${escapeHtmlAttribute(rowId)}" aria-label="${escapeHtmlAttribute(t("selectRow"))}">`;
  }

  function dataGridRowHeaderTitleFormatter() {
    return `<input class="qz-checkbox data-grid-row-check-all" type="checkbox" aria-label="${escapeHtmlAttribute(t("selectAllVisibleRows"))}">`;
  }

  function dataGridColumnTitleFormatter(header: Pick<GridCell, "getColumn" | "getValue">) {
    const column = header?.getColumn?.();
    const field = column?.getField?.() || "";
    const label = header?.getValue?.() || field;
    const active = dataGridFilterModel.filters.has(field);
    const sortLabel = dataGridSortEngine.getProfileLabel(field);
    return `
      <span class="data-grid-column-title ${active ? "is-filtered" : ""}" title="${escapeHtmlAttribute(t("sortBy", { name: String(label), type: String(sortLabel) }))}">
        <span class="data-grid-column-title-text">${escapeHtml(label)}</span>
        <span class="data-grid-column-sort-indicator" aria-hidden="true"></span>
        <button
          class="qz-icon-btn qz-icon-btn--xs data-grid-column-filter-btn ${active ? "active" : ""}"
          type="button"
          data-filter-field="${escapeHtmlAttribute(field)}"
          title="${escapeHtmlAttribute(active ? t("adjustFilter") : t("filter"))}"
          aria-label="${escapeHtmlAttribute(t("filterColumn", { name: String(label) }))}"
        >
          <span class="data-grid-filter-mark" aria-hidden="true"></span>
        </button>
      </span>
    `;
  }

  function handleDataGridColumnFilterPointer(event: Event) {
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".data-grid-column-filter-btn")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleDataGridColumnFilterClick(event: Event) {
    const btn = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".data-grid-column-filter-btn");
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    openDataGridColumnFilter(btn.dataset.filterField || "", btn);
  }

  function handleDataGridRowHeaderPointer(event: Event) {
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".data-grid-row-check, .data-grid-row-check-all")) {
      event.stopPropagation();
    }
  }

  function handleDataGridCellClick() {
    closeCurrentDataCellEditor();
    requestAnimationFrame(syncDataGridRangeOverlay);
  }

  function handleDataGridCellDoubleClick(_event: MouseEvent, cell: GridCell) {
    const content = getDataGridExpandableCellContent(cell?.getElement?.());
    if (!content) return;
    const rowId = cell?.getRow?.()?.getData?.()?._rowId || content.dataset.rowId || "";
    const field = cell?.getField?.() || content.dataset.field || "";
    requestAnimationFrame(() => {
      syncDataGridRangeOverlay();
      openDataCellEditor(rowId, field);
      requestAnimationFrame(syncDataGridRangeOverlay);
    });
  }

  function handleDataGridInlineCellEditing(cell: GridCell) {
    if (getDataGridExpandableCellContent(cell?.getElement?.())) return;
    closeCurrentDataCellEditor();
  }

  function getDataGridExpandableCellContent(target: HTMLElement | null | undefined) {
    const content = target?.closest<HTMLElement>(".data-grid-cell-content.has-action")
      || target?.querySelector<HTMLElement>(".data-grid-cell-content.has-action");
    if (!content || !dataPreview?.contains?.(content)) return null;
    return content;
  }

  function handleDataGridRowHeaderChange(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.classList.contains("data-grid-row-check-all")) {
      const ids = getDataGridActiveRowIds();
      selectedDataGridRowIds = target.checked ? new Set(ids) : new Set();
      syncDataGridRowSelectionUi();
      updateDataGridSelectionControls();
      return;
    }
    if (!target.classList.contains("data-grid-row-check")) return;
    const rowId = target.dataset.rowId || "";
    if (!rowId) return;
    if (target.checked) selectedDataGridRowIds.add(rowId);
    else selectedDataGridRowIds.delete(rowId);
    syncDataGridRowSelectionUi();
    updateDataGridSelectionControls();
  }

  function getDataGridRowsSafe(scope = "") {
    if (!dataGridInstance?.getRows) return [];
    try {
      const rows = scope ? dataGridInstance.getRows(scope) : dataGridInstance.getRows();
      return Array.isArray(rows) ? rows : [];
    } catch (_err) {
      return [];
    }
  }

  function getDataGridActiveRowIds() {
    if (!dataGridInstance) return [];
    const rows = getDataGridRowsSafe("active");
    return rows
      .map(row => row?.getData?.()?._rowId)
      .filter(Boolean);
  }

  function syncDataGridRowSelectionUi() {
    if (!dataGridInstance) return;
    const activeIds = new Set(getDataGridActiveRowIds());
    let changed = false;
    for (const id of selectedDataGridRowIds) {
      if (!activeIds.has(id)) {
        selectedDataGridRowIds.delete(id);
        changed = true;
      }
    }
    const rows = getDataGridRowsSafe("visible");
    rows.forEach(applyDataGridRowSelectionState);
    dataPreview?.querySelectorAll<HTMLInputElement>(".data-grid-row-check").forEach(input => {
      const rowId = input.dataset.rowId || "";
      input.checked = selectedDataGridRowIds.has(rowId);
    });
    const allInput = dataPreview?.querySelector<HTMLInputElement>(".data-grid-row-check-all");
    if (allInput) {
      const ids = [...activeIds];
      const selectedCount = ids.filter(id => selectedDataGridRowIds.has(id)).length;
      allInput.checked = ids.length > 0 && selectedCount === ids.length;
      allInput.indeterminate = selectedCount > 0 && selectedCount < ids.length;
    }
    if (changed) updateDataGridSelectionControls();
  }

  function updateDataGridRuntimeState() {
    syncDataGridEmptySelectionState();
    syncDataGridRowSelectionUi();
    syncDataGridCellOverflowActions();
    updateDataGridFilterStatus();
    updateDataGridSelectionControls();
  }

  function syncDataGridCellOverflowActions() {
    const tableEl = dataPreview?.querySelector<HTMLElement>(".data-grid-table");
    if (!tableEl) return;
    tableEl.querySelectorAll<HTMLElement>(".data-grid-cell-content").forEach(content => {
      const textEl = content.querySelector<HTMLElement>(".data-grid-cell-text");
      const forceAction = content.dataset.fullAction === "true";
      const truncated = Boolean(textEl && textEl.scrollWidth > textEl.clientWidth + 1);
      content.classList.toggle("has-action", forceAction || truncated);
    });
  }

  function updateDataGridFilterStatus() {
    const metaEl = dataPreview?.querySelector<HTMLElement>("[data-data-grid-meta]");
    if (!metaEl || !dataGridInstance) return;
    const base = metaEl.dataset.baseText || metaEl.textContent || "";
    const filters = getDataGridHeaderFilters();
    if (!filters.length) {
      metaEl.textContent = base;
      return;
    }
    const activeCount = getDataGridRowsSafe("active").length;
    const totalCount = getDataGridRowsSafe().length || getRows().length;
    metaEl.textContent = t("rowsAfterFiltering", { summary: String(base), matched: String(activeCount), total: String(totalCount) });
  }

  function bindDataGridFilterPopover() {
    const popover = dataPreview?.querySelector<HTMLElement>("[data-data-grid-filter-popover]");
    if (!popover) return;
    popover.querySelector<HTMLInputElement>("[data-data-grid-filter-input]")?.addEventListener("input", handleDataGridFilterInput, { signal: lifecycleSignal });
    popover.querySelector<HTMLInputElement>("[data-data-grid-filter-input]")?.addEventListener("keydown", handleDataGridFilterKeydown, { signal: lifecycleSignal });
    popover.querySelector<HTMLElement>("[data-data-grid-filter-options]")?.addEventListener("change", handleDataGridCategoricalFilterChange, { signal: lifecycleSignal });
    popover.querySelector<HTMLElement>("[data-data-grid-filter-close]")?.addEventListener("click", closeDataGridFilterPopover, { signal: lifecycleSignal });
    popover.querySelector<HTMLElement>("[data-data-grid-filter-clear]")?.addEventListener("click", clearOpenDataGridColumnFilter, { signal: lifecycleSignal });
    dataPreview?.addEventListener("pointerdown", handleDataGridFilterOutsidePointer, { capture: true, signal: lifecycleSignal });
  }

  function openDataGridColumnFilter(field: string, anchorEl: HTMLElement | null = null) {
    if (!field || !dataGridInstance) return;
    const popover = dataPreview?.querySelector<HTMLElement>("[data-data-grid-filter-popover]");
    if (!popover) return;
    dataGridFilterPopoverField = field;
    const input = popover.querySelector<HTMLInputElement>("[data-data-grid-filter-input]");
    const title = popover.querySelector<HTMLElement>("[data-data-grid-filter-title]");
    if (title) title.textContent = t("filterField", { name: String(field) });
    if (input) {
      input.placeholder = t("enterKeywords");
      input.value = dataGridFilterModel.get(field).text;
    }
    renderDataGridFilterMenu(field);
    positionDataGridFilterPopover(popover, anchorEl);
    popover.classList.remove("hidden");
    requestAnimationFrame(() => {
      input?.focus?.({ preventScroll: true });
      input?.select?.();
    });
  }

  function positionDataGridFilterPopover(popover: HTMLElement, anchorEl: HTMLElement | null) {
    const shell = dataPreview?.querySelector<HTMLElement>(".data-grid-shell");
    if (!shell || !anchorEl?.getBoundingClientRect) return;
    const shellRect = shell.getBoundingClientRect();
    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverWidth = 252;
    const left = Math.max(8, Math.min(anchorRect.left - shellRect.left - 12, shellRect.width - popoverWidth - 8));
    const top = Math.max(8, anchorRect.bottom - shellRect.top + 7);
    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function closeDataGridFilterPopover() {
    const popover = dataPreview?.querySelector<HTMLElement>("[data-data-grid-filter-popover]");
    popover?.classList.add("hidden");
    dataGridFilterPopoverField = "";
  }

  function handleDataGridFilterOutsidePointer(event: Event) {
    if (!dataGridFilterPopoverField) return;
    const target = event.target;
    if ((target instanceof Element ? target : null)?.closest<HTMLElement>("[data-data-grid-filter-popover], .data-grid-column-filter-btn")) return;
    closeDataGridFilterPopover();
  }

  function handleDataGridFilterInput(event: Event) {
    const field = dataGridFilterPopoverField;
    if (!field) return;
    const value = String((event.target instanceof HTMLInputElement ? event.target.value : "")).trim();
    dataGridFilterModel.set(field, { text: value });
    applyDataGridColumnFilters();
    renderDataGridFilterMenu(field);
  }

  function handleDataGridCategoricalFilterChange(event: Event) {
    const field = dataGridFilterPopoverField;
    const input = event.target;
    if (!field || !(input instanceof HTMLInputElement) || input.type !== "checkbox") return;
    const filter = dataGridFilterModel.get(field);
    const values = new Set(filter.values);
    if (input.checked) values.add(input.value);
    else values.delete(input.value);
    dataGridFilterModel.set(field, { values: [...values] });
    applyDataGridColumnFilters();
    renderDataGridFilterMenu(field);
  }

  function handleDataGridFilterKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDataGridFilterPopover();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      closeDataGridFilterPopover();
    }
  }

  function clearOpenDataGridColumnFilter() {
    const field = dataGridFilterPopoverField;
    if (!field) return;
    dataGridFilterModel.filters.delete(field);
    const input = dataPreview?.querySelector<HTMLInputElement>("[data-data-grid-filter-input]");
    if (input) input.value = "";
    applyDataGridColumnFilters();
    renderDataGridFilterMenu(field);
    setDataEditStatus(t("filterCleared"), "saved");
  }

  function renderDataGridFilterMenu(field: string) {
    const popover = dataPreview?.querySelector<HTMLElement>("[data-data-grid-filter-popover]");
    if (!popover) return;
    const filter = dataGridFilterModel.get(field);
    const sortLabel = dataGridSortEngine.getProfileLabel(field);
    const summary = popover.querySelector<HTMLElement>("[data-data-grid-filter-summary]");
    const input = popover.querySelector<HTMLInputElement>("[data-data-grid-filter-input]");
    const options = popover.querySelector<HTMLElement>("[data-data-grid-filter-options]");
    if (summary) {
      const selectedCount = filter.values.length;
      const details = [];
      if (filter.text || selectedCount) {
        if (filter.text) details.push(t("filterText", { text: String(filter.text) }));
        if (selectedCount) details.push(t("selected", { count: String(selectedCount) }));
      }
      summary.innerHTML = `
        <span>${escapeHtml(t("sortTypeLabel"))}</span><span class="data-grid-filter-sort-type">${escapeHtml(sortLabel)}</span>
        ${details.length ? `<span> · ${escapeHtml(details.join(" · "))}</span>` : ""}
      `;
    }
    if (input) input.value = filter.text;
    if (options) renderDataGridCategoricalFilterOptions(options, field, filter);
  }

  function renderDataGridCategoricalFilterOptions(container: HTMLElement, field: string, filter: DataGridFilter) {
    const { options, totalUnique, matchedRows } = dataGridFilterModel.getCategoricalOptions(field, filter);
    const selected = new Set(filter.values);
    const shown = options.slice(0, DATA_GRID_CATEGORICAL_OPTION_LIMIT);
    container.classList.remove("hidden");
    container.innerHTML = `
      <div class="data-grid-filter-options-head">
        <span>${escapeHtml(t("commonValues"))}</span>
        <span>${escapeHtml(t("filterOptionSummary", { rows: matchedRows, items: totalUnique }))}</span>
      </div>
      <div class="data-grid-filter-option-list">
        ${shown.length ? shown.map(option => {
          const label = dataGridFilterModel.categoricalValueLabel(option.value);
          return `
            <label class="data-grid-filter-option" title="${escapeHtmlAttribute(label)}">
              <input class="qz-checkbox" type="checkbox" value="${escapeHtmlAttribute(option.value)}" ${selected.has(option.value) ? "checked" : ""}>
              <span class="data-grid-filter-option-label">${escapeHtml(label)}</span>
              <span class="data-grid-filter-option-count">${option.count}</span>
            </label>
          `;
        }).join("") : `<div class="data-grid-filter-option-empty">${escapeHtml(t("noMatchingValues"))}</div>`}
      </div>
      ${totalUnique > shown.length ? `<div class="data-grid-filter-option-more">${escapeHtml(t("showingFirstItems", { count: shown.length }))}</div>` : ""}
    `;
  }

  function applyDataGridColumnFilters() {
    if (!dataGridInstance) return;
    dataGridFilterModel.pruneInactive();
    if (dataGridFilterModel.filters.size) dataGridInstance.setFilter?.(dataGridFilterModel.predicate);
    else dataGridInstance.clearFilter?.();
    renderDataGridFilterActiveStates();
    updateDataGridRuntimeState();
  }

  function renderDataGridFilterActiveStates() {
    if (!dataGridInstance?.getColumns) return;
    dataGridInstance.getColumns().forEach(column => {
      const field = column?.getField?.() || "";
      const active = dataGridFilterModel.filters.has(field);
      column?.getElement?.()?.classList.toggle("data-grid-col-filtered", active);
      column?.getElement?.()?.querySelector<HTMLElement>(".data-grid-column-filter-btn")?.classList.toggle("active", active);
      column?.getElement?.()?.querySelector<HTMLElement>(".data-grid-column-title")?.classList.toggle("is-filtered", active);
    });
  }

  function handleDataGridPaste(event: ClipboardEvent) {
    if (!dataGridInstance || isCurrentImageCollectionTable()) return;
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("input, textarea, .tabulator-editing, .tabulator-header-filter")) return;
    const text = event.clipboardData?.getData?.("text/plain") || "";
    if (!text.trim()) return;
    event.preventDefault();
    const generation = lifecycle.generation;
    pasteTextIntoDataGrid(text).catch(err => {
      if (!lifecycle.isCurrent(generation)) return;
      setDataEditStatus((err instanceof Error ? err.message : t("couldNotPaste")), "error");
    });
  }

  function focusDataGridOnPointerDown(event: Event) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("input, textarea, button, select, [contenteditable='true'], .tabulator-editing, .tabulator-header-filter")) return;
    if ((event.target instanceof Element ? event.target : null)?.closest<HTMLElement>(".tabulator-cell, .tabulator-col")) return;
    event.currentTarget.focus({ preventScroll: true });
  }

  async function pasteTextIntoDataGrid(text: string) {
    const generation = lifecycle.generation;
    const anchor = getCurrentDataRangeAnchorCell();
    if (!anchor) throw new Error(t("selectTheStartingCellBeforePasting"));
    const delimiter = countDelimiter(text, "\t") >= countDelimiter(text, ",") ? "\t" : ",";
    const matrix = parseDelimitedRows(String(text || "").replace(/\s+$/, ""), delimiter)
      .filter(row => row.some(cell => String(cell ?? "").trim() !== ""));
    if (!matrix.length) throw new Error(t("nothingToPaste"));

    const fields = getDataGridEditableFields();
    const rows = getDataGridRowsSafe("active");
    const startField = anchor.getField?.() || "";
    const startRowId = anchor.getRow?.()?.getData?.()?._rowId || "";
    const startCol = fields.indexOf(startField);
    const startRow = rows.findIndex(row => row?.getData?.()?._rowId === startRowId);
    if (startCol < 0 || startRow < 0) throw new Error(t("theStartingCellCannotBeEdited"));

    const updates = new Map<string, { patch: Record<string, unknown>; expectedData: Record<string, unknown> }>();
    let cellCount = 0;
    for (let r = 0; r < matrix.length && startRow + r < rows.length; r += 1) {
      const rowComponent = rows[startRow + r];
      const rowId = rowComponent?.getData?.()?._rowId || "";
      const record = getRows().find(item => item.id === rowId);
      if (!rowId || !record) continue;
      const update = updates.get(rowId) || { patch: {}, expectedData: {} };
      for (let c = 0; c < matrix[r].length && startCol + c < fields.length; c += 1) {
        const field = fields[startCol + c];
        const oldValue = dataFieldValue(record, field);
        const nextValue = parseDataGridEditedValue(matrix[r][c], field, oldValue);
        if (dataValuesEqual(nextValue, oldValue)) continue;
        update.patch[field] = nextValue;
        update.expectedData[field] = oldValue;
        cellCount += 1;
      }
      if (Object.keys(update.patch).length) updates.set(rowId, update);
    }
    if (!updates.size) {
      setDataEditStatus(t("noChanges"), "saved");
      return;
    }

    setDataEditStatus(t("pasting"), "saving", { timeout: 0 });
    for (const [rowId, update] of updates) {
      const updated = await updateDataRow(rowId, update.patch, { expectedData: update.expectedData });
      if (!lifecycle.isCurrent(generation)) continue;
      replaceCurrentDataRow(updated);
      const row = dataGridInstance?.getRow(rowId);
      if (row) await row.update(dataGridRowFromRecord(updated));
    }
    if (lifecycle.isCurrent(generation)) setDataEditStatus(t("pastedCells", { count: String(cellCount) }), "saved");
    refreshDataTablesCacheQuietly();
  }

  function getCurrentDataRangeAnchorCell() {
    return getCurrentDataRangeCells()[0] || null;
  }

  function getCurrentDataRangeCells() {
    const ranges = dataGridInstance?.getRanges?.() || [];
    const range = ranges[ranges.length - 1];
    const rows = range?.getStructuredCells?.() || [];
    const cells = [];
    for (const row of rows) {
      for (const cell of row || []) {
        if (cell?.getField?.()) cells.push(cell);
      }
    }
    return cells;
  }

  function getDataGridEditableFields() {
    if (!dataGridInstance?.getColumns) return [];
    return dataGridInstance.getColumns()
      .map(column => column?.getField?.())
      .filter(isEditableDataColumnName);
  }

  function dataGridTextEditor(cell: GridCell, onRendered: (callback: () => void) => void, success: (value: string) => boolean | void, cancel: () => void) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = formatDataGridCellValue(cell?.getValue?.());
    input.spellcheck = false;
    input.dataset.dataGridEditor = "true";
    input.dataset.dataGridOriginalValue = input.value;
    input.addEventListener("change", () => commitDataGridEditorValue(input, success, cancel), { signal: lifecycleSignal });
    input.addEventListener("blur", () => commitDataGridEditorValue(input, success, cancel), { signal: lifecycleSignal });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.stopPropagation();
        commitDataGridEditorValue(input, success, cancel);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        cancel();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.stopPropagation();
      }
    }, { signal: lifecycleSignal });
    allowNativeDataGridEditorTextSelection(input);
    onRendered(() => {
      input.focus({ preventScroll: true });
    });
    return input;
  }

  function commitDataGridEditorValue(input: HTMLInputElement, success: (value: string) => boolean | void, cancel: () => void) {
    if (!input?.isConnected) return;
    if (input.dataset.dataGridCommitFinished === "true") return;
    input.dataset.dataGridCommitFinished = "true";
    if (input.value === (input.dataset.dataGridOriginalValue ?? "")) {
      cancel();
      return;
    }
    if (success(input.value) === false) cancel();
  }

  function allowNativeDataGridEditorTextSelection(input: HTMLInputElement) {
    const stop = (event: Event) => event.stopPropagation();
    [
      "pointerdown",
      "pointermove",
      "pointerup",
      "mousedown",
      "mousemove",
      "mouseup",
      "click",
      "dblclick",
      "selectstart",
    ].forEach(type => input.addEventListener(type, stop, { signal: lifecycleSignal }));
  }

  function dataGridCellAllowsInlineEdit(cell: GridCell) {
    return !getDataGridExpandableCellContent(cell?.getElement?.());
  }

  function dataGridCellFormatter(cell: GridCell) {
    const value = cell.getValue();
    const text = formatDataGridCellValue(value);
    if (!text) return `<span class="data-grid-cell-empty"></span>`;
    const field = cell?.getField?.() || "";
    const rowId = cell?.getRow?.()?.getData?.()?._rowId || "";
    const classNames = ["data-grid-cell-content"];
    const isLong = shouldOfferDataGridFullCellEditor(text);
    if (isLong) classNames.push("has-action");
    const html = highlightDataCellText(text);
    return `<span class="${classNames.join(" ")}" data-full-action="${isLong ? "true" : "false"}" data-row-id="${escapeHtmlAttribute(rowId)}" data-field="${escapeHtmlAttribute(field)}"><span class="data-grid-cell-text" title="${escapeHtmlAttribute(compactDataGridCellTitle(text))}">${html}</span></span>`;
  }

  function shouldOfferDataGridFullCellEditor(text: string) {
    return Boolean(
      String(text || "").length > DATA_GRID_LONG_CELL_THRESHOLD
      || /[\r\n]/.test(String(text || ""))
    );
  }

  function compactDataGridCellTitle(text: string) {
    const value = String(text || "");
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  function dataGridRowFromRecord(record: Partial<DataRow> | null = {}): GridRecord {
    const row: GridRecord = {
      _rowId: record?.id || "",
      createdAt: record?.createdAt || "",
      updatedAt: record?.updatedAt || "",
    };
    const data = record?.data && typeof record.data === "object" && !Array.isArray(record.data)
      ? record.data
      : {};
    for (const column of getColumns()) {
      if (column === "_rowId" || column === "createdAt" || column === "updatedAt") continue;
      row[column] = data[column];
    }
    for (const [key, value] of Object.entries(data)) {
      if (!(key in row)) row[key] = value;
    }
    return row;
  }

  async function handleDataGridCellEdited(cell: GridCell) {
    const generation = lifecycle.generation;
    const field = cell?.getField?.() || "";
    if (!isEditableDataColumn(field)) {
      cell?.restoreOldValue?.();
      return;
    }
    const rowData = cell.getRow().getData();
    const rowId = rowData?._rowId || "";
    const record = getRows().find(item => item.id === rowId);
    if (!record) {
      cell.restoreOldValue();
      setDataEditStatus(t("rowDoesNotExist"), "error");
      return;
    }

    const oldValue = dataFieldValue(record, field);
    let nextValue;
    try {
      nextValue = parseDataGridEditedValue(cell.getValue(), field, oldValue);
    } catch (err) {
      cell.restoreOldValue();
      setDataEditStatus((err instanceof Error ? err.message : t("invalidValueFormat")), "error");
      return;
    }
    if (dataValuesEqual(nextValue, oldValue)) return;

    setDataEditStatus("", "", { timeout: 0 });
    try {
      const updated = await updateDataRow(rowId, { [field]: nextValue }, { expectedData: { [field]: oldValue } });
      refreshDataTablesCacheQuietly();
      if (!lifecycle.isCurrent(generation)) return;
      replaceCurrentDataRow(updated);
      cell.getRow().update(dataGridRowFromRecord(updated));
      pulseDataGridSavedCell(cell);
      setDataEditStatus(t("saved"), "saved");
    } catch (err) {
      if (!lifecycle.isCurrent(generation)) return;
      cell.restoreOldValue();
      setDataEditStatus((err instanceof Error ? err.message : t("couldNotSave")), "error");
    }
  }

  function pulseDataGridSavedCell(cell: GridCell) {
    const row = cell?.getRow?.();
    const field = cell?.getField?.() || "";
    const firstEl = applyDataGridSavedCellPulse((row?.getCell(field) || undefined)?.getElement() || cell?.getElement?.());
    requestAnimationFrame(() => {
      const nextEl = (row?.getCell(field) || undefined)?.getElement();
      if (nextEl && nextEl !== firstEl) applyDataGridSavedCellPulse(nextEl);
    });
  }

  function pulseDataGridSavedCellById(rowId: string, field: string) {
    const row = dataGridInstance?.getRow?.(rowId);
    const cell = row && row.getCell(field);
    if (cell) pulseDataGridSavedCell(cell);
  }

  function applyDataGridSavedCellPulse(cellEl: HTMLElement | null | undefined) {
    if (!cellEl) return null;
    cellEl.classList.remove("data-grid-cell-save-pulse");
    void cellEl.offsetWidth;
    cellEl.classList.add("data-grid-cell-save-pulse");
    const cleanup = () => cellEl.classList.remove("data-grid-cell-save-pulse");
    cellEl.addEventListener("animationend", cleanup, { once: true, signal: lifecycleSignal });
    setTimeout(cleanup, 620);
    return cellEl;
  }

  function parseDataGridEditedValue(value: unknown, _column?: string, _oldValue?: unknown) {
    return typeof value === "string" ? value : String(value ?? "");
  }

  function formatDataGridCellValue(value: unknown) {
    if (value == null) return "";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (_err) {
        return String(value);
      }
    }
    return String(value);
  }

  function dataValuesEqual(a: unknown, b: unknown) {
    if (Object.is(a, b)) return true;
    if (isBlankDataCellValue(a) && isBlankDataCellValue(b)) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (_err) {}
    }
    return false;
  }

  function isBlankDataCellValue(value: unknown) {
    return value == null || value === "";
  }


  function getDataGridHeaderFilters() {
    return [...dataGridFilterModel.filters.entries()]
      .map(([field, value]): [string, DataGridFilter] => [field, dataGridFilterModel.normalize(value)])
      .filter(([, value]) => dataGridFilterModel.isActive(value))
      .map(([field, value]) => ({ field, value }));
  }

  function clearDataGridFilters({ apply = false } = {}) {
    dataGridFilterModel.filters.clear();
    closeDataGridFilterPopover();
    if (apply) applyDataGridColumnFilters();
  }

  function clearDataGridSelection() {
    selectedDataGridRowIds.clear();
    syncDataGridRowSelectionUi();
    updateDataGridSelectionControls();
  }

  function setSelectedRowIds(ids: string[] = [], { sync = true } = {}) {
    selectedDataGridRowIds = new Set((ids || []).map(String).filter(Boolean));
    if (sync) {
      syncDataGridRowSelectionUi();
      updateDataGridSelectionControls();
    }
  }

  function resetTableState(tableName: string) {
    dataGridSortStateByTable.delete(String(tableName || "").trim());
  }

  function getColumnComponents() {
    try {
      return dataGridInstance?.getColumns?.() || [];
    } catch (_error) {
      return [];
    }
  }

  function scrollToRow(rowId: string, position = "top", ifVisible = false) {
    return dataGridInstance?.scrollToRow?.(rowId, position, ifVisible);
  }

  function updateRowById(rowId: string, record: DataRow | null) {
    const row = dataGridInstance?.getRow(rowId);
    return row ? row.update(dataGridRowFromRecord(record)) : undefined;
  }

  return {
    render: renderDataGrid,
    resumeAfterTabShow: resumeDataGridAfterTabShow,
    suspend: () => { pendingRender += 1; },
    destroy: destroyDataGrid,
    hasInstance: () => Boolean(dataGridInstance),
    getColumnComponents,
    getSortProfileLabel: dataGridSortEngine.getProfileLabel,
    clampWidthGrow: dataGridSortEngine.clampWidthGrow,
    applyColumnOrderFast: applyDataGridColumnOrderFast,
    closeFilterPopover: closeDataGridFilterPopover,
    clearFilterState: () => clearDataGridFilters({ apply: false }),
    clearFilters: () => clearDataGridFilters({ apply: true }),
    getHeaderFilters: getDataGridHeaderFilters,
    clearSelection: clearDataGridSelection,
    getSelectedRowIds: () => [...selectedDataGridRowIds],
    setSelectedRowIds,
    scrollToRow,
    updateRowById,
    resetTableState,
    rememberSortState: rememberDataGridSortState,
    restoreSortState: restoreDataGridSortState,
    syncRangeOverlay: syncDataGridRangeOverlay,
    syncRowSelectionUi: syncDataGridRowSelectionUi,
    updateRuntimeState: updateDataGridRuntimeState,
    rowFromRecord: dataGridRowFromRecord,
    parseEditedValue: parseDataGridEditedValue,
    formatCellValue: formatDataGridCellValue,
    valuesEqual: dataValuesEqual,
    pulseSavedCellById: pulseDataGridSavedCellById,
    getLifecycleSnapshot: lifecycle.snapshot,
  };
}
