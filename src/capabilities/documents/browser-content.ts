import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
import { appendSaveFileContentPreview, saveFileContentText } from "./preview.js";
type Data = Record<string, unknown>;

export function createDocumentProfiles(helpers: ProfileHelpers) {
  const { describeToolRun, appendDataRowsTable, appendMarkdownSection } = helpers;

function appendDownloadProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (toolName === "save_file") {
    const content = saveFileContentText(args);
    const title = data.filename || args.filename || t("file");
    presentation.appendCompactLine(parent, {
      title: presentation.basename(title),
      subtitle: data.downloadId ? t("download", { name: String(data.downloadId) }) : "",
      meta: [
        data.size != null ? t("characters", { count: String(data.size) }) : (content ? t("characters", { count: String(content.length) }) : ""),
        data.state,
      ].filter(Boolean),
    });
    appendSaveFileContentPreview(parent, args);
    return true;
  }

  const items = Array.isArray(result)
    ? result
    : Array.isArray(data.downloads) ? data.downloads
      : Array.isArray(data.items) ? data.items
        : result ? [result] : [];
  if (!items.length) {
    presentation.appendCompactLine(parent, { title: describeToolRun(toolName, args, result, true) });
    return true;
  }
  presentation.appendSlimList(parent, t("file"), items.map(record), item => ({
    title: presentation.basename(item.filename || item.name || item.url || item.fileUrl || item.id || t("file")),
    subtitle: item.url || item.fileUrl || item.finalUrl || item.filename || "",
    meta: [item.state, presentation.formatBytesProgress(item), presentation.formatDateLike(item.endTime || item.startTime || item.createdAt)].filter(Boolean),
  }));
  return true;
}

function appendDocumentProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (!result) return false;

  const items = Array.isArray(result)
    ? result
    : Array.isArray(data.artifacts) ? data.artifacts
      : Array.isArray(data.items) ? data.items
        : null;
  if (items) {
    appendDocumentList(parent, toolName === "document_list_artifacts" ? t("documentArtifacts") : t("document"), items);
    return true;
  }

  if (typeof result !== "object") return false;

  if (toolName === "document_download") {
    presentation.appendSlimList(parent, t("downloadSection"), [data], item => ({
      title: presentation.basename(item.filename || args.filename || t("file")),
      subtitle: item.url || item.filename || "",
      meta: [item.state, item.downloadId || item.id ? `ID ${item.downloadId || item.id}` : ""].filter(Boolean),
    }));
    return true;
  }

  if (toolName === "document_read_chunk" && Array.isArray(data.rows)) {
    presentation.appendCompactLine(parent, {
      title: data.sheetName || args.sheetName || data.title || t("sheet"),
      subtitle: data.docModelId || args.docModelId || "",
      meta: [
        data.type,
        data.tableId,
        data.totalRows != null ? t("rows", { count: String(data.totalRows) }) : "",
        data.offset != null ? `offset ${data.offset}` : "",
        data.limit != null ? `limit ${data.limit}` : "",
        Array.isArray(data.columns) ? t("columns", { count: String(data.columns.length) }) : "",
      ].filter(Boolean),
    });
    if (data.rows.length) appendDataRowsTable(parent, String(data.sheetName || t("tableContent")), data.rows);
    return true;
  }

  if (toolName === "document_read_chunk" && (data.text || data.content || Array.isArray(data.blocks))) {
    return appendDocumentTextChunkProfile(parent, args, data);
  }

  const title = documentResultTitle(toolName, args, data);
  presentation.appendCompactLine(parent, {
    title,
    subtitle: data.sourceUrl || data.fileId || data.docModelId || data.artifactId || args.url || args.docModelId || "",
    meta: documentResultMeta(toolName, data),
  });

  if (Array.isArray(data.sheets) && data.sheets.length) {
    presentation.appendSlimList(parent, t("sheet"), data.sheets, sheet => ({
      title: sheet.name || "Sheet",
      subtitle: Array.isArray(sheet.columns) ? sheet.columns.slice(0, 8).join(" / ") : "",
      meta: [sheet.rowCount != null ? t("rows", { count: String(sheet.rowCount) }) : "", Array.isArray(sheet.columns) ? t("columns", { count: String(sheet.columns.length) }) : ""].filter(Boolean),
    }));
  }

  if (Array.isArray(data.outline) && data.outline.length) {
    presentation.appendSlimList(parent, t("contents"), data.outline.slice(0, 8), item => ({
      title: typeof item === "string" ? item : item.text || item.title || presentation.summarizeValue(item, 80),
      meta: [item.level ? `H${item.level}` : ""].filter(Boolean),
    }));
  }

  if (toolName === "document_read_chunk" && data.text) {
    presentation.appendTextSection(parent, t("contentPreview"), data.text);
  }

  if (Array.isArray(data.blocks) && data.blocks.length && !data.text) {
    presentation.appendSlimList(parent, t("chunks"), data.blocks.slice(0, 8), block => ({
      title: block.text || block.title || block.type || presentation.summarizeValue(block, 100),
      meta: [block.type].filter(Boolean),
    }));
  }

  if (data.downloaded) {
    presentation.appendSlimList(parent, t("downloadSection"), [record(data.downloaded)], item => ({
      title: presentation.basename(item.filename || data.filename || t("file")),
      subtitle: item.url || item.filename || "",
      meta: [item.state, item.downloadId || item.id ? `ID ${item.downloadId || item.id}` : ""].filter(Boolean),
    }));
  }

  if (data.note) presentation.appendNoteSection(parent, t("notice"), presentation.summarizeValue(data.note, 260));
  return true;
}

function appendDocumentTextChunkProfile(parent: HTMLElement, args: Data = {}, result: Data = {}) {
  const progress = documentChunkProgress(args, result);
  const title = progress.total
    ? t("contentChunk", { index: String(progress.displayIndex), total: String(progress.total) })
    : documentResultTitle("document_read_chunk", args, result);
  const text = result.content || result.text || blocksToText(result.blocks);
  presentation.appendCompactLine(parent, {
    title,
    subtitle: [
      result.title || args.title || "",
      text ? t("textCharacterCount", { count: String(String(text).length) }) : "",
      result.docModelId || args.docModelId || "",
    ].filter(Boolean).join(" · "),
    meta: [
      result.type,
      result.offset != null ? `offset ${result.offset}` : "",
      result.limit != null ? `limit ${result.limit}` : "",
    ].filter(Boolean),
  });
  if (text && result.contentFormat === "markdown") appendMarkdownSection(parent, t("contentPreview"), text);
  else if (text) presentation.appendTextSection(parent, t("contentPreview"), text);
  else if (Array.isArray(result.blocks) && result.blocks.length) {
    presentation.appendSlimList(parent, t("chunks"), result.blocks.slice(0, 8), block => ({
      title: block.text || block.title || block.type || presentation.summarizeValue(block, 100),
      meta: [block.type].filter(Boolean),
    }));
  }
  if (Array.isArray(result.tables) && result.tables.length) {
    presentation.appendSlimList(parent, t("table"), result.tables, table => ({
      title: table.name || table.sheetName || table.tableId || t("table"),
      subtitle: Array.isArray(table.columns) ? table.columns.join(" / ") : "",
      meta: [table.tableId, table.totalRows != null ? t("rows", { count: String(table.totalRows) }) : "", table.columnCount != null ? t("columns", { count: String(table.columnCount) }) : ""].filter(Boolean),
    }));
  }
  return true;
}

function documentChunkProgress(args: Data = {}, result: Data = {}) {
  const chunk = result.chunk && typeof result.chunk === "object" ? record(result.chunk) : null;
  if (chunk) {
    const index = Math.max(0, Number(chunk.index ?? chunk.chunkIndex) || 0);
    return {
      displayIndex: index + 1,
      total: Math.max(0, Number(chunk.total ?? chunk.totalChunks) || 0),
    };
  }
  return {
    displayIndex: result.chunkIndex ?? args.chunkIndex ?? 0,
    total: result.totalChunks ?? result.chunkCount ?? "",
  };
}

function blocksToText(blocks: unknown) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map(block => typeof block === "string" ? block : (block?.text || block?.title || ""))
    .filter(Boolean)
    .join("\n\n");
}

function appendDocumentList(parent: HTMLElement, title: string, items: unknown[]) {
  presentation.appendSlimList(parent, title, items.map(record), item => ({
    title: item.filename || item.title || item.name || item.artifactId || item.fileId || item.docModelId || t("document"),
    subtitle: item.sourceUrl || item.docModelId || item.fileId || item.artifactId || "",
    meta: [
      item.format || item.extension || item.type || item.mimeType,
      item.size ? presentation.formatBytes(item.size) : "",
      item.blockCount != null ? t("blocks", { count: String(item.blockCount) }) : "",
      item.sheetCount != null ? t("tables", { count: String(item.sheetCount) }) : "",
      item.chunkCount != null ? t("chunkCount", { count: String(item.chunkCount) }) : "",
      presentation.formatDateLike(item.updatedAt || item.createdAt),
    ].filter(Boolean),
  }));
}

function documentResultTitle(toolName: string, args: Data = {}, result: Data = {}) {
  if (result.filename) return result.filename;
  if (result.title) return result.title;
  if (result.sheetName) return result.sheetName;
  if (toolName === "document_fetch") return presentation.basename(args.url || t("documentFetched"));
  if (toolName === "document_parse") return t("documentParsed");
  if (toolName === "document_read_chunk") {
    const progress = documentChunkProgress(args, result);
    return t("documentChunk", { index: String(progress.displayIndex) });
  }
  if (toolName === "document_create") return args.filename || args.title || t("documentCreated");
  if (toolName === "document_download") return args.filename || t("documentDownloaded");
  return describeToolRun(toolName, args, result, true);
}

function documentResultMeta(_toolName: string, result: Data = {}) {
  return [
    result.format || result.extension || result.type || result.mimeType,
    result.size ? presentation.formatBytes(result.size) : "",
    result.fileId ? `file ${presentation.summarizeValue(result.fileId, 28)}` : "",
    result.docModelId ? `model ${presentation.summarizeValue(result.docModelId, 28)}` : "",
    result.artifactId ? `artifact ${presentation.summarizeValue(result.artifactId, 28)}` : "",
    result.blockCount != null ? t("blocks", { count: String(result.blockCount) }) : "",
    result.sheetCount != null ? t("tables", { count: String(result.sheetCount) }) : "",
    result.chunkCount != null ? t("chunkCount", { count: String(result.chunkCount) }) : "",
    result.downloaded ? t("addedToDownloads") : "",
    presentation.formatDateLike(result.updatedAt || result.createdAt),
  ].filter(Boolean);
}

  return { renderDownload: appendDownloadProfile, renderDocument: appendDocumentProfile };
}
