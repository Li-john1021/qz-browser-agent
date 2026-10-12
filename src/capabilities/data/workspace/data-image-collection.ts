import { escapeHtmlAttribute } from "#sdk/sidepanel/dom";
import { t } from "../i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createImageAssetUrls } from "#sdk/sidepanel/dom";
import { loadExcel } from "./data-excel.js";
import { deleteImageAsset, getImageAsset, type ImageAssetRecord } from "#sdk/shared/data";
import { deleteDataRows, listDataTables, queryDataRows, type DataRow, type DataTable } from "#sdk/shared/data";
import { createZip } from "#sdk/shared/skills";
import { nowBeijingDateTime } from "#sdk/shared/format";
import { openImageGallery } from "#sdk/sidepanel/dom";
import { escapeHtml, safeFilename } from "#sdk/sidepanel/dom";

interface DataImageCollectionOptions {
  signal?: AbortSignal;
  preview?: HTMLElement | null; detail?: HTMLElement | null; columnsButton?: HTMLElement | null;
  gridActions?: HTMLElement | null; searchInput?: HTMLInputElement | null;
  selectionActions?: HTMLElement | null; selectionCount?: HTMLElement | null;
  selectVisibleButton?: HTMLButtonElement | null; clearSelectionButton?: HTMLButtonElement | null;
  deleteSelectionButton?: HTMLButtonElement | null; previewRenderLimit?: number;
  getCurrentTable?(): string | null;
  getRows?(): DataRow[]; deriveVisibleDataRows?(): DataRow[];
  renderCurrentDataTable?(): void; isCurrentImageCollectionTable?(): boolean;
  isImageCollectionTable?(table: DataTable): boolean;
  closeDataColumnsMenu?(): void; updateDataGridSelectionControls?(): void;
  setDataActionButtonLabel?(button: HTMLElement, label: string): void;
  loadDataTables?(): Promise<void>;
  getDataTableExportColumns?(rows: DataRow[], table: string | null): string[];
  dataFieldValue?(row: DataRow, field: string): unknown;
  safeExcelSheetName?(name: string): string;
  confirm?: UiExtensionAPI["dialogs"]["confirm"];
  showToast?: UiExtensionAPI["showToast"];
}

export function createDataImageCollection(options: DataImageCollectionOptions = {}) {
  const lifecycleSignal = options.signal;
  const preview = options.preview || null;
  const detail = options.detail || null;
  const columnsButton = options.columnsButton || null;
  const gridActions = options.gridActions || null;
  const searchInput = options.searchInput || null;
  const selectionActions = options.selectionActions || null;
  const selectionCount = options.selectionCount || null;
  const selectVisibleButton = options.selectVisibleButton || null;
  const clearSelectionButton = options.clearSelectionButton || null;
  const deleteSelectionButton = options.deleteSelectionButton || null;
  const getCurrentTable = options.getCurrentTable || (() => "");
  const getRows = options.getRows || (() => []);
  const deriveVisibleDataRows = options.deriveVisibleDataRows || (() => []);
  const renderCurrentDataTable = options.renderCurrentDataTable || (() => {});
  const isCurrentImageCollectionTable = options.isCurrentImageCollectionTable || (() => false);
  const isImageCollectionTable = options.isImageCollectionTable || (() => false);
  const closeDataColumnsMenu = options.closeDataColumnsMenu || (() => {});
  const updateDataGridSelectionControls = options.updateDataGridSelectionControls || (() => {});
  const setDataActionButtonLabel = options.setDataActionButtonLabel || (() => {});
  const loadDataTables = options.loadDataTables || (async () => {});
  const getDataTableExportColumns = options.getDataTableExportColumns || (() => []);
  const dataFieldValue = options.dataFieldValue || (() => undefined);
  const safeExcelSheetName = options.safeExcelSheetName || (name => String(name || "Data"));
  const confirmAction = options.confirm || (async () => false);
  const showToast = options.showToast || (() => {});
  const DATA_PREVIEW_RENDER_LIMIT = Number(options.previewRenderLimit || 300);
  let selectedImageCollectionRows = new Set<string>();
  let lastSelectedImageCollectionRowId = "";
  const imageUrls = createImageAssetUrls();

  selectVisibleButton?.addEventListener("click", selectVisibleImageCollectionRows, { signal: lifecycleSignal });
  clearSelectionButton?.addEventListener("click", clearImageCollectionSelection, { signal: lifecycleSignal });
  deleteSelectionButton?.addEventListener("click", deleteSelectedImageCollectionRows, { signal: lifecycleSignal });

  function updateDataCollectionControls(visibleRows: DataRow[] | null = null) {
    const imageTable = isCurrentImageCollectionTable();
    detail?.classList.toggle("image-collection", imageTable);
    columnsButton?.classList.toggle("hidden", imageTable);
    gridActions?.classList.toggle("hidden", imageTable);
    if (imageTable) closeDataColumnsMenu();
    searchInput?.classList.toggle("hidden", imageTable);
    selectionCount?.classList.toggle("hidden", !imageTable);
    selectionActions?.classList.toggle("hidden", !imageTable);
    if (searchInput) searchInput.placeholder = imageTable ? "" : t("searchThisTable");
    if (!imageTable) {
      updateDataGridSelectionControls();
      return;
    }

    const rows = Array.isArray(visibleRows) ? visibleRows : deriveVisibleDataRows();
    const count = selectedImageCollectionRows.size;
    const summary = t("imagesTotal", { count: String(rows.length) });
    if (selectionCount) {
      selectionCount.textContent = count ? t("imagesSelected", { count: String(count), size: String(summary) }) : summary;
    }
    if (clearSelectionButton) clearSelectionButton.disabled = count === 0;
    if (deleteSelectionButton) deleteSelectionButton.disabled = count === 0;
    if (selectVisibleButton) {
      const selectable = rows.filter(isDeletableImageCollectionRecord);
      const allSelected = selectable.length > 0 && selectable.every(record => selectedImageCollectionRows.has(record.id));
      setDataActionButtonLabel(selectVisibleButton, allSelected ? t("deselectAll") : t("selectAll"));
      selectVisibleButton.disabled = selectable.length === 0;
    }
  }

  function isDeletableImageCollectionRecord(record: DataRow) {
    return Boolean(record?.id);
  }

  function reconcileImageCollectionSelection(records = getRows()) {
    if (!isCurrentImageCollectionTable()) {
      selectedImageCollectionRows.clear();
      lastSelectedImageCollectionRowId = "";
      return;
    }
    const valid = new Set((records || []).map(record => record.id).filter(Boolean));
    let changed = false;
    for (const id of selectedImageCollectionRows) {
      if (!valid.has(id)) {
        selectedImageCollectionRows.delete(id);
        changed = true;
      }
    }
    if (lastSelectedImageCollectionRowId && !valid.has(lastSelectedImageCollectionRowId)) {
      lastSelectedImageCollectionRowId = "";
    }
    return changed;
  }

  function toggleImageCollectionSelection(rowId: string | undefined, event: MouseEvent | null = null) {
    const id = String(rowId || "").trim();
    if (!id) return;
    if (event?.shiftKey && lastSelectedImageCollectionRowId) {
      selectImageCollectionRange(lastSelectedImageCollectionRowId, id);
    } else if (selectedImageCollectionRows.has(id)) {
      selectedImageCollectionRows.delete(id);
    } else {
      selectedImageCollectionRows.add(id);
    }
    lastSelectedImageCollectionRowId = id;
    renderCurrentDataTable();
  }

  function selectImageCollectionRange(fromId: string, toId: string) {
    const rows = deriveVisibleDataRows().slice(0, DATA_PREVIEW_RENDER_LIMIT);
    const from = rows.findIndex(record => record.id === fromId);
    const to = rows.findIndex(record => record.id === toId);
    if (from < 0 || to < 0) {
      selectedImageCollectionRows.add(toId);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    rows.slice(start, end + 1).forEach(record => {
      if (record.id) selectedImageCollectionRows.add(record.id);
    });
  }

  function selectVisibleImageCollectionRows() {
    if (!isCurrentImageCollectionTable()) return;
    const visible = deriveVisibleDataRows().filter(isDeletableImageCollectionRecord);
    if (!visible.length) return;
    const allSelected = visible.every(record => selectedImageCollectionRows.has(record.id));
    visible.forEach(record => {
      if (allSelected) selectedImageCollectionRows.delete(record.id);
      else selectedImageCollectionRows.add(record.id);
    });
    lastSelectedImageCollectionRowId = visible.at(-1)?.id || lastSelectedImageCollectionRowId;
    renderCurrentDataTable();
  }

  function clearImageCollectionSelection() {
    selectedImageCollectionRows.clear();
    lastSelectedImageCollectionRowId = "";
    renderCurrentDataTable();
  }

  async function deleteSelectedImageCollectionRows() {
    if (!isCurrentImageCollectionTable()) return;
    const ids = [...selectedImageCollectionRows].filter(Boolean);
    if (!ids.length) return;
    const selected = getRows().filter(record => ids.includes(record.id));
    if (!selected.length) {
      clearImageCollectionSelection();
      return;
    }
    if (!await confirmAction({
      title: t("deleteImages", { count: String(selected.length) }),
      message: t("imagesWillBeRemovedFromLocalFilesNoLonger", { name: String(getCurrentTable()) }),
      confirmLabel: t("delete"),
      tone: "danger",
    })) return;

    const selectedAssetIds = [...new Set(selected
      .map(record => String(record?.data?.assetId || "").trim())
      .filter(Boolean))];
    await deleteDataRows(selected.map(record => record.id));
    await deleteUnreferencedImageAssets(selectedAssetIds, new Set(selected.map(record => record.id)));
    selectedImageCollectionRows.clear();
    lastSelectedImageCollectionRowId = "";
    clearDataImageObjectUrls();
    await loadDataTables();
  }

  async function deleteUnreferencedImageAssets(assetIds: string[] = [], deletedRowIds = new Set<string>()) {
    const pending = new Set((assetIds || []).map(id => String(id || "").trim()).filter(Boolean));
    if (!pending.size) return { deleted: 0, skipped: 0 };
    const tables = await listDataTables();
    const imageTables = tables.filter(isImageCollectionTable);
    const referenced = new Set<string>();

    for (const table of imageTables) {
      const result = await queryDataRows({ table: table.name, limit: 100000 });
      for (const record of result.rows || []) {
        if (deletedRowIds.has(record.id)) continue;
        const assetId = String(record?.data?.assetId || "").trim();
        if (pending.has(assetId)) referenced.add(assetId);
      }
    }

    let deleted = 0;
    for (const assetId of pending) {
      if (referenced.has(assetId)) continue;
      try {
        const result = await deleteImageAsset(assetId);
        if (result?.deleted) deleted += 1;
      } catch (err) {
        console.warn("[轻舟数据] delete image asset failed", assetId, err);
      }
    }
    return { deleted, skipped: referenced.size };
  }


  function renderImageCollectionGrid(rows: DataRow[]) {
    if (!rows.length) return `<div class="data-table-empty">${escapeHtml(t("emptyCollection"))}</div>`;
    return `
      <div class="data-image-grid" aria-label="${escapeHtmlAttribute(t("collectionPreview"))}">
        ${rows.map(record => renderImageCollectionCard(record)).join("")}
      </div>
    `;
  }

  function renderImageCollectionCard(record: DataRow) {
    const data = record?.data && typeof record.data === "object" ? record.data : {};
    const assetId = String(data.assetId || "").trim();
    const status = String(data.status || (assetId ? "ready" : "failed")).trim();
    const title = imageCollectionCardTitle(data);
    const source = data.src || data.pageUrl || data.selector || assetId;
    const failed = status !== "ready";
    const selected = selectedImageCollectionRows.has(record.id);
    return `
      <div class="data-image-card ${failed ? "failed" : ""} ${selected ? "selected" : ""}" data-image-row="${escapeHtmlAttribute(record.id)}" title="${escapeHtmlAttribute(source || title)}">
        <button class="data-image-select-toggle" type="button" data-image-select-row="${escapeHtmlAttribute(record.id)}" aria-pressed="${selected ? "true" : "false"}" title="${escapeHtmlAttribute(selected ? t("deselect") : t("selectImage"))}">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 8.1 6.5 11 12.5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        <button class="data-image-open" type="button" data-image-open-row="${escapeHtmlAttribute(record.id)}" title="${escapeHtmlAttribute(source || title)}">
          <span class="data-image-thumb" ${assetId ? `data-image-asset-id="${escapeHtmlAttribute(assetId)}"` : ""}>
            ${assetId ? `<span class="data-image-thumb-loading">${escapeHtml(t("loading"))}</span>` : `<span class="data-image-thumb-empty">${escapeHtml(failed ? t("failed") : t("noImage"))}</span>`}
          </span>
        </button>
      </div>
    `;
  }

  function hydrateImageCollectionGrid() {
    const slots = preview?.querySelectorAll<HTMLElement>("[data-image-asset-id]");
    if (!slots?.length) return;
    slots.forEach(slot => {
      const assetId = slot.dataset.imageAssetId || "";
      if (!assetId || slot.dataset.loaded === "true") return;
      slot.dataset.loaded = "true";
      imageUrls.acquire(assetId).then(url => {
        if (!slot.isConnected) return;
        slot.innerHTML = url ? `<img src="${escapeHtmlAttribute(url)}" alt="" loading="lazy">` : `<span class="data-image-thumb-empty">${escapeHtml(t("missing"))}</span>`;
      }).catch(() => {
        if (!slot.isConnected) return;
        slot.innerHTML = `<span class="data-image-thumb-empty">${escapeHtml(t("missing"))}</span>`;
      });
    });
  }

  function openImageCollectionGallery(rowId: string | undefined) {
    const records = deriveVisibleDataRows()
      .filter(record => {
        const data = record?.data && typeof record.data === "object" ? record.data : {};
        return data.assetId || data.src || data.status;
      });
    if (!records.length) return;
    let index = records.findIndex(record => String(record.id) === String(rowId));
    if (index < 0) index = 0;
    openImageGallery(records.map(imageCollectionGalleryItem), index, { label: t("collectionPreview") });
  }

  function imageCollectionGalleryItem(record: DataRow) {
    const data = record?.data && typeof record.data === "object" ? record.data : {};
    return {
      assetId: String(data.assetId || "").trim(),
      src: data.src || data.currentSrc || "",
      title: imageCollectionCardTitle(data),
      error: data.error || data.errorCode || "",
      fields: imageCollectionMetaFields(data),
    };
  }

  function imageCollectionMetaFields(data: Record<string, unknown> = {}) {
    const info = [
      imageCollectionDimensions(data),
      data.mimeType,
      formatDataBytes(data.bytes),
    ].filter(Boolean).join(" · ");
    const method = [data.source, data.captureMethod].filter(Boolean).join(" · ");
    return [
      [t("source"), data.src || data.pageUrl],
      [t("information"), info],
      [t("captureMethod"), method],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  }

  function clearDataImageObjectUrls() {
    imageUrls.retain(new Set());
  }

  function imageCollectionCardTitle(data: Record<string, unknown> = {}) {
    const text = String(data.alt || data.title || filenameFromUrl(data.src) || data.assetId || t("image")).trim();
    return clipText(text, 80);
  }

  function imageCollectionDimensions(data: Record<string, unknown> = {}) {
    const width = Number(data.width || data.naturalWidth || 0);
    const height = Number(data.height || data.naturalHeight || 0);
    return width > 0 && height > 0 ? `${Math.round(width)}×${Math.round(height)}` : "";
  }

  function formatDataBytes(value: unknown) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }


  async function exportCurrentImageCollectionTable(result: { rows: DataRow[] }, {
    table = getCurrentTable(), columns = getDataTableExportColumns(result.rows, table),
  }: { table?: string | null; columns?: string[] } = {}) {
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const xlsx = await loadExcel();
    if (lifecycleSignal?.aborted) return;
    const zipEntries: Parameters<typeof createZip>[0] = [];
    const usedNames = new Set<string>();
    const metaRows = [];

    for (const [index, record] of rows.entries()) {
      const data = record?.data && typeof record.data === "object" ? record.data : {};
      let imageFile = "";
      const assetId = String(data.assetId || "").trim();
      if (assetId) {
        const asset = await getImageAsset(assetId, { touch: false });
        if (lifecycleSignal?.aborted) return;
        if (asset?.blob) {
          const filename = imageCollectionExportFilename(data, asset, index, usedNames);
          imageFile = `images/${filename}`;
          zipEntries.push({
            path: imageFile,
            content: await asset.blob.arrayBuffer(),
          });
        }
      }
      const row: Record<string, unknown> = { imageFile };
      columns.forEach(column => {
        row[column] = dataFieldValue(record, column);
      });
      metaRows.push(row);
    }

    const metaColumns = ["imageFile", ...columns.filter(column => column !== "imageFile")];
    const worksheet = xlsx.utils.json_to_sheet(metaRows, {
      header: metaColumns,
      skipHeader: false,
    });
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, safeExcelSheetName(table || "metadata"));
    zipEntries.unshift({
      path: "metadata.xlsx",
      content: xlsx.write(workbook, { bookType: "xlsx", type: "array" }),
    });
    zipEntries.unshift({
      path: "manifest.json",
      content: JSON.stringify({
        table,
        kind: "image_collection",
        exportedAt: nowBeijingDateTime(),
        rows: rows.length,
        images: zipEntries.filter(entry => String(entry.path || "").startsWith("images/")).length,
      }, null, 2),
    });

    const blob = await createZip(zipEntries);
    if (lifecycleSignal?.aborted) return;
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: `${safeFilename(table)}.zip`,
        saveAs: true,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function imageCollectionExportFilename(data: Record<string, unknown>, asset: ImageAssetRecord, index: number, usedNames: Set<string>) {
    const sourceName = filenameFromUrl(data.src || data.currentSrc || "");
    const base = safeFilename(sourceName || data.title || data.alt || data.assetId || `image-${index + 1}`);
    const ext = imageCollectionExportExtension(asset.mimeType || data.mimeType || asset.blob?.type || sourceName);
    const stem = base.replace(/\.[a-z0-9]{2,8}$/i, "") || `image-${index + 1}`;
    let name = `${stem}.${ext}`;
    let n = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${stem}-${n}.${ext}`;
      n += 1;
    }
    usedNames.add(name.toLowerCase());
    return name;
  }

  function imageCollectionExportExtension(value: unknown = "") {
    const text = String(value || "").toLowerCase();
    if (text.includes("png")) return "png";
    if (text.includes("webp")) return "webp";
    if (text.includes("gif")) return "gif";
    if (text.includes("avif")) return "avif";
    if (text.includes("svg")) return "svg";
    if (/\.(png|webp|gif|avif|svg|jpe?g)(?:$|[?#])/.test(text)) {
      const match = text.match(/\.(png|webp|gif|avif|svg|jpe?g)(?:$|[?#])/);
      return match?.[1] === "jpeg" ? "jpg" : (match?.[1] || "jpg");
    }
    return "jpg";
  }


  function renderInto(rows: DataRow[] = []) {
    if (!preview) return;
    preview.innerHTML = renderImageCollectionGrid(rows);
    preview.querySelectorAll<HTMLElement>("[data-image-open-row]").forEach(button => {
      button.addEventListener("click", () => openImageCollectionGallery(button.dataset.imageOpenRow), { signal: lifecycleSignal });
    });
    preview.querySelectorAll<HTMLElement>("[data-image-select-row]").forEach(button => {
      button.addEventListener("click", event => toggleImageCollectionSelection(button.dataset.imageSelectRow, event), { signal: lifecycleSignal });
    });
    hydrateImageCollectionGrid();
  }

  function resetForTable() {
    selectedImageCollectionRows.clear();
    lastSelectedImageCollectionRowId = "";
    clearDataImageObjectUrls();
  }

  return {
    renderInto,
    updateControls: updateDataCollectionControls,
    reconcileSelection: reconcileImageCollectionSelection,
    resetForTable,
    clearObjectUrls: clearDataImageObjectUrls,
    exportTable: exportCurrentImageCollectionTable,
  };
}

function filenameFromUrl(url: unknown = "") {
  try {
    const parsed = new URL(String(url || ""));
    const tail = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return tail || "";
  } catch (_error) {
    return String(url || "").split(/[/?#]/).filter(Boolean).pop() || "";
  }
}

function clipText(text: string, maxChars: number) {
  const value = String(text || "").replace(/s+/g, " ").trim();
  return value.length > maxChars ? value.slice(0, maxChars - 1) + "…" : value;
}
