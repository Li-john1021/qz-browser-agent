import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { getLocale } from "#sdk/shared/i18n";
import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { loadExcel } from "./data-excel.js";
import {
  clearDataTable,
  deleteDataRows,
  inferColumns,
  insertDataRows,
  listDataTables,
  queryDataRows,
  updateDataRow,
  upsertDataRows,
  type DataRow, type DataTable,
} from "#sdk/shared/data";
import { nowBeijingDateTime } from "#sdk/shared/format";
import { escapeHtml, safeFilename } from "#sdk/sidepanel/dom";
import { createDataGridAdapter } from "./data-grid-adapter.js";
import { createDataGridColumns, DATA_COLUMNS_HIDDEN_BY_DEFAULT, type DataGridColumnState } from "./data-grid-columns.js";
import { createDataImageCollection } from "./data-image-collection.js";
import { createDataGridEditors } from "./data-grid-editors.js";
import {
  downloadDisplayName,
  inferImportMime,
  isImportableFilename,
  parseImportFile,
  parseImportText,
  tableNameFromFilename,
} from "./data-import-parser.js";

interface DataFeatureOptions extends Pick<Parameters<typeof createDataGridAdapter>[0], "isActive" | "startTrace" | "gridTrace"> {
  signal?: AbortSignal;
  root?: Document | HTMLElement; initialTable?: string | null;
  showToast?: UiExtensionAPI["showToast"];
  hideToast?: UiExtensionAPI["hideToast"];
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
  requestText?: UiExtensionAPI["dialogs"]["requestText"];
  showArtifactToast?(message: string, anchor: HTMLElement | null): void;
  beforeOpenArtifactTable?(): void; onStableViewChange?(): void;
}

export function createDataFeature(options: DataFeatureOptions = {}) {
  const lifetime = new AbortController();
  const lifecycleSignal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  lifecycleSignal?.throwIfAborted();
  const root = options.root || document;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  let disposed = false;
  const isActive = () => !disposed && (options.isActive?.() ?? false);
  const startTrace = options.startTrace || (() => () => {});
  const gridTrace = options.gridTrace || (() => {});
  const showToast = options.showToast || (() => {});
  const hideToast = options.hideToast || (() => {});
  const confirmAction = options.confirm || (async () => false);
  const requestText = options.requestText || (async () => null);

  const dataPanel = $("#data-panel");
  const dataTablesList = $("#data-tables-list");
  const dataTableSearch = $<HTMLInputElement>("#data-table-search");
  const dataEmpty = $("#data-empty")!;
  const dataLoading = $("#data-loading");
  const dataDetail = $("#data-detail")!;
  const dataPreview = $("#data-preview")!;
  const btnImportData = $<HTMLButtonElement>("#btn-import-data");
  const btnDataTableActions = $<HTMLButtonElement>("#btn-data-table-actions");
  const dataTableActionsMenu = $("#data-table-actions-menu");
  const btnExportData = $<HTMLButtonElement>("#btn-export-data");
  const btnDeleteData = $<HTMLButtonElement>("#btn-delete-data");
  const dataSearch = $<HTMLInputElement>("#data-search");
  const dataGridActions = $("#data-grid-actions");
  const btnClearDataFilters = $<HTMLButtonElement>("#btn-clear-data-filters");
  const btnAddDataRow = $<HTMLButtonElement>("#btn-add-data-row");
  const btnDeleteDataRows = $<HTMLButtonElement>("#btn-delete-data-rows");
  const btnDataColumns = $<HTMLButtonElement>("#btn-data-columns");
  const dataColumnsMenu = $("#data-columns-menu");
  const dataImageSelectionActions = $("#data-image-selection-actions");
  const dataImageSelectionCount = $("#data-image-selection-count");
  const btnSelectVisibleImages = $<HTMLButtonElement>("#btn-select-visible-images");
  const btnClearImageSelection = $<HTMLButtonElement>("#btn-clear-image-selection");
  const btnDeleteSelectedImages = $<HTMLButtonElement>("#btn-delete-selected-images");
  const dataImportPanel = $("#data-import-panel");
  const btnCloseDataImport = $<HTMLButtonElement>("#btn-close-data-import");
  const dataImportTable = $<HTMLInputElement>("#data-import-table");
  const dataImportKey = $<HTMLInputElement>("#data-import-key");
  const btnDataImportFile = $<HTMLButtonElement>("#btn-data-import-file");
  const dataImportFile = $<HTMLInputElement>("#data-import-file");
  const dataImportFileName = $("#data-import-file-name");
  const dataImportText = $<HTMLTextAreaElement>("#data-import-text");
  const btnImportText = $<HTMLButtonElement>("#btn-import-text");
  const btnLoadDownloads = $<HTMLButtonElement>("#btn-load-downloads");
  const dataImportStatus = $("#data-import-status");
  const dataRecentDownloads = $("#data-recent-downloads");
  const dataRowDetail = $("#data-row-detail");
  const dataRowDetailTitle = $("#data-row-detail-title");
  const dataRowDetailMeta = $("#data-row-detail-meta");
  const dataRowDetailTable = $("#data-row-detail-table");
  const btnCopyRowDetail = $<HTMLButtonElement>("#btn-copy-row-detail");
  const btnCloseRowDetail = $<HTMLButtonElement>("#btn-close-row-detail");


  let currentDataTable = String(options.initialTable || "").trim() || null;
  let currentDataTableMeta: DataGridColumnState["currentDataTableMeta"] = null;
  let dataTablesCache: DataTable[] = [];
  let dataTablesLoaded = false;
  let dataTablesLoadPromise: Promise<void> | null = null;
  let dataTablesLastLoadedAt = 0;
  let dataTablesLoadSeq = 0;
  let dataViewLoadSeq = 0;
  let dataImportSeq = 0;
  let dataLoadingOwnerSeq = 0;
  let dataLoadingDepth = 0;
  let dataLoadingTimer = 0;
  let dataRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let currentDataRows: DataRow[] = [];
  let currentDataColumns: string[] = [];
  let dataTableSearchQuery = "";
  let dataTablePickerOpen = false;
  let dataSearchQuery = "";
  let dataSortColumn = "";
  let dataSortDir: "asc" | "desc" = "asc";
  let dataGridAdapter: ReturnType<typeof createDataGridAdapter>;
  let dataImageCollection: ReturnType<typeof createDataImageCollection>;
  let recentDownloadImportItems: chrome.downloads.DownloadItem[] = [];


  const DATA_PREVIEW_LOAD_LIMIT = 100000;
  const DATA_PREVIEW_RENDER_LIMIT = 300;
  const DATA_GRID_MIN_TABLE_HEIGHT = 220;
  const DATA_GRID_MIN_COLUMN_WIDTH = 96;
  const DATA_GRID_COLUMN_WIDTH_SAMPLE_ROWS = 10;
  const DATA_GRID_LONG_CELL_THRESHOLD = 72;
  const DATA_GRID_CATEGORICAL_OPTION_LIMIT = 80;
  const DATA_GRID_SORT_SAMPLE_LIMIT = 100;
  const DATA_GRID_SORT_MIN_PARSE_RATIO = 0.85;
  const DATA_TABLES_CACHE_TTL_MS = 5000;
  const DATA_LOADING_DELAY_MS = 120;
  const dataColumns = createDataGridColumns({
    signal: lifecycleSignal,
    root,
    button: btnDataColumns,
    menu: dataColumnsMenu,
    state: {
      get currentDataTable() { return currentDataTable; },
      get currentDataTableMeta() { return currentDataTableMeta; },
      set currentDataTableMeta(value) { currentDataTableMeta = value; },
      get currentDataRows() { return currentDataRows; },
      get currentDataColumns() { return currentDataColumns; },
      set currentDataColumns(value) { currentDataColumns = value; },
      get dataTablesCache() { return dataTablesCache; },
    },
    gridTrace,
    getViewRevision: () => dataViewLoadSeq,
    getGridAdapter: () => dataGridAdapter,
    isCurrentImageCollectionTable,
    updateDataCollectionControls: () => dataImageCollection?.updateControls(),
    renderCurrentDataTable,
    setDataEditStatus,
    showDataTable,
    refreshDataTablesCache,
    getDataTableColumnOrder,
    confirm: confirmAction,
    requestText,
  });
  dataImageCollection = createDataImageCollection({
    signal: lifecycleSignal,
    preview: dataPreview,
    detail: dataDetail,
    columnsButton: btnDataColumns,
    gridActions: dataGridActions,
    searchInput: dataSearch,
    selectionActions: dataImageSelectionActions,
    selectionCount: dataImageSelectionCount,
    selectVisibleButton: btnSelectVisibleImages,
    clearSelectionButton: btnClearImageSelection,
    deleteSelectionButton: btnDeleteSelectedImages,
    getCurrentTable: () => currentDataTable,
    getRows: () => currentDataRows,
    deriveVisibleDataRows,
    renderCurrentDataTable,
    isCurrentImageCollectionTable,
    isImageCollectionTable,
    closeDataColumnsMenu: dataColumns.closeMenu,
    updateDataGridSelectionControls,
    setDataActionButtonLabel,
    loadDataTables,
    getDataTableExportColumns,
    dataFieldValue,
    safeExcelSheetName,
    previewRenderLimit: DATA_PREVIEW_RENDER_LIMIT,
    confirm: confirmAction,
    showToast,
  });


  const dataGridEditors = createDataGridEditors({
    signal: lifecycleSignal,
    root,
    panel: dataRowDetail,
    titleEl: dataRowDetailTitle,
    metaEl: dataRowDetailMeta,
    tableEl: dataRowDetailTable,
    primaryButton: btnCopyRowDetail,
    getRows: () => currentDataRows,
    getColumns: () => currentDataColumns,
    getCurrentTable: () => currentDataTable,
    hiddenColumns: DATA_COLUMNS_HIDDEN_BY_DEFAULT,
    dataFieldValue,
    isEditableColumn: dataColumns.isEditableColumn,
    parseEditedValue: (...args) => dataGridAdapter?.parseEditedValue(...args),
    valuesEqual: (...args) => dataGridAdapter.valuesEqual(...args),
    replaceCurrentRow: replaceCurrentDataRow,
    updateGridRow: (rowId, record) => dataGridAdapter?.updateRowById(rowId, record),
    pulseSavedCell: (rowId, field) => dataGridAdapter?.pulseSavedCellById(rowId, field),
    setEditStatus: setDataEditStatus,
    refreshTablesQuietly: refreshDataTablesCacheQuietly,
    normalizeOpenableLinkUrl,
  });
  dataGridAdapter = createDataGridAdapter({
    signal: lifecycleSignal,
    dataPreview,
    isActive,
    startTrace,
    gridTrace,
    getCurrentTable: () => currentDataTable,
    getRows: () => currentDataRows,
    getColumns: () => currentDataColumns,
    getVisibleColumns: () => dataColumns.getVisibleColumns(),
    getDataColumnMeta: dataColumns.getColumnMeta,
    formatDataCell,
    openDataCellEditor: dataGridEditors.openCell,
    closeCurrentDataCellEditor: dataGridEditors.closeCell,
    isEditableDataColumn: dataColumns.isEditableColumn,
    isEditableDataColumnName: dataColumns.isEditableColumnName,
    isCurrentImageCollectionTable,
    updateDataGridSelectionControls,
    dataFieldValue,
    highlightDataCellText,
    replaceCurrentDataRow,
    setDataEditStatus,
    refreshDataTablesCacheQuietly,
    updateDataRow,
    persistDataGridColumnOrder: dataColumns.persistGridColumnOrder,
    persistDataGridColumnLayout: dataColumns.persistGridColumnLayout,
    renderCurrentDataTable,
    normalizeDataUserColumnOrder: dataColumns.normalizeUserColumnOrder,
    normalizeDataColumnPrompt: dataColumns.normalizeColumnPrompt,
    setLegacySortState(column, direction) {
      dataSortColumn = column;
      dataSortDir = direction === "desc" ? "desc" : "asc";
    },
    minTableHeight: DATA_GRID_MIN_TABLE_HEIGHT,
    minColumnWidth: DATA_GRID_MIN_COLUMN_WIDTH,
    widthSampleRows: DATA_GRID_COLUMN_WIDTH_SAMPLE_ROWS,
    longCellThreshold: DATA_GRID_LONG_CELL_THRESHOLD,
    categoricalOptionLimit: DATA_GRID_CATEGORICAL_OPTION_LIMIT,
    sortSampleLimit: DATA_GRID_SORT_SAMPLE_LIMIT,
    sortMinParseRatio: DATA_GRID_SORT_MIN_PARSE_RATIO,
  });



  btnImportData?.addEventListener("click", openDataImportPanel, { signal: lifecycleSignal });
  btnDataTableActions?.addEventListener("click", () => {
    const open = dataTableActionsMenu?.classList.contains("hidden");
    setDataTableActionsMenuOpen(open, { restoreFocus: false });
    if (open) requestAnimationFrame(() => dataTableActionsMenu?.querySelector<HTMLElement>(".qz-menu-item")?.focus({ preventScroll: true }));
  }, { signal: lifecycleSignal });
  dataTableActionsMenu?.addEventListener("click", (event) => {
    if ((event.target instanceof Element ? event.target : null)?.closest(".qz-menu-item")) setDataTableActionsMenuOpen(false, { restoreFocus: false });
  }, { signal: lifecycleSignal });
  dataTableActionsMenu?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setDataTableActionsMenuOpen(false);
  }, { signal: lifecycleSignal });
  btnExportData?.addEventListener("click", exportCurrentDataTable, { signal: lifecycleSignal });
  btnDeleteData?.addEventListener("click", () => deleteDataTable(currentDataTable), { signal: lifecycleSignal });
  btnClearDataFilters?.addEventListener("click", clearCurrentDataGridFilters, { signal: lifecycleSignal });
  btnAddDataRow?.addEventListener("click", addCurrentDataRow, { signal: lifecycleSignal });
  btnDeleteDataRows?.addEventListener("click", deleteSelectedDataRows, { signal: lifecycleSignal });
  dataTableSearch?.addEventListener("input", () => {
    dataTableSearchQuery = dataTableSearch.value.trim().toLowerCase();
    openDataTablePicker();
    renderDataTables(dataTablesCache);
  }, { signal: lifecycleSignal });
  dataTableSearch?.addEventListener("focus", () => {
    openDataTablePicker();
    renderDataTables(dataTablesCache);
    requestAnimationFrame(() => dataTableSearch.select());
  }, { signal: lifecycleSignal });
  dataTableSearch?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDataTablePicker();
      dataTableSearch.blur();
    }
  }, { signal: lifecycleSignal });
  dataSearch?.addEventListener("input", () => {
    dataSearchQuery = dataSearch.value.trim().toLowerCase();
    renderCurrentDataTable();
  }, { signal: lifecycleSignal });
  btnCloseDataImport?.addEventListener("click", closeDataImportPanel, { signal: lifecycleSignal });
  btnDataImportFile?.addEventListener("click", () => {
    if (!dataImportFile) return;
    dataImportFile.value = "";
    dataImportFile.click();
  }, { signal: lifecycleSignal });
  dataImportFile?.addEventListener("change", async () => {
    const file = dataImportFile.files?.[0];
    syncDataImportFileState(file);
    if (!file) return;
    if (btnDataImportFile) btnDataImportFile.disabled = true;
    try {
      await importDataFile(file);
    } finally {
      if (!disposed) {
        dataImportFile.value = "";
        if (btnDataImportFile) btnDataImportFile.disabled = false;
      }
    }
  }, { signal: lifecycleSignal });
  btnImportText?.addEventListener("click", importPastedData, { signal: lifecycleSignal });
  btnLoadDownloads?.addEventListener("click", loadRecentDownloadImports, { signal: lifecycleSignal });
  btnCopyRowDetail?.addEventListener("click", dataGridEditors.handlePrimaryAction, { signal: lifecycleSignal });
  btnCloseRowDetail?.addEventListener("click", dataGridEditors.close, { signal: lifecycleSignal });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (dataTablePickerOpen && target instanceof Element && !target.closest(".data-table-picker")) {
      closeDataTablePicker();
    }
    if (
      target instanceof Node
      && isElementVisible(dataTableActionsMenu)
      && !btnDataTableActions?.contains(target)
      && !dataTableActionsMenu?.contains(target)
    ) setDataTableActionsMenuOpen(false, { restoreFocus: false });
  }, { signal: lifecycleSignal });



  function activate({ showLoading = false } = {}) {
    if (disposed) return Promise.resolve();
    if (showLoading) {
      if (dataTableSearch && currentDataTable) dataTableSearch.value = currentDataTable;
      dataEmpty?.classList.add("hidden");
      dataDetail?.classList.add("hidden");
      dataLoading?.classList.remove("hidden");
    }
    dataGridAdapter.resumeAfterTabShow();
    return loadDataTables({ preferCache: true }).catch(error => {
      if (showLoading && !disposed) {
        dataEmpty?.classList.remove("hidden");
        dataDetail?.classList.add("hidden");
        setDataEditStatus((error instanceof Error ? error.message : t("couldNotLoadDataTryAgainLater")), "error");
      }
      throw error;
    });
  }

  function deactivate() {
    dataGridAdapter.suspend();
    dataImportSeq += 1;
    setDataTableActionsMenuOpen(false, { restoreFocus: false });
    dataGridEditors.close();
  }

  function invalidate() {
    dataTablesLastLoadedAt = 0;
    if (isActive()) scheduleDataTablesRefresh();
    else dataTablesLoaded = false;
  }

  function closeTopmostTransientUi() {
    if (isElementVisible(dataTableActionsMenu)) {
      setDataTableActionsMenuOpen(false);
      return true;
    }
    if (isElementVisible(dataImportPanel)) {
      closeDataImportPanel();
      return true;
    }
    if (isElementVisible(dataRowDetail)) {
      dataGridEditors.close();
      return true;
    }
    if (dataTablePickerOpen) {
      closeDataTablePicker();
      return true;
    }
    if (isElementVisible(dataColumnsMenu)) {
      dataColumns.closeMenu();
      return true;
    }
    return false;
  }

  function hasBlockingOverlay() {
    return isElementVisible(dataImportPanel) || isElementVisible(dataRowDetail);
  }

  function setDataTableActionsMenuOpen(open: boolean | undefined, { restoreFocus = true } = {}) {
    const next = Boolean(open && dataTableActionsMenu && btnDataTableActions);
    dataTableActionsMenu?.classList.toggle("hidden", !next);
    btnDataTableActions?.setAttribute("aria-expanded", String(next));
    if (!next && restoreFocus) btnDataTableActions?.focus({ preventScroll: true });
  }

  async function openArtifactTable(tableName = "", { anchorEl = null }: { anchorEl?: HTMLElement | null } = {}) {
    const table = String(tableName || "").trim();
    if (disposed || !table) return false;
    try {
      dataTablesCache = await listDataTables();
      if (disposed) return false;
    } catch (_error) {
      if (!disposed) options.showArtifactToast?.(t("couldNotCheckTheTableStatusTryAgainLater"), anchorEl);
      return false;
    }
    renderDataTables(dataTablesCache);
    if (!dataTablesCache.some(item => item.name === table)) {
      if (!disposed) options.showArtifactToast?.(t("tableWasDeletedOrIsCurrentlyUnavailable", { name: String(table) }), anchorEl);
      return false;
    }
    options.beforeOpenArtifactTable?.();
    selectCurrentDataTable(table);
    try {
      await showDataTable(table, { resetView: true });
      return true;
    } catch (_error) {
      if (!disposed) options.showArtifactToast?.(t("tableCannotBeOpenedRightNow", { name: String(table) }), anchorEl);
      return false;
    }
  }

  function setDataActionButtonLabel(button: HTMLElement | null, label: string) {
    if (!button) return;
    const labelEl = button.querySelector<HTMLElement>("[data-data-action-label]");
    if (labelEl) labelEl.textContent = label;
    else button.textContent = label;
  }

  function beginDataLoading({ preserveContent = false, ownerSeq = dataViewLoadSeq } = {}) {
    if (ownerSeq !== dataLoadingOwnerSeq) {
      dataLoadingOwnerSeq = ownerSeq;
      dataLoadingDepth = 0;
      if (dataLoadingTimer) {
        clearTimeout(dataLoadingTimer);
        dataLoadingTimer = 0;
      }
    }
    dataLoadingDepth += 1;
    if (dataLoadingDepth === 1) {
      dataLoadingTimer = setTimeout(() => {
        dataLoadingTimer = 0;
        if (ownerSeq !== dataLoadingOwnerSeq || !dataLoadingDepth || !isActive()) return;
        if (preserveContent && hasCurrentDataView()) return;
        dataEmpty?.classList.add("hidden");
        dataDetail?.classList.add("hidden");
        dataLoading?.classList.remove("hidden");
      }, DATA_LOADING_DELAY_MS);
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (ownerSeq !== dataLoadingOwnerSeq) return;
      dataLoadingDepth = Math.max(0, dataLoadingDepth - 1);
      if (dataLoadingDepth > 0) return;
      if (dataLoadingTimer) {
        clearTimeout(dataLoadingTimer);
        dataLoadingTimer = 0;
      }
      dataLoading?.classList.add("hidden");
    };
  }

  function hasCurrentDataView(tableName = currentDataTable) {
    return Boolean(
      tableName
      && tableName === currentDataTable
      && dataDetail
      && !dataDetail.classList.contains("hidden")
      && dataPreview?.firstElementChild
    );
  }

  async function loadDataTables({ force = false, preferCache = false } = {}): Promise<void> {
    if (disposed) return;
    const endTrace = startTrace("load_tables", {
      force: Boolean(force),
      preferCache: Boolean(preferCache),
      cacheLoaded: Boolean(dataTablesLoaded),
    });
    if (dataRefreshTimer) {
      clearTimeout(dataRefreshTimer);
      dataRefreshTimer = null;
    }
    if (!force && dataTablesLoadPromise) {
      endTrace({ path: "reuse_inflight" });
      return dataTablesLoadPromise;
    }
    if (!force && preferCache && dataTablesLoaded) {
      renderDataTables(dataTablesCache);
      if (currentDataTable) {
        dataEmpty.classList.add("hidden");
        dataDetail.classList.remove("hidden");
        if (dataTableSearch && !dataTablePickerOpen) dataTableSearch.value = currentDataTable;
        dataColumns.renderMenu();
      }
      scheduleDataTablesBackgroundRefresh();
      endTrace({ path: "cache", tables: dataTablesCache.length, table: currentDataTable || "" });
      return;
    }

    const seq = ++dataTablesLoadSeq;
    const viewSeq = ++dataViewLoadSeq;
    const endLoading = beginDataLoading({ preserveContent: hasCurrentDataView(), ownerSeq: viewSeq });
    const promise = (async () => {
      try {
        const listEndTrace = startTrace("load_tables.list");
        const tables = await listDataTables();
        listEndTrace({ tables: tables.length });
        if (seq !== dataTablesLoadSeq) {
          endTrace({ path: "fresh", stale: true, tables: tables.length });
          return;
        }
        dataTablesCache = tables;
        dataTablesLoaded = true;
        dataTablesLastLoadedAt = Date.now();
        renderDataTables(dataTablesCache);
        if (viewSeq !== dataViewLoadSeq) {
          endTrace({ path: "fresh", stale: true, tables: tables.length });
          return;
        }

        if (currentDataTable && dataTablesCache.some(table => table.name === currentDataTable)) {
          await showDataTable(currentDataTable, {}, viewSeq);
        } else if (dataTablesCache.length > 0) {
          await showDataTable(dataTablesCache[0].name, {}, viewSeq);
        } else {
          selectCurrentDataTable(null);
          currentDataTableMeta = null;
          currentDataRows = [];
          currentDataColumns = [];
          dataColumns.clearVisibleColumns();
          dataGridAdapter.destroy();
          if (dataTableSearch) dataTableSearch.value = "";
          dataGridEditors.close();
          dataEmpty.classList.remove("hidden");
          dataDetail.classList.add("hidden");
          options.onStableViewChange?.();
        }
        endTrace({ path: "fresh", tables: dataTablesCache.length, table: currentDataTable || "" });
      } catch (err) {
        endTrace({ path: "fresh", error: (err instanceof Error ? err.message : String(err)) });
        throw err;
      } finally {
        endLoading();
      }
    })();
    dataTablesLoadPromise = promise;
    try {
      await promise;
    } finally {
      if (dataTablesLoadPromise === promise) dataTablesLoadPromise = null;
    }
  }

  function scheduleDataTablesRefresh() {
    if (dataRefreshTimer) clearTimeout(dataRefreshTimer);
    dataRefreshTimer = setTimeout(() => {
      dataRefreshTimer = null;
      loadDataTables({ force: true });
    }, 250);
  }

  function scheduleDataTablesBackgroundRefresh() {
    if (dataTablesLoadPromise || Date.now() - dataTablesLastLoadedAt < DATA_TABLES_CACHE_TTL_MS) return;
    setTimeout(() => {
      if (!isActive() || dataTablesLoadPromise) return;
      loadDataTables({ force: true }).catch(err => {
        console.warn("[轻舟数据] background refresh failed", err);
      });
    }, 0);
  }

  function renderDataTables(tables: DataTable[]) {
    if (disposed) return;
    if (!dataTablesList) return;
    dataTablesList.classList.toggle("hidden", !dataTablePickerOpen);
    if (!tables.length) {
      dataTablesList.innerHTML = `<div class="data-table-empty">${escapeHtml(t("noData"))}</div>`;
      return;
    }

    const filteredTables = filterDataTables(tables);
    if (!filteredTables.length) {
      dataTablesList.innerHTML = `<div class="data-table-empty">${escapeHtml(t("noMatchingTables"))}</div>`;
      return;
    }

    dataTablesList.innerHTML = filteredTables.map(table => `
      <div class="qz-menu-item data-table-item ${table.name === currentDataTable ? "active" : ""} ${isImageCollectionTable(table) ? "image-collection" : ""}" data-table="${escapeHtmlAttribute(table.name)}" title="${escapeHtmlAttribute(table.name)}">
        <button class="data-table-select" data-table="${escapeHtmlAttribute(table.name)}" title="${escapeHtmlAttribute(table.name)}">
          <span class="data-table-name" title="${escapeHtmlAttribute(table.name)}">${escapeHtml(table.name)}</span>
          <span class="data-table-meta">${isImageCollectionTable(table) ? t("imageCollection") : ""}${escapeHtml(t(isImageCollectionTable(table) ? "imageCount" : "rowCount", { count: Number(table.count || 0) }))} · ${escapeHtml(formatDataTableDate(table.createdAt))}</span>
        </button>
        <button class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger data-table-delete" data-table="${escapeHtmlAttribute(table.name)}" title="${escapeHtmlAttribute(t("deleteTable"))}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
      </div>
    `).join("");

    dataTablesList.querySelectorAll<HTMLElement>(".data-table-select").forEach(item => {
      item.addEventListener("click", () => {
        showDataTable(item.dataset.table || "");
        closeDataTablePicker();
      }, { signal: lifecycleSignal });
    });
    dataTablesList.querySelectorAll<HTMLElement>(".data-table-delete").forEach(btn => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteDataTable(btn.dataset.table || "");
      }, { signal: lifecycleSignal });
    });
    scrollActiveDataTableIntoView();
  }

  function filterDataTables(tables: DataTable[]) {
    const query = dataTableSearchQuery;
    if (!query) return tables;
    return tables.filter(table => {
      const haystack = [
        table.name,
        table.count,
        isImageCollectionTable(table) ? "图集 image collection images" : "",
        table.createdAt,
        formatDataTableDate(table.createdAt),
      ].map(value => String(value || "").toLowerCase()).join(" ");
      return haystack.includes(query);
    });
  }

  function formatDataTableDate(value: unknown) {
    const text = String(value || "").trim();
    if (!text) return t("unknown");
    const datePart = text.split(/\s+/)[0];
    return datePart || text;
  }

  function scrollActiveDataTableIntoView() {
    const active = dataTablesList?.querySelector<HTMLElement>(".data-table-item.active");
    if (!active) return;
    requestAnimationFrame(() => {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  }

  function openDataTablePicker() {
    dataTablePickerOpen = true;
    dataTablesList?.classList.remove("hidden");
  }

  function closeDataTablePicker() {
    dataTablePickerOpen = false;
    dataTableSearchQuery = "";
    if (dataTableSearch) dataTableSearch.value = currentDataTable || "";
    dataTablesList?.classList.add("hidden");
  }

  async function showDataTable(
    tableName: string,
    { resetView = false, revealColumns = [] }: { resetView?: boolean; revealColumns?: string[] } = {},
    viewSeq = ++dataViewLoadSeq,
  ) {
    if (disposed) return;
    const endTrace = startTrace("show_table", {
      table: String(tableName || ""),
      resetView: Boolean(resetView),
    });
    const changedTable = currentDataTable !== tableName || resetView;
    if (resetView) dataGridAdapter.resetTableState(tableName);
    const columnsToReveal = new Set((revealColumns || [])
      .map(column => dataColumns.normalizeColumnPrompt(column))
      .filter(Boolean));
    selectCurrentDataTable(tableName);
    currentDataTableMeta = getDataTableMeta(tableName);
    dataGridEditors.close();
    if (changedTable) dataImageCollection.clearObjectUrls();
    renderDataTables(dataTablesCache);

    const endLoading = beginDataLoading({
      preserveContent: !changedTable && hasCurrentDataView(tableName),
      ownerSeq: viewSeq,
    });
    try {
      const queryEndTrace = startTrace("show_table.query_rows", { table: String(tableName || "") });
      const result = await queryDataRows({ table: tableName, limit: DATA_PREVIEW_LOAD_LIMIT });
      queryEndTrace({ rows: result.rows?.length || 0, totalMatched: result.totalMatched });
      if (viewSeq !== dataViewLoadSeq || currentDataTable !== tableName) {
        endTrace({ stale: true });
        return;
      }
      currentDataRows = result.rows;
      currentDataColumns = inferColumns(result.rows, dataColumns.getCurrentTableColumnOrder());
      if (changedTable) {
        dataSearchQuery = "";
        dataGridAdapter.restoreSortState(tableName, currentDataColumns);
        dataGridAdapter.clearSelection();
        dataGridAdapter.clearFilterState();
        dataGridAdapter.closeFilterPopover();
        dataImageCollection.resetForTable();
        if (dataSearch) dataSearch.value = "";
        dataColumns.resetForTable(currentDataColumns);
      } else {
        dataColumns.reconcileVisibleColumns(currentDataColumns);
      }
      dataColumns.revealColumns(columnsToReveal);

      dataEmpty.classList.add("hidden");
      dataDetail.classList.remove("hidden");
      if (dataTableSearch && !dataTablePickerOpen) dataTableSearch.value = tableName;
      dataColumns.renderMenu();
      renderCurrentDataTable(result.totalMatched);
      options.onStableViewChange?.();
      endTrace({
        rows: currentDataRows.length,
        columns: currentDataColumns.length,
        visibleColumns: dataColumns.getVisibleColumns().size,
        totalMatched: result.totalMatched,
      });
    } catch (err) {
      if (viewSeq !== dataViewLoadSeq || currentDataTable !== tableName) {
        endTrace({ stale: true, error: (err instanceof Error ? err.message : String(err)) });
        return;
      }
      endTrace({ error: (err instanceof Error ? err.message : String(err)) });
      throw err;
    } finally {
      endLoading();
    }
  }

  function renderCurrentDataTable(totalMatched: number | null = null) {
    if (!dataPreview) return;
    const endTrace = startTrace("render_current_table", {
      table: currentDataTable || "",
      rows: currentDataRows.length,
      columns: currentDataColumns.length,
      visibleColumns: dataColumns.getVisibleColumns().size,
    });
    updateDataExportButtonLabel();
    dataImageCollection.updateControls();
    const rows = deriveVisibleDataRows();
    dataImageCollection.reconcileSelection(currentDataRows);
    const total = Number.isFinite(Number(totalMatched)) ? Number(totalMatched) : currentDataRows.length;
    const loaded = currentDataRows.length < total ? t("rowsLoaded", { count: String(currentDataRows.length) }) : "";
    const filtered = dataSearchQuery ? t("matchingRows", { count: String(rows.length) }) : "";
    const isImageCollection = isCurrentImageCollectionTable();
    const unit = isImageCollection ? t("images") : t("rowUnit");
    const shownRows = isImageCollection ? rows.slice(0, DATA_PREVIEW_RENDER_LIMIT) : rows;
    const metaText = t("total", { count: String(total), unit: String(unit), loaded: String(loaded), filtered: String(filtered), action: String(isImageCollection ? t("preview") : t("show")), shown: String(shownRows.length) });
    dataPreview.classList.toggle("grid-mode", !isImageCollection);
    dataPreview.classList.toggle("qz-scroll--native", !isImageCollection);
    if (isImageCollection) {
      dataGridAdapter.destroy();
      dataImageCollection.renderInto(shownRows);
    } else {
      dataGridAdapter.render(shownRows, dataColumns.getVisibleColumnOrder(), metaText);
    }
    dataImageCollection.updateControls(rows);
    endTrace({
      imageCollection: Boolean(isImageCollection),
      visibleRows: rows.length,
      shownRows: shownRows.length,
      total,
    });
  }

  function updateDataExportButtonLabel() {
    if (!btnExportData) return;
    const label = btnExportData.querySelector<HTMLElement>("#data-export-label");
    if (label) label.textContent = isCurrentImageCollectionTable() ? t("exportZip") : t("exportExcel");
  }

  function deriveVisibleDataRows() {
    let rows = currentDataRows;
    if (dataSearchQuery) {
      rows = rows.filter(record => currentDataColumns.some(column => {
        const text = formatDataCell(record, column).toLowerCase();
        return text.includes(dataSearchQuery);
      }));
    }
    if (dataSortColumn) {
      rows = [...rows].sort((a, b) => compareDataValues(
        dataFieldValue(a, dataSortColumn),
        dataFieldValue(b, dataSortColumn),
        dataSortDir,
      ));
    }
    return rows;
  }

  function compareDataValues(a: unknown, b: unknown, direction = "asc") {
    const leftEmpty = isEmptyDataSortValue(a);
    const rightEmpty = isEmptyDataSortValue(b);
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    if (leftEmpty) return 0;

    const an = Number(a);
    const bn = Number(b);
    const order = Number.isFinite(an) && Number.isFinite(bn)
      ? an - bn
      : String(a).localeCompare(String(b), getLocale(), { numeric: true, sensitivity: "base" });
    return direction === "desc" ? -order : order;
  }

  function isEmptyDataSortValue(value: unknown) {
    return value == null || (typeof value === "string" && !value.trim());
  }

  function replaceCurrentDataRow(record: DataRow | null) {
    if (!record || record.table !== currentDataTable) return;
    const index = currentDataRows.findIndex(item => item.id === record?.id);
    if (index >= 0 && record) currentDataRows[index] = record;
    else if (record) currentDataRows.push(record);
    currentDataColumns = inferColumns(currentDataRows, dataColumns.getCurrentTableColumnOrder());
  }

  async function addCurrentDataRow() {
    if (!currentDataTable || isCurrentImageCollectionTable()) return;
    const table = currentDataTable;
    let viewSeq = dataViewLoadSeq;
    const columns = dataColumns.getUserColumnOrder();
    const row = Object.fromEntries(columns.map(column => [column, ""]));
    setDataEditStatus(t("addingRow"), "saving", { timeout: 0 });
    try {
      const inserted = await insertDataRows(table, row, { columns, position: "prepend" });
      refreshDataTablesCacheQuietly();
      if (viewSeq !== dataViewLoadSeq) return;
      await showDataTable(table, {}, viewSeq = ++dataViewLoadSeq);
      if (viewSeq !== dataViewLoadSeq) return;
      const rowId = inserted[0]?.id || "";
      if (rowId && dataGridAdapter.hasInstance()) {
        requestAnimationFrame(() => {
          if (viewSeq !== dataViewLoadSeq) return;
          dataGridAdapter.scrollToRow(rowId, "top", false);
          dataGridAdapter.setSelectedRowIds([rowId]);
        });
      }
      setDataEditStatus(t("added"), "saved");
    } catch (err) {
      if (viewSeq === dataViewLoadSeq) setDataEditStatus((err instanceof Error ? err.message : t("couldNotAdd")), "error");
    }
  }

  async function deleteSelectedDataRows() {
    if (!currentDataTable || isCurrentImageCollectionTable()) return;
    const table = currentDataTable;
    let viewSeq = dataViewLoadSeq;
    const ids = dataGridAdapter.getSelectedRowIds().filter(Boolean);
    if (!ids.length) return;
    if (!await confirmAction({
      title: t("deleteRows", { count: String(ids.length) }),
      message: t("theSelectedDataWillBePermanentlyRemovedFromThis"),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;
    if (viewSeq === dataViewLoadSeq) setDataEditStatus(t("deleting"), "saving", { timeout: 0 });
    try {
      await deleteDataRows(ids, { table });
      refreshDataTablesCacheQuietly();
      if (viewSeq !== dataViewLoadSeq) return;
      dataGridAdapter.clearSelection();
      await showDataTable(table, {}, viewSeq = ++dataViewLoadSeq);
      if (viewSeq === dataViewLoadSeq) setDataEditStatus(t("deleted"), "saved");
    } catch (err) {
      if (viewSeq === dataViewLoadSeq) setDataEditStatus((err instanceof Error ? err.message : t("couldNotDelete")), "error");
    }
  }

  function updateDataGridSelectionControls() {
    if (btnClearDataFilters) {
      const hasFilters = dataGridAdapter.getHeaderFilters().length > 0;
      btnClearDataFilters.classList.toggle("hidden", !hasFilters || isCurrentImageCollectionTable());
    }
    if (!btnDeleteDataRows) return;
    const count = dataGridAdapter.getSelectedRowIds().length;
    btnDeleteDataRows.disabled = count === 0 || isCurrentImageCollectionTable();
    setDataActionButtonLabel(btnDeleteDataRows, count ? t("deleteRowCount", { count: String(count) }) : t("deleteRowsAction"));
  }

  function clearCurrentDataGridFilters() {
    if (!dataGridAdapter.hasInstance() || isCurrentImageCollectionTable()) return;
    dataGridAdapter.clearFilters();
    setDataEditStatus(t("filtersCleared"), "saved");
  }

  async function refreshDataTablesCache() {
    dataTablesCache = await listDataTables();
    gridTrace("column_schema cache_refresh", {
      table: currentDataTable,
      columns: Array.isArray(currentDataTableMeta?.columns) ? currentDataTableMeta.columns : [],
    });
    renderDataTables(dataTablesCache);
  }

  async function refreshDataTablesCacheQuietly() {
    try {
      await refreshDataTablesCache();
    } catch (_err) {}
  }

  function setDataEditStatus(text: string, state = "", { timeout = 1600 } = {}) {
    if (disposed) return;
    const message = String(text || "").trim();
    if (!message) {
      hideToast({ key: "data-edit-status" });
      return;
    }
    if (state === "error") {
      showToast(message, {
        tone: "error",
        anchorEl: dataGridActions || dataDetail,
        key: "data-edit-status",
        durationMs: Math.max(2400, Number(timeout) > 0 ? Number(timeout) : 3200),
      });
    }
  }

  function getDataTableMeta(tableName: string | null) {
    const name = String(tableName || "").trim();
    return dataTablesCache.find(table => table.name === name) || null;
  }

  function isCurrentImageCollectionTable() {
    return isImageCollectionTable(currentDataTableMeta);
  }

  function isImageCollectionTable(table: Partial<DataTable> | null = {}) {
    return String(table?.kind || "").trim() === "image_collection"
      || String(table?.assetKind || "").trim() === "image";
  }

  function highlightDataCellText(text: string) {
    const value = String(text ?? "");
    if (!dataSearchQuery) return escapeHtml(value);
    const lower = value.toLowerCase();
    const needle = dataSearchQuery.toLowerCase();
    if (!needle || !lower.includes(needle)) return escapeHtml(value);
    const parts = [];
    let cursor = 0;
    let index = lower.indexOf(needle, cursor);
    while (index >= 0) {
      if (index > cursor) parts.push(escapeHtml(value.slice(cursor, index)));
      parts.push(`<mark class="data-search-hit">${escapeHtml(value.slice(index, index + needle.length))}</mark>`);
      cursor = index + needle.length;
      index = lower.indexOf(needle, cursor);
    }
    if (cursor < value.length) parts.push(escapeHtml(value.slice(cursor)));
    return parts.join("");
  }

  function formatDataCell(record: DataRow, column: string) {
    const value = dataFieldValue(record, column);
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function dataFieldValue(record: DataRow, column: string) {
    if (column === "_rowId") return record.id;
    if (column === "createdAt") return record.createdAt;
    if (column === "updatedAt") return record.updatedAt;
    if (column === "table") return record.table;
    return record.data?.[column];
  }

  async function exportCurrentDataTable() {
    const table = currentDataTable;
    if (!table || disposed) return;
    // Navigation during I/O must never combine one table's rows with another table's identity.
    const imageCollection = isCurrentImageCollectionTable();
    const columnOrder = [...getDataTableColumnOrder(table)];
    try {
      const result = await queryDataRows({ table, limit: 100000 });
      if (disposed) return;
      const columns = getDataTableExportColumns(result.rows, table, columnOrder);
      if (imageCollection) {
        await dataImageCollection.exportTable(result, { table, columns });
        return;
      }
      const rows = result.rows.map(record => {
        const row: Record<string, unknown> = {};
        columns.forEach(column => {
          row[column] = dataFieldValue(record, column);
        });
        return row;
      });
      const xlsx = await loadExcel();
      if (disposed) return;
      const worksheet = xlsx.utils.json_to_sheet(rows, {
        header: columns,
        skipHeader: false,
      });
      const workbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(workbook, worksheet, safeExcelSheetName(table));
      const buffer = xlsx.write(workbook, { bookType: "xlsx", type: "array" });
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      try {
        await chrome.downloads.download({
          url,
          filename: `${safeFilename(table)}.xlsx`,
          saveAs: true,
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    } catch (error) {
      if (!disposed && isActive() && currentDataTable === table) {
        showToast(t("exportFailed", { reason: String(error instanceof Error ? error.message : String(error)) }));
      }
    }
  }

  function safeExcelSheetName(name = "") {
    const clean = String(name || "Data")
      .replace(/[:\\/?*[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (clean || "Data").slice(0, 31);
  }

  function getDataTableExportColumns(records: DataRow[], tableName: string | null, columnOrder = getDataTableColumnOrder(tableName)) {
    const columns = inferColumns(records, columnOrder)
      .filter(column => column !== "table" && !dataColumns.isDefaultHiddenColumn(column));
    return columns.length
      ? columns
      : inferColumns(records, columnOrder).filter(column => column !== "table");
  }

  async function deleteDataTable(tableName: string | null) {
    const name = String(tableName || "").trim();
    if (!name) return;
    const tableIndex = dataTablesCache.findIndex(table => table.name === name);
    const table = tableIndex >= 0 ? dataTablesCache[tableIndex] : null;
    const countText = table ? t("rowCountSummary", { count: Number(table.count || 0) }) : "";
    if (!await confirmAction({
      title: t("confirmDeleteTable", { name: String(name) }),
      message: t("allDataInTheTableWillBePermanentlyRemoved", { summary: String(countText) }),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;

    await clearDataTable(name);
    dataGridAdapter.resetTableState(name);

    if (currentDataTable === name) {
      const next = dataTablesCache[tableIndex + 1] || dataTablesCache[tableIndex - 1] || null;
      selectCurrentDataTable(next?.name || null);
    }
    await loadDataTables();
  }

  function openDataImportPanel() {
    dataImportPanel?.classList.remove("hidden");
    showImportStatus("");
    if (dataImportTable) dataImportTable.value = "";
    if (dataImportFile) dataImportFile.value = "";
    syncDataImportFileState();
    dataImportTable?.focus();
  }

  function closeDataImportPanel() {
    dataImportSeq += 1;
    dataImportPanel?.classList.add("hidden");
    if (dataImportFile) dataImportFile.value = "";
    syncDataImportFileState();
    if (dataImportText) dataImportText.value = "";
    if (dataRecentDownloads) {
      dataRecentDownloads.classList.add("hidden");
      dataRecentDownloads.innerHTML = "";
    }
    showImportStatus("");
  }

  function syncDataImportFileState(file: File | null = null) {
    if (!dataImportFileName) return;
    const name = String(file?.name || "").trim();
    dataImportFileName.textContent = name || t("noFileSelected");
    dataImportFileName.title = name;
    dataImportFileName.classList.toggle("has-file", Boolean(name));
  }

  async function importDataFile(file: File) {
    if (!file) return;
    const operation = beginDataImport(file.name);
    try {
      showImportStatus(t("parsing", { name: String(file.name) }));
      const rows = await parseImportFile(file);
      await importRowsToDataStore(operation, rows);
    } catch (err) {
      if (operation.isCurrent()) showImportStatus((err instanceof Error ? err.message : String(err)), "error");
    }
  }

  async function importPastedData() {
    const text = dataImportText?.value || "";
    const operation = beginDataImport("pasted");
    try {
      showImportStatus(t("parsingPastedContent"));
      const rows = parseImportText(text, "pasted");
      await importRowsToDataStore(operation, rows);
    } catch (err) {
      if (operation.isCurrent()) showImportStatus((err instanceof Error ? err.message : String(err)), "error");
    }
  }

  async function loadRecentDownloadImports() {
    if (!dataRecentDownloads) return;
    try {
      showImportStatus(t("readingRecentDownloads"));
      const items = await chrome.downloads.search({
        limit: 30,
        orderBy: ["-startTime"],
      });
      recentDownloadImportItems = items.filter(item => isImportableFilename(downloadDisplayName(item)));
      renderRecentDownloadImports();
      showImportStatus(recentDownloadImportItems.length ? "" : t("noCsvJsonOrExcelFilesInRecentDownloads"));
    } catch (err) {
      showImportStatus((err instanceof Error ? err.message : String(err)), "error");
    }
  }

  function renderRecentDownloadImports() {
    if (!dataRecentDownloads) return;
    dataRecentDownloads.classList.remove("hidden");
    if (!recentDownloadImportItems.length) {
      dataRecentDownloads.innerHTML = `<div class="data-table-empty">${escapeHtml(t("noRecentDownloadsAvailableToImport"))}</div>`;
      return;
    }
    dataRecentDownloads.innerHTML = recentDownloadImportItems.map((item, index) => `
      <button type="button" class="data-download-import" data-index="${index}" title="${escapeHtmlAttribute(item.filename || item.url || "")}">
        <span>${escapeHtml(downloadDisplayName(item))}</span>
        <small>${escapeHtml(item.state || "")}</small>
      </button>
    `).join("");
    dataRecentDownloads.querySelectorAll<HTMLElement>("[data-index]").forEach(btn => {
      btn.addEventListener("click", () => importRecentDownload(Number(btn.dataset.index)), { signal: lifecycleSignal });
    });
  }

  async function importRecentDownload(index: number) {
    const item = recentDownloadImportItems[index];
    if (!item) return;
    const filename = downloadDisplayName(item);
    const operation = beginDataImport(filename);
    try {
      showImportStatus(t("importing", { name: String(filename) }));
      let blob = null;
      if (/^(https?:|data:)/i.test(item.url || "")) {
        const response = await fetch(item.url);
        if (!response.ok) throw new Error(t("couldNotReadTheDownloadSourceHttp", { status: String(response.status) }));
        blob = await response.blob();
      } else {
        throw new Error(t("browserExtensionsCannotReadLocalDownloadsDirectlyUseUpload"));
      }
      const file = new File([blob], filename, { type: blob.type || inferImportMime(filename) });
      const rows = await parseImportFile(file);
      await importRowsToDataStore(operation, rows);
    } catch (err) {
      if (operation.isCurrent()) showImportStatus((err instanceof Error ? err.message : String(err)), "error");
    }
  }

  function beginDataImport(sourceName: string) {
    const seq = ++dataImportSeq;
    return {
      table: getImportTableName(sourceName), dedupField: dataImportKey?.value.trim() || "",
      isCurrent: () => !disposed && isActive() && seq === dataImportSeq,
    };
  }

  function selectCurrentDataTable(table: string | null) {
    // Refreshing the same table preserves imports; navigating away and back revokes them.
    if (currentDataTable !== table) dataImportSeq += 1;
    currentDataTable = table;
  }

  async function importRowsToDataStore(operation: ReturnType<typeof beginDataImport>, rows: Record<string, unknown>[]) {
    if (!operation.isCurrent()) return;
    if (!rows.length) throw new Error(t("noDataRowsToImport"));
    const { table, dedupField } = operation;
    const columns = inferImportColumnOrder(rows);
    if (dedupField) {
      const result = await upsertDataRows(table, rows, { dedupField, columns });
      if (!operation.isCurrent()) return;
      showImportStatus(t("importedRowsAddedUpdated", { count: String(rows.length), added: String(result.inserted), updated: String(result.updated) }));
    } else {
      await insertDataRows(table, rows, { columns });
      if (!operation.isCurrent()) return;
      showImportStatus(t("importedRows", { count: String(rows.length) }));
    }
    const tables = await listDataTables();
    if (!operation.isCurrent()) return;
    dataTablesCache = tables;
    renderDataTables(dataTablesCache);
    closeDataImportPanel();
    await showDataTable(table, { resetView: true });
  }

  function getDataTableColumnOrder(tableName: string | null) {
    const table = dataTablesCache.find(item => item.name === tableName);
    return Array.isArray(table?.columns) ? table.columns : [];
  }

  function inferImportColumnOrder(rows: Record<string, unknown>[]) {
    const columns = [];
    const seen = new Set();
    for (const row of rows || []) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      for (const key of Object.keys(row)) {
        const column = String(key || "").trim();
        if (!column || seen.has(column)) continue;
        seen.add(column);
        columns.push(column);
      }
    }
    return columns;
  }

  function getImportTableName(sourceName = "") {
    return (dataImportTable?.value.trim() || tableNameFromFilename(sourceName) || `import_${compactBeijingTimestamp()}`).slice(0, 120);
  }

  function compactBeijingTimestamp() {
    return nowBeijingDateTime().replace(/\D/g, "").slice(0, 14);
  }

  function showImportStatus(message: string, type = "") {
    if (disposed) return;
    if (!dataImportStatus) return;
    dataImportStatus.textContent = message || "";
    dataImportStatus.classList.toggle("error", type === "error");
  }


  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    dataTablesLoadSeq += 1;
    dataViewLoadSeq += 1;
    dataLoadingOwnerSeq += 1;
    if (dataRefreshTimer) clearTimeout(dataRefreshTimer);
    if (dataLoadingTimer) clearTimeout(dataLoadingTimer);
    deactivate();
    closeDataImportPanel();
    dataGridAdapter.destroy();
    dataImageCollection.resetForTable();
  }
  lifecycleSignal?.addEventListener("abort", dispose, { once: true });

  return {
    panel: dataPanel,
    dispose,
    restore: async (table: string | null) => { selectCurrentDataTable(table); await activate({ showLoading: true }); },
    activate,
    deactivate,
    invalidate,
    listTables: () => listDataTables(),
    scheduleRefresh: scheduleDataTablesRefresh,
    formatTableDate: formatDataTableDate,
    openArtifactTable,
    closeTopmostTransientUi,
    hasBlockingOverlay,
    getCurrentTable: () => currentDataTable,
  };
}

function isElementVisible(element: HTMLElement | null) {
  return Boolean(element && !element.classList.contains("hidden"));
}

function normalizeOpenableLinkUrl(href: string) {
  const raw = String(href || "").trim();
  if (!raw || raw.startsWith("#")) return "";
  let url;
  try {
    url = new URL(raw, location.href);
  } catch (_error) {
    return "";
  }
  if (url.origin === location.origin && url.pathname === location.pathname && url.hash) return "";
  if (!["http:", "https:"].includes(url.protocol)) return "";
  return url.href;
}
