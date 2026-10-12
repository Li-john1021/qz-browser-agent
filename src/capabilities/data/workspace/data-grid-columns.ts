import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import type { createDataGridAdapter } from "./data-grid-adapter.js";
import {
  addDataTableColumn,
  deleteDataTableColumn,
  inferColumns,
  renameDataTableColumn,
  setDataTableColumns,
  type DataRow, type DataTable, type DataColumnMeta,
} from "#sdk/shared/data";
import { escapeHtml } from "#sdk/sidepanel/dom";

export const DATA_COLUMNS_HIDDEN_BY_DEFAULT = new Set([
  "_rowId",
  "createdAt",
  "updatedAt",
  "_sourceFile",
  "_sourceSheet",
  "_sourceRow",
]);

export interface DataGridColumnState {
  currentDataTable: string | null;
  currentDataTableMeta: (Pick<DataTable, "name"> & Partial<DataTable>) | null;
  currentDataRows: DataRow[];
  currentDataColumns: string[];
  dataTablesCache: DataTable[];
}
interface DataGridColumnOptions {
  signal?: AbortSignal;
  root?: Document | HTMLElement; button?: HTMLElement | null; menu?: HTMLElement | null;
  state: DataGridColumnState;
  getViewRevision?(): number;
  gridTrace?(event: string, detail: Record<string, unknown>): void;
  getGridAdapter(): ReturnType<typeof createDataGridAdapter>;
  isCurrentImageCollectionTable?(): boolean; updateDataCollectionControls?(): void;
  renderCurrentDataTable?(): void;
  setDataEditStatus?(message: string, state?: string, options?: { timeout?: number }): void;
  showDataTable?(table: string, options?: { revealColumns?: string[] }): Promise<void>;
  refreshDataTablesCache?(): Promise<void>;
  getDataTableColumnOrder?(table: string | null): string[];
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
  requestText?: UiExtensionAPI["dialogs"]["requestText"];
  defaultColumnLimit?: number;
}

export function createDataGridColumns(options: DataGridColumnOptions) {
  const lifecycleSignal = options.signal;
  const root = options.root || document;
  const button = options.button || null;
  const menu = options.menu || null;
  const state = options.state;
  const gridTrace = options.gridTrace || (() => {});
  const getGridAdapter = options.getGridAdapter;
  const isCurrentImageCollectionTable = options.isCurrentImageCollectionTable || (() => false);
  const updateDataCollectionControls = options.updateDataCollectionControls || (() => {});
  const renderCurrentDataTable = options.renderCurrentDataTable || (() => {});
  const setDataEditStatus = options.setDataEditStatus || (() => {});
  const showDataTable = options.showDataTable || (async () => {});
  const refreshDataTablesCache = options.refreshDataTablesCache || (async () => {});
  const getDataTableColumnOrder = options.getDataTableColumnOrder || (() => []);
  const confirmAction = options.confirm || (async () => false);
  const requestText = options.requestText || (async () => null);
  const DATA_DEFAULT_COLUMN_LIMIT = Number(options.defaultColumnLimit || 24);
  let visibleDataColumns = new Set<string>();
  const schemaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  lifecycleSignal?.addEventListener("abort", () => {
    for (const timer of schemaTimers.values()) clearTimeout(timer);
    schemaTimers.clear();
  }, { once: true });
  let dataColumnRenameField = "";
  let dataColumnDragField = "";

  button?.addEventListener("click", () => {
    setDataColumnsMenuOpen(menu?.classList.contains("hidden") ?? true);
  }, { signal: lifecycleSignal });
  root.addEventListener("pointerdown", handleDataColumnsOutsidePointer, { capture: true, signal: lifecycleSignal });

  function setDataColumnsMenuOpen(open: boolean) {
    menu?.classList.toggle("hidden", !open);
    button?.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeDataColumnsMenu() {
    const hadRename = Boolean(dataColumnRenameField);
    dataColumnRenameField = "";
    if (hadRename && !isCurrentImageCollectionTable()) renderDataColumnsMenu();
    setDataColumnsMenuOpen(false);
  }

  function handleDataColumnsOutsidePointer(event: Event) {
    if (!isElementVisible(menu)) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (menu?.contains(target) || button?.contains(target)) return;
    closeDataColumnsMenu();
  }

  function createDefaultVisibleDataColumns(columns: string[]) {
    return new Set((columns || [])
      .filter(column => !isDefaultHiddenDataColumn(column))
      .filter(column => !getDataColumnMeta(column).hidden)
      .slice(0, DATA_DEFAULT_COLUMN_LIMIT));
  }

  function isDefaultHiddenDataColumn(column: string) {
    return DATA_COLUMNS_HIDDEN_BY_DEFAULT.has(column);
  }


  function getVisibleDataColumnOrder() {
    return state.currentDataColumns.filter(column => visibleDataColumns.has(column));
  }


  function renderDataColumnsMenu() {
    if (!menu) return;
    updateDataCollectionControls();
    if (isCurrentImageCollectionTable()) {
      closeDataColumnsMenu();
      menu.innerHTML = "";
      return;
    }
    if (!state.currentDataColumns.length) {
      menu.innerHTML = `
        <div class="data-table-empty">${escapeHtml(t("noColumns"))}</div>
        ${renderDataColumnAddAction()}
      `;
      bindDataColumnMenuActions();
      return;
    }
    menu.innerHTML = state.currentDataColumns.map(column => {
      const editable = isEditableDataColumn(column);
      const renaming = dataColumnRenameField === column;
      return `
      <div class="data-column-option ${renaming ? "renaming" : ""}" title="${escapeHtmlAttribute(column)}" data-column-field="${escapeHtmlAttribute(column)}">
        <span class="data-column-drag-handle ${editable && !renaming ? "" : "disabled"}" ${editable && !renaming ? 'draggable="true" data-column-drag' : ""} title="${escapeHtmlAttribute(t("dragToReorder"))}" aria-hidden="true">
          <svg viewBox="0 0 12 16" fill="none" aria-hidden="true">
            <path d="M3 3.5h.01M9 3.5h.01M3 8h.01M9 8h.01M3 12.5h.01M9 12.5h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </span>
        <label class="data-column-visible-toggle">
          <input class="qz-checkbox" type="checkbox" value="${escapeHtmlAttribute(column)}" ${visibleDataColumns.has(column) ? "checked" : ""} ${renaming ? "disabled" : ""}>
          ${renderDataColumnOptionName(column)}
        </label>
        ${renderDataColumnOptionActions(column)}
      </div>
    `;
    }).join("") + renderDataColumnAddAction();
    bindDataColumnMenuActions();
    focusDataColumnRenameInput();
  }

  function renderDataColumnOptionName(column: string) {
    if (dataColumnRenameField !== column) {
      return `
        <span class="data-column-option-name">
          <span class="data-column-option-name-text">${escapeHtml(column)}</span>
          <span class="data-column-option-type">${escapeHtml(getGridAdapter().getSortProfileLabel(column))}</span>
        </span>
      `;
    }
    return `
      <input
        class="qz-field qz-field--sm data-column-rename-input"
        data-column-rename-input
        data-column-rename-from="${escapeHtmlAttribute(column)}"
        value="${escapeHtmlAttribute(column)}"
        aria-label="${escapeHtmlAttribute(t("columnName"))}"
        spellcheck="false"
      >
    `;
  }

  function renderDataColumnOptionActions(column: string) {
    if (!isEditableDataColumn(column)) return "";
    if (dataColumnRenameField === column) {
      return `
        <span class="data-column-option-actions" aria-label="${escapeHtmlAttribute(t("renameColumnActions", { name: column }))}">
          <button type="button" class="qz-icon-btn qz-icon-btn--xs confirm" data-column-action="rename-commit" data-column="${escapeHtmlAttribute(column)}" title="${escapeHtmlAttribute(t("confirmRename"))}" aria-label="${escapeHtmlAttribute(t("confirmRename"))}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.2 8.3 6.4 11.4 12.9 4.6" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button type="button" class="qz-icon-btn qz-icon-btn--xs" data-column-action="rename-cancel" data-column="${escapeHtmlAttribute(column)}" title="${escapeHtmlAttribute(t("cancelRename"))}" aria-label="${escapeHtmlAttribute(t("cancelRename"))}">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>
            </svg>
          </button>
        </span>
      `;
    }
    return `
      <span class="data-column-option-actions" aria-label="${escapeHtmlAttribute(t("columnActions", { name: column }))}">
        <button type="button" class="qz-icon-btn qz-icon-btn--xs" data-column-action="rename" data-column="${escapeHtmlAttribute(column)}" title="${escapeHtmlAttribute(t("renameColumn"))}" aria-label="${escapeHtmlAttribute(t("renameColumn"))}">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M9.9 3.1 12.9 6.1M2.8 10.6 2.4 13.6 5.4 13.2 13.1 5.5a2.1 2.1 0 0 0-3-3L2.8 10.6Z" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button type="button" class="qz-icon-btn qz-icon-btn--xs qz-icon-btn--danger " data-column-action="delete" data-column="${escapeHtmlAttribute(column)}" title="${escapeHtmlAttribute(t("deleteColumn"))}" aria-label="${escapeHtmlAttribute(t("deleteColumn"))}">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.9 4.4h10.2M6.4 2.8h3.2M5 4.4l.5 8.1c.04.7.55 1.2 1.25 1.2h2.5c.7 0 1.21-.5 1.25-1.2l.5-8.1M6.9 7.1v3.7M9.1 7.1v3.7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </span>
    `;
  }

  function renderDataColumnAddAction() {
    if (!state.currentDataTable || isCurrentImageCollectionTable()) return "";
    return `
      <button type="button" class="qz-btn qz-btn--secondary qz-btn--sm data-column-add-btn" data-column-add title="${escapeHtmlAttribute(t("addColumn"))}">
        <span aria-hidden="true">+</span>
        <span>${escapeHtml(t("addColumn"))}</span>
      </button>
    `;
  }

  function bindDataColumnMenuActions() {
    if (!menu) return;
    menu.querySelectorAll<HTMLInputElement>("input[type='checkbox']").forEach(input => {
      input.addEventListener("change", () => {
        if (input.checked) {
          visibleDataColumns.add(input.value);
          setLocalDataColumnMeta(input.value, { hidden: false });
        } else {
          visibleDataColumns.delete(input.value);
          setLocalDataColumnMeta(input.value, { hidden: true });
        }
        schedulePersistDataTableSchema();
        renderCurrentDataTable();
      }, { signal: lifecycleSignal });
    });
    menu.querySelectorAll<HTMLInputElement>("[data-column-rename-input]").forEach(input => {
      input.addEventListener("pointerdown", event => event.stopPropagation(), { signal: lifecycleSignal });
      input.addEventListener("click", event => event.stopPropagation(), { signal: lifecycleSignal });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          commitDataColumnRenameInput(input).catch(handleDataColumnError);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelDataColumnRename();
        } else {
          event.stopPropagation();
        }
      }, { signal: lifecycleSignal });
    });
    menu.querySelectorAll<HTMLElement>("[data-column-action]").forEach(btn => {
      btn.addEventListener("pointerdown", (event) => {
        if (!btn.dataset.columnAction?.startsWith("rename-")) return;
        event.preventDefault();
        event.stopPropagation();
        handleDataColumnAction(btn.dataset.columnAction, btn.dataset.column).catch(err => {
          setDataEditStatus((err instanceof Error ? err.message : t("columnOperationFailed")), "error");
        });
      }, { signal: lifecycleSignal });
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.dataset.columnAction?.startsWith("rename-")) return;
        btn.blur?.();
        handleDataColumnAction(btn.dataset.columnAction, btn.dataset.column).catch(err => {
          setDataEditStatus((err instanceof Error ? err.message : t("columnOperationFailed")), "error");
        });
      }, { signal: lifecycleSignal });
    });
    menu.querySelector("[data-column-add]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      addCurrentDataColumn().catch(err => {
        setDataEditStatus((err instanceof Error ? err.message : t("couldNotAddColumn")), "error");
      });
    }, { signal: lifecycleSignal });
    bindDataColumnDragActions();
  }

  function bindDataColumnDragActions() {
    if (!menu) return;
    gridTrace("column_drag bind", {
      table: state.currentDataTable,
      handles: menu.querySelectorAll<HTMLElement>("[data-column-drag]").length,
      rows: menu.querySelectorAll<HTMLElement>("[data-column-field]").length,
      order: getDataUserColumnOrder(),
    });
    menu.querySelectorAll<HTMLElement>("[data-column-drag]").forEach(handle => {
      handle.addEventListener("dragstart", (event) => {
        const row = handle.closest<HTMLElement>("[data-column-field]");
        const field = normalizeDataColumnPrompt(row?.dataset.columnField);
        if (!field || !isEditableDataColumn(field)) {
          gridTrace("column_drag start_skip", {
            table: state.currentDataTable,
            field,
            reason: !field ? "missing_field" : "not_editable",
          });
          event.preventDefault();
          return;
        }
        dataColumnDragField = field;
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        event.dataTransfer?.setData("text/plain", field);
        row?.classList.add("dragging");
        gridTrace("column_drag start", {
          table: state.currentDataTable,
          field,
          order: getDataUserColumnOrder(),
        });
      }, { signal: lifecycleSignal });
      handle.addEventListener("dragend", () => {
        gridTrace("column_drag end", {
          table: state.currentDataTable,
          field: dataColumnDragField,
        });
        dataColumnDragField = "";
        clearDataColumnDropIndicators();
      }, { signal: lifecycleSignal });
    });
    menu.querySelectorAll<HTMLElement>("[data-column-field]").forEach(row => {
      row.addEventListener("dragover", (event) => {
        const target = normalizeDataColumnPrompt(row.dataset.columnField);
        if (!dataColumnDragField || !target || target === dataColumnDragField || !isEditableDataColumn(target)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const position = dataColumnDropPosition(event, row);
        markDataColumnDropTarget(row, position);
      }, { signal: lifecycleSignal });
      row.addEventListener("dragleave", () => {
        row.classList.remove("drop-before", "drop-after");
      }, { signal: lifecycleSignal });
      row.addEventListener("drop", (event) => {
        const target = normalizeDataColumnPrompt(row.dataset.columnField);
        if (!dataColumnDragField || !target || target === dataColumnDragField || !isEditableDataColumn(target)) {
          gridTrace("column_drag drop_skip", {
            table: state.currentDataTable,
            from: dataColumnDragField,
            target,
            reason: !dataColumnDragField
              ? "missing_from"
              : !target
                ? "missing_target"
                : target === dataColumnDragField
                  ? "same_target"
                  : "target_not_editable",
          });
          return;
        }
        event.preventDefault();
        const position = row.classList.contains("drop-after") ? "after" : dataColumnDropPosition(event, row);
        gridTrace("column_drag drop", {
          table: state.currentDataTable,
          from: dataColumnDragField,
          target,
          position,
          orderBefore: getDataUserColumnOrder(),
        });
        reorderCurrentDataColumn(dataColumnDragField, target, position);
        dataColumnDragField = "";
        clearDataColumnDropIndicators();
      }, { signal: lifecycleSignal });
    });
  }

  function dataColumnDropPosition(event: DragEvent, row: HTMLElement) {
    const rect = row.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
  }

  function markDataColumnDropTarget(row: HTMLElement, position: string) {
    menu?.querySelectorAll(".data-column-option.drop-before, .data-column-option.drop-after").forEach(item => {
      if (item !== row) item.classList.remove("drop-before", "drop-after");
    });
    row.classList.toggle("drop-before", position === "before");
    row.classList.toggle("drop-after", position === "after");
  }

  function clearDataColumnDropIndicators() {
    menu?.querySelectorAll(".data-column-option.dragging, .data-column-option.drop-before, .data-column-option.drop-after").forEach(row => {
      row.classList.remove("dragging", "drop-before", "drop-after");
    });
  }

  function moveDataColumnMenuRowFast(from: string, target: string, position = "before") {
    const fromRow = getDataColumnMenuRow(from);
    const targetRow = getDataColumnMenuRow(target);
    if (!fromRow || !targetRow || fromRow === targetRow || !targetRow.parentNode) return false;
    targetRow.parentNode.insertBefore(fromRow, position === "after" ? targetRow.nextSibling : targetRow);
    return true;
  }

  function getDataColumnMenuRow(field: string) {
    const name = normalizeDataColumnPrompt(field);
    if (!name || !menu) return null;
    return [...menu.querySelectorAll<HTMLElement>("[data-column-field]")]
      .find(row => normalizeDataColumnPrompt(row.dataset.columnField) === name) || null;
  }

  function captureColumnView() {
    const table = state.currentDataTable;
    const revision = options.getViewRevision?.();
    return { table, columns: [...state.currentDataColumns],
      isCurrent: () => state.currentDataTable === table && options.getViewRevision?.() === revision };
  }

  async function refreshWrittenColumns(view: ReturnType<typeof captureColumnView>, message: string, revealColumns: string[] = []) {
    await refreshDataTablesCache();
    if (!view.table || !view.isCurrent()) return;
    const loading = showDataTable(view.table, { revealColumns });
    const loadedView = captureColumnView();
    try {
      await loading;
      if (loadedView.isCurrent()) setDataEditStatus(message, "saved");
    } catch (error) {
      if (loadedView.isCurrent()) handleDataColumnError(error);
    }
  }

  async function addCurrentDataColumn() {
    if (!state.currentDataTable || isCurrentImageCollectionTable()) return;
    const view = captureColumnView();
    const value = await requestText({
      title: t("addColumn"),
      inputLabel: t("columnName"),
      confirmLabel: t("add"),
      maxLength: 128,
    });
    const field = normalizeDataColumnPrompt(value);
    if (!field) return;
    if (!isEditableDataColumnName(field) || view.columns.includes(field)) {
      if (view.isCurrent()) setDataEditStatus(t("columnNameIsInvalidOrAlreadyExists"), "error");
      return;
    }
    try {
      if (view.isCurrent()) setDataEditStatus(t("addingColumn"), "saving", { timeout: 0 });
      await addDataTableColumn(view.table, field);
      await refreshWrittenColumns(view, t("columnAdded"), [field]);
    } catch (err) {
      if (view.isCurrent()) setDataEditStatus((err instanceof Error ? err.message : t("couldNotAddColumn")), "error");
    }
  }

  async function handleDataColumnAction(action: string | undefined, column: string | undefined) {
    if (action === "rename") return startDataColumnRename(column);
    if (action === "rename-commit") return commitOpenDataColumnRename(column);
    if (action === "rename-cancel") return cancelDataColumnRename();
    if (action === "delete") return deleteCurrentDataColumn(column);
  }

  function handleDataColumnError(err: unknown) {
    setDataEditStatus((err instanceof Error ? err.message : t("columnOperationFailed")), "error");
  }

  function startDataColumnRename(column: string | undefined) {
    const from = normalizeDataColumnPrompt(column);
    if (!state.currentDataTable || !isEditableDataColumn(from)) return;
    dataColumnRenameField = from;
    renderDataColumnsMenu();
  }

  function focusDataColumnRenameInput() {
    if (!dataColumnRenameField || !menu) return;
    const input = menu.querySelector<HTMLInputElement>("[data-column-rename-input]");
    if (!input) return;
    requestAnimationFrame(() => {
      if (!input.isConnected) return;
      input.focus({ preventScroll: true });
      input.select?.();
    });
  }

  function cancelDataColumnRename() {
    if (!dataColumnRenameField) return;
    dataColumnRenameField = "";
    renderDataColumnsMenu();
  }

  async function commitOpenDataColumnRename(column: string | undefined) {
    const field = normalizeDataColumnPrompt(column);
    if (!field || dataColumnRenameField !== field) return;
    const input = [...(menu?.querySelectorAll<HTMLInputElement>("[data-column-rename-input]") || [])]
      .find(item => normalizeDataColumnPrompt(item.dataset.columnRenameFrom) === field);
    await commitDataColumnRenameInput(input);
  }

  async function commitDataColumnRenameInput(input: HTMLInputElement | null | undefined) {
    if (!input || input.dataset.renameDone === "true") return;
    const from = normalizeDataColumnPrompt(input.dataset.columnRenameFrom);
    const to = normalizeDataColumnPrompt(input.value);
    if (!from || dataColumnRenameField !== from) return;
    if (!to || to === from) {
      dataColumnRenameField = "";
      renderDataColumnsMenu();
      return;
    }
    if (!isEditableDataColumnName(to) || state.currentDataColumns.includes(to)) {
      setDataEditStatus(t("columnNameIsInvalidOrAlreadyExists"), "error");
      requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.focus({ preventScroll: true });
        input.select?.();
      });
      return;
    }
    input.dataset.renameDone = "true";
    const view = captureColumnView();
    try {
      dataColumnRenameField = "";
      await renameCurrentDataColumn(from, to);
    } catch (err) {
      if (!view.isCurrent()) return;
      input.dataset.renameDone = "";
      setDataEditStatus((err instanceof Error ? err.message : t("couldNotRenameColumn")), "error");
      dataColumnRenameField = from;
      renderDataColumnsMenu();
    }
  }

  async function renameCurrentDataColumn(column: string, nextColumn: string) {
    const from = normalizeDataColumnPrompt(column);
    const to = normalizeDataColumnPrompt(nextColumn);
    if (!state.currentDataTable || !isEditableDataColumn(from)) return;
    if (!to || to === from) return;
    if (!isEditableDataColumnName(to) || state.currentDataColumns.includes(to)) {
      setDataEditStatus(t("columnNameIsInvalidOrAlreadyExists"), "error");
      return;
    }
    setDataEditStatus(t("renamingColumn"), "saving", { timeout: 0 });
    const view = captureColumnView();
    const wasVisible = visibleDataColumns.has(from);
    await renameDataTableColumn(view.table, from, to);
    if (view.isCurrent()) {
      replaceLocalDataColumnOrder(from, to);
      visibleDataColumns.delete(from);
      if (wasVisible) visibleDataColumns.add(to);
    }
    await refreshWrittenColumns(view, t("columnRenamed"), wasVisible ? [to] : []);
  }

  function replaceLocalDataColumnOrder(from: string, to: string) {
    const order = getDataUserColumnOrder().map(column => column === from ? to : column);
    setLocalDataColumnOrder(order);
  }

  function reorderCurrentDataColumn(from: string, target: string, position = "before") {
    if (!state.currentDataTable || !isEditableDataColumn(from) || !isEditableDataColumn(target) || from === target) {
      gridTrace("column_reorder skip", {
        table: state.currentDataTable,
        from,
        target,
        position,
        reason: !state.currentDataTable
          ? "missing_table"
          : !isEditableDataColumn(from)
            ? "from_not_editable"
            : !isEditableDataColumn(target)
              ? "target_not_editable"
              : "same_target",
      });
      return;
    }
    const order = getDataUserColumnOrder().filter(column => column !== from);
    const targetIndex = order.indexOf(target);
    if (targetIndex < 0) {
      gridTrace("column_reorder skip", {
        table: state.currentDataTable,
        from,
        target,
        position,
        reason: "target_missing",
        order,
      });
      return;
    }
    const orderBefore = getDataUserColumnOrder();
    order.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, from);
    const nextOrder = setLocalDataColumnOrder(order);
    gridTrace("column_reorder apply", {
      table: state.currentDataTable,
      from,
      target,
      position,
      orderBefore,
      orderAfter: nextOrder,
    });
    schedulePersistDataTableSchema(nextOrder);
    const menuMoved = moveDataColumnMenuRowFast(from, target, position);
    const gridMoved = getGridAdapter().applyColumnOrderFast(nextOrder);
    if (!menuMoved) renderDataColumnsMenu();
    if (!gridMoved) renderCurrentDataTable();
  }

  async function deleteCurrentDataColumn(column: string | undefined) {
    const field = normalizeDataColumnPrompt(column);
    if (!state.currentDataTable || !isEditableDataColumn(field)) return;
    const view = captureColumnView();
    if (!await confirmAction({
      title: t("confirmDeleteColumn", { name: String(field) }),
      message: t("thisColumnSDataWillBeRemovedFromEvery"),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;
    if (view.isCurrent()) setDataEditStatus(t("deletingColumn"), "saving", { timeout: 0 });
    try {
      await deleteDataTableColumn(view.table, field, { dropData: true });
      if (view.isCurrent()) visibleDataColumns.delete(field);
      await refreshWrittenColumns(view, t("columnDeleted"));
    } catch (error) { if (view.isCurrent()) throw error; }
  }


  function persistDataGridColumnOrder() {
    if (!getGridAdapter().hasInstance() || !state.currentDataTable || isCurrentImageCollectionTable()) return;
    const visibleOrder = getGridAdapter().getColumnComponents()
      .map(column => column?.getField?.())
      .filter(isEditableDataColumnName);
    const currentOrder = getDataUserColumnOrder();
    const nextOrder = [
      ...visibleOrder,
      ...currentOrder.filter(column => !visibleOrder.includes(column)),
    ];
    const persistedOrder = setLocalDataColumnOrder(nextOrder);
    schedulePersistDataTableSchema(persistedOrder);
  }

  function persistDataGridColumnLayout() {
    if (!getGridAdapter().hasInstance() || !state.currentDataTable || isCurrentImageCollectionTable()) return;
    const columns = getGridAdapter().getColumnComponents();
    let changed = false;
    for (const column of columns) {
      const field = column?.getField?.() || "";
      if (!isEditableDataColumn(field)) continue;
      const width = Number(column?.getWidth?.() || 0);
      if (!Number.isFinite(width) || width < 40) continue;
      setLocalDataColumnMeta(field, {
        width: undefined,
        widthGrow: getGridAdapter().clampWidthGrow(width / 24),
      });
      changed = true;
    }
    if (!changed) return;
    schedulePersistDataTableSchema();
  }

  function schedulePersistDataTableSchema(order: string[] | null = null) {
    if (!state.currentDataTable) return;
    const table = state.currentDataTable;
    const view = captureColumnView();
    const columns = normalizeDataUserColumnOrder(order || getDataUserColumnOrder());
    const columnMeta = getDataColumnMetaMap();
    patchCurrentDataTableMeta({ columns, columnMeta });
    gridTrace("column_schema persist_schedule", {
      table,
      columns,
      fromExplicitOrder: Array.isArray(order),
    });
    clearTimeout(schemaTimers.get(table));
    const timer = setTimeout(async () => {
      try {
        await setDataTableColumns(table, columns, { columnMeta });
        if (schemaTimers.get(table) !== timer) return;
        patchDataTablesCacheMeta(table, { columns, columnMeta });
        if (view.isCurrent()) {
          state.currentDataTableMeta = {
            ...(state.currentDataTableMeta || {}),
            name: table,
            columns,
            columnMeta,
          };
        }
        gridTrace("column_schema persist_done", {
          table,
          columns,
          currentTable: state.currentDataTable,
          currentOrder: state.currentDataTable === table ? getDataUserColumnOrder() : [],
        });
      } catch (err) {
        gridTrace("column_schema persist_error", {
          table,
          columns,
          error: (err instanceof Error ? err.message : String(err)),
        });
        if (schemaTimers.get(table) === timer && view.isCurrent()) {
          setDataEditStatus((err instanceof Error ? err.message : t("couldNotSaveColumnSettings")), "error");
        }
      } finally {
        if (schemaTimers.get(table) === timer) schemaTimers.delete(table);
      }
    }, 450);
    schemaTimers.set(table, timer);
  }

  function setLocalDataColumnMeta(column: string, patch: DataColumnMeta) {
    const field = normalizeDataColumnPrompt(column);
    if (!field) return;
    const columnMeta = getDataColumnMetaMap();
    columnMeta[field] = {
      ...(columnMeta[field] || {}),
      ...patch,
    };
    patchCurrentDataTableMeta({ columnMeta });
  }

  function setLocalDataColumnOrder(order: string[]) {
    const columns = normalizeDataUserColumnOrder(order);
    patchCurrentDataTableMeta({ columns });
    state.currentDataColumns = inferColumns(state.currentDataRows, columns);
    gridTrace("column_order local_set", {
      table: state.currentDataTable,
      columns,
      inferred: state.currentDataColumns,
    });
    return columns;
  }

  function normalizeDataUserColumnOrder(columns: string[] = []) {
    const ordered = [];
    const seen = new Set<string>();
    for (const column of columns || []) {
      const field = normalizeDataColumnPrompt(column);
      if (!isEditableDataColumnName(field) || seen.has(field)) continue;
      seen.add(field);
      ordered.push(field);
    }
    return ordered;
  }

  function getCurrentDataTableColumnOrder() {
    const columns = Array.isArray(state.currentDataTableMeta?.columns)
      ? state.currentDataTableMeta.columns
      : getDataTableColumnOrder(state.currentDataTable);
    return Array.isArray(columns) ? columns : [];
  }

  function patchCurrentDataTableMeta(patch: Partial<DataTable> = {}) {
    if (!state.currentDataTable) return;
    state.currentDataTableMeta = {
      ...(state.currentDataTableMeta || {}),
      name: state.currentDataTable,
      ...patch,
    };
    patchDataTablesCacheMeta(state.currentDataTable, patch);
  }

  function patchDataTablesCacheMeta(tableName: string, patch: Partial<DataTable> = {}) {
    const name = String(tableName || "").trim();
    if (!name || !patch || typeof patch !== "object") return;
    const index = state.dataTablesCache.findIndex(table => table.name === name);
    if (index < 0) {
      gridTrace("column_schema cache_patch_skip", {
        table: name,
        reason: "missing_table",
        patchKeys: Object.keys(patch),
      });
      return;
    }
    state.dataTablesCache[index] = {
      ...state.dataTablesCache[index],
      ...patch,
    };
    if (patch.columns) {
      gridTrace("column_schema cache_patch", {
        table: name,
        columns: patch.columns,
      });
    }
  }


  function getDataUserColumnOrder() {
    return normalizeDataUserColumnOrder([...getCurrentDataTableColumnOrder(), ...state.currentDataColumns]);
  }

  function getDataColumnMetaMap(): Record<string, DataColumnMeta> {
    const meta = state.currentDataTableMeta?.columnMeta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
    try {
      return JSON.parse(JSON.stringify(meta));
    } catch (_err) {
      return {};
    }
  }

  function getDataColumnMeta(column: string): DataColumnMeta {
    const meta = state.currentDataTableMeta?.columnMeta;
    const field = normalizeDataColumnPrompt(column);
    return meta && typeof meta === "object" && !Array.isArray(meta) && meta[field] && typeof meta[field] === "object"
      ? meta[field]
      : {};
  }

  function isEditableDataColumn(column: string) {
    return isEditableDataColumnName(normalizeDataColumnPrompt(column));
  }

  function isEditableDataColumnName(column: string) {
    return Boolean(column)
      && column !== "_rowId"
      && column !== "createdAt"
      && column !== "updatedAt"
      && column !== "table";
  }

  function normalizeDataColumnPrompt(value: unknown) {
    return String(value ?? "").trim().slice(0, 120);
  }


  function resetForTable(columns = state.currentDataColumns || []) {
    dataColumnRenameField = "";
    visibleDataColumns = createDefaultVisibleDataColumns(columns);
    return visibleDataColumns;
  }

  function reconcileVisibleColumns(columns = state.currentDataColumns || []) {
    const allowed = new Set(columns || []);
    visibleDataColumns = new Set([...visibleDataColumns].filter(column => allowed.has(column)));
    for (const column of columns || []) {
      if (visibleDataColumns.size >= DATA_DEFAULT_COLUMN_LIMIT) break;
      if (isDefaultHiddenDataColumn(column) || getDataColumnMeta(column).hidden) continue;
      visibleDataColumns.add(column);
    }
    if (!visibleDataColumns.size) visibleDataColumns = createDefaultVisibleDataColumns(columns);
    return visibleDataColumns;
  }

  function revealColumns(columns: Iterable<string> = []) {
    for (const column of columns || []) {
      if (state.currentDataColumns?.includes?.(column) && isEditableDataColumn(column)) {
        visibleDataColumns.add(column);
      }
    }
  }

  function clearVisibleColumns() {
    dataColumnRenameField = "";
    visibleDataColumns = new Set<string>();
  }

  function isElementVisible(element: HTMLElement | null) {
    return Boolean(element && !element.classList.contains("hidden"));
  }

  return {
    renderMenu: renderDataColumnsMenu,
    openMenu: () => setDataColumnsMenuOpen(true),
    closeMenu: closeDataColumnsMenu,
    resetForTable,
    reconcileVisibleColumns,
    revealColumns,
    clearVisibleColumns,
    getVisibleColumns: () => visibleDataColumns,
    getVisibleColumnOrder: getVisibleDataColumnOrder,
    isDefaultHiddenColumn: isDefaultHiddenDataColumn,
    addColumn: addCurrentDataColumn,
    persistGridColumnOrder: persistDataGridColumnOrder,
    persistGridColumnLayout: persistDataGridColumnLayout,
    schedulePersistSchema: schedulePersistDataTableSchema,
    getCurrentTableColumnOrder: getCurrentDataTableColumnOrder,
    getUserColumnOrder: getDataUserColumnOrder,
    getColumnMeta: getDataColumnMeta,
    getColumnMetaMap: getDataColumnMetaMap,
    isEditableColumn: isEditableDataColumn,
    isEditableColumnName: isEditableDataColumnName,
    normalizeColumnPrompt: normalizeDataColumnPrompt,
    normalizeUserColumnOrder: normalizeDataUserColumnOrder,
  };
}
