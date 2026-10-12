import { t } from "../i18n/backend.js";
import type { DocumentBlock, DocumentContent } from "./document-codec-registry.js";
interface ProjectionModel extends DocumentContent { id?: unknown; type?: string; chunkSize?: unknown }
export interface DocumentReadQuery { tableId?: unknown; sheetName?: unknown; chunkIndex?: unknown; offset?: unknown; limit?: unknown }
interface DocumentTable {
  tableId: string;
  kind: "sheet" | "block";
  name: string;
  sheetName?: string;
  blockIndex?: number;
  columns: string[];
  rows: unknown[];
}
interface MarkdownUnit { text: string; tableId?: string }

const DEFAULT_CHUNK_SIZE = 6000;
const MIN_CHUNK_SIZE = 1000;
const MAX_CHUNK_SIZE = 50000;
const DEFAULT_TABLE_LIMIT = 50;
const MAX_TABLE_LIMIT = 200;
const TABLE_RESULT_CHAR_BUDGET = 120000;
const TABLE_COLUMN_PREVIEW_LIMIT = 30;

export class DocumentReadProjectionError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DocumentReadProjectionError";
  }
}

export function normalizeDocumentChunkSize(value: unknown) {
  return clampInteger(value, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
}

/**
 * Projects a stored docModel into one bounded wire representation.
 * Narrative documents return Markdown; tabular documents return structured rows.
 */
export function projectDocumentRead(model: ProjectionModel = {}, query: DocumentReadQuery = {}) {
  const tableId = String(query.tableId || "").trim();
  const sheetName = String(query.sheetName || "").trim();
  if (tableId || sheetName || shouldDefaultToTable(model)) {
    const table = resolveDocumentTable(model, { tableId, sheetName });
    if (!table) throw tableNotFoundError(model, { tableId, sheetName });
    return projectDocumentTable(model, table, query);
  }
  return projectDocumentContent(model, query);
}

export function projectDocumentContent(model: ProjectionModel = {}, { chunkIndex = 0 }: DocumentReadQuery = {}) {
  const chunks = buildDocumentContentChunks(model.blocks, {
    chunkSize: model.chunkSize,
  });
  const requestedIndex = Math.max(0, Math.floor(Number(chunkIndex) || 0));
  if (!chunks.length) {
    if (requestedIndex > 0) throw chunkNotFoundError(model, requestedIndex, 0);
    return {
      docModelId: String(model.id || ""),
      type: String(model.type || "document"),
      title: String(model.title || ""),
      mode: "content",
      contentFormat: "markdown",
      content: "",
      chunk: { index: 0, total: 0, chars: 0 },
      tables: [],
    };
  }
  const selected = chunks[requestedIndex];
  if (!selected) throw chunkNotFoundError(model, requestedIndex, chunks.length);
  const tables = selected.tableIds
    .map(tableId => resolveDocumentTable(model, { tableId }))
    .filter(table => table !== null)
    .map(publicTableSummary);
  return {
    docModelId: String(model.id || ""),
    type: String(model.type || "document"),
    title: String(model.title || ""),
    mode: "content",
    contentFormat: "markdown",
    content: selected.content,
    chunk: {
      index: selected.index,
      total: chunks.length,
      chars: selected.content.length,
    },
    tables,
    ...(selected.index + 1 < chunks.length ? { next: { chunkIndex: selected.index + 1 } } : {}),
  };
}

export function projectDocumentTable(model: ProjectionModel = {}, table: DocumentTable, { offset = 0, limit = DEFAULT_TABLE_LIMIT }: DocumentReadQuery = {}) {
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const pageLimit = clampInteger(limit, 1, MAX_TABLE_LIMIT, DEFAULT_TABLE_LIMIT);
  const allRows = Array.isArray(table?.rows) ? table.rows : [];
  const candidates = allRows.slice(start, start + pageLimit);
  const rows = fitTableRowsToBudget(candidates, {
    docModelId: model.id,
    tableId: table?.tableId,
    columns: table?.columns,
    offset: start,
    totalRows: allRows.length,
  });
  const nextOffset = start + rows.length;
  const hasMore = nextOffset < allRows.length;
  return {
    docModelId: String(model.id || ""),
    type: String(model.type || "document"),
    title: String(model.title || ""),
    mode: "table",
    tableId: String(table?.tableId || ""),
    ...(table?.sheetName ? { sheetName: table.sheetName } : {}),
    ...(table?.name ? { tableName: table.name } : {}),
    columns: Array.isArray(table?.columns) ? table.columns : [],
    offset: start,
    limit: pageLimit,
    totalRows: allRows.length,
    rows,
    ...(hasMore ? {
      next: {
        tableId: String(table?.tableId || ""),
        offset: nextOffset,
        limit: pageLimit,
      },
    } : {}),
  };
}

export function listDocumentTables(model: ProjectionModel = {}): DocumentTable[] {
  const tables: DocumentTable[] = [];
  const sheets = Array.isArray(model.sheets) ? model.sheets : [];
  sheets.forEach((sheet, index) => {
    tables.push({
      tableId: `sheet:${index}`,
      kind: "sheet",
      sheetName: String(sheet?.name || `Sheet${index + 1}`),
      name: String(sheet?.name || `Sheet${index + 1}`),
      columns: Array.isArray(sheet?.columns) ? sheet.columns : [],
      rows: Array.isArray(sheet?.rows) ? sheet.rows : [],
    });
  });

  // XLSX/CSV parsers historically mirrored sheets into blocks. Treat sheets as
  // authoritative so old persisted models do not expose every table twice.
  if (sheets.length && ["xlsx", "csv"].includes(String(model.type || "").toLowerCase())) return tables;

  const blocks = Array.isArray(model.blocks) ? model.blocks : [];
  blocks.forEach((block, blockIndex) => {
    if (block?.type !== "table") return;
    tables.push({
      tableId: `table:${blockIndex}`,
      kind: "block",
      blockIndex,
      name: String(block.name || `Table ${blockIndex + 1}`),
      columns: Array.isArray(block.columns) ? block.columns : [],
      rows: Array.isArray(block.rows) ? block.rows : [],
    });
  });
  return tables;
}

export function resolveDocumentTable(model: ProjectionModel = {}, { tableId = "", sheetName = "" }: DocumentReadQuery = {}) {
  const tables = listDocumentTables(model);
  const id = String(tableId || "").trim();
  if (id) return tables.find(table => table.tableId === id) || null;
  const query = String(sheetName || "").trim().toLowerCase();
  if (!query) return tables.find(table => table.kind === "sheet") || tables[0] || null;
  return tables.find(table => String(table.sheetName || "").toLowerCase() === query)
    || tables.find(table => String(table.sheetName || "").toLowerCase().includes(query))
    || null;
}

/** Builds deterministic narrative chunks without exposing structured blocks. */
export function buildDocumentContentChunks(blocks: readonly DocumentBlock[] = [], { chunkSize = DEFAULT_CHUNK_SIZE }: { chunkSize?: unknown } = {}) {
  const maxChars = normalizeDocumentChunkSize(chunkSize);
  const units: MarkdownUnit[] = [];
  for (const [blockIndex, block] of (Array.isArray(blocks) ? blocks : []).entries()) {
    units.push(...markdownUnitsForBlock(block, blockIndex, maxChars));
  }
  const chunks: { index: number; content: string; tableIds: string[] }[] = [];
  let parts: string[] = [];
  let chars = 0;
  let tableIds = new Set<string>();

  const flush = () => {
    if (!parts.length) return;
    const content = parts.join("\n\n");
    chunks.push({
      index: chunks.length,
      content,
      tableIds: [...tableIds],
    });
    parts = [];
    chars = 0;
    tableIds = new Set<string>();
  };

  for (const unit of units) {
    const separator = parts.length ? 2 : 0;
    if (parts.length && chars + separator + unit.text.length > maxChars) flush();
    parts.push(unit.text);
    chars += (parts.length > 1 ? 2 : 0) + unit.text.length;
    if (unit.tableId) tableIds.add(unit.tableId);
  }
  flush();
  return chunks;
}

function markdownUnitsForBlock(block: DocumentBlock, blockIndex: number, maxChars: number): MarkdownUnit[] {
  if (!block || typeof block !== "object") return [];
  if (block.type === "table") {
    const tableId = `table:${blockIndex}`;
    const columns = Array.isArray(block.columns) ? block.columns : [];
    const rows = Array.isArray(block.rows) ? block.rows : [];
    const name = escapeMarkdownInline(block.name || t("document.tableTitle", { index: String(blockIndex + 1) }));
    const text = t("document.tableSummary", { name: String(name), id: String(tableId), rows: String(rows.length), columns: String(columns.length), tableId: String(tableId) });
    return splitMarkdown(text, maxChars).map((part, index) => ({
      text: part,
      tableId: index === 0 ? tableId : "",
    }));
  }
  if (block.type === "code") return codeMarkdownUnits(block, maxChars);

  let markdown = "";
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(6, Number(block.level) || 1));
    markdown = `${"#".repeat(level)} ${escapeMarkdownInline(block.text || "")}`.trim();
  } else if (block.type === "list") {
    markdown = listToMarkdown(block.items, Boolean(block.ordered));
  } else if (block.type === "link") {
    markdown = linkToMarkdown(block.text || block.url || "", block.url || "");
  } else if (block.type === "image") {
    const label = block.caption || block.alt || t("document.image");
    markdown = block.url ? linkToMarkdown(t("document.imageLabel", { label: String(label) }), block.url) : escapeMarkdownParagraph(label);
  } else {
    markdown = escapeMarkdownParagraph(block.text ?? block.content ?? "");
  }
  return splitMarkdown(markdown, maxChars).map(text => ({ text }));
}

function codeMarkdownUnits(block: DocumentBlock, maxChars: number): MarkdownUnit[] {
  const source = String(block.text ?? block.content ?? "");
  const language = String(block.language || "").replace(/[^a-z0-9_+.-]/gi, "").slice(0, 40);
  const fence = codeFenceFor(source);
  const overhead = fence.length * 2 + language.length + 3;
  if (overhead >= maxChars) {
    return splitMarkdown(escapeMarkdownParagraph(source), maxChars).map(text => ({ text }));
  }
  const bodyLimit = Math.max(120, maxChars - overhead);
  return splitCodeText(source, bodyLimit).map(part => ({
    text: `${fence}${language}\n${part}\n${fence}`,
  }));
}

function codeFenceFor(source: string) {
  const backticks = longestMarkerRun(source, "`");
  const tildes = longestMarkerRun(source, "~");
  const marker = backticks <= tildes ? "`" : "~";
  const length = Math.max(3, Math.min(backticks, tildes) + 1);
  return marker.repeat(length);
}

function longestMarkerRun(source: string, marker: string) {
  let longest = 0;
  let current = 0;
  for (const char of String(source || "")) {
    current = char === marker ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function listToMarkdown(items: unknown = [], ordered = false, depth = 0): string {
  const rows: string[] = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const value = typeof item === "string" ? { text: item, children: [] } : (item || {});
    const marker = ordered ? `${index + 1}.` : "-";
    rows.push(`${"  ".repeat(depth)}${marker} ${escapeMarkdownInline(value.text || "")}`.trimEnd());
    if (Array.isArray(value.children) && value.children.length) {
      rows.push(listToMarkdown(value.children, ordered, depth + 1));
    }
  });
  return rows.filter(Boolean).join("\n");
}

function linkToMarkdown(text: unknown, url: unknown) {
  const label = escapeMarkdownInline(text || url || t("document.link"));
  const target = String(url || "").trim();
  if (!/^(?:https?:|mailto:)/i.test(target)) {
    return [label, escapeMarkdownParagraph(target)].filter(Boolean).join("（") + (target ? "）" : "");
  }
  const encoded = encodeURI(target).replace(/</g, "%3C").replace(/>/g, "%3E");
  return `[${label}](<${encoded}>)`;
}

function escapeMarkdownParagraph(value: unknown) {
  return String(value || "")
    .split(/\r?\n/)
    .map(line => escapeMarkdownInline(line).replace(/^(\s*)(#{1,6}|>|[-+] |\d+[.)] )/, "$1\\$2"))
    .join("\n")
    .trim();
}

function escapeMarkdownInline(value: unknown) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_\[\]~])/g, "\\$1");
}

function splitMarkdown(value: unknown, maxChars: number) {
  const text = String(value || "").trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxChars) {
    const searchStart = Math.floor(maxChars * 0.55);
    const window = rest.slice(searchStart, maxChars + 1);
    const relative = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      lastSentenceBoundary(window),
      window.lastIndexOf(" "),
    );
    const end = relative >= 0 ? searchStart + relative + 1 : maxChars;
    const part = rest.slice(0, end).trim();
    if (part) parts.push(part);
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function splitCodeText(value: unknown, maxChars: number) {
  const text = String(value || "");
  if (!text) return [""];
  if (text.length <= maxChars) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end);
      if (newline >= start + Math.floor(maxChars * 0.55)) end = newline + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function lastSentenceBoundary(value: string) {
  let index = -1;
  const pattern = /[.!?。！？；;]\s/g;
  let match;
  while ((match = pattern.exec(value))) index = match.index + 1;
  return index;
}

function publicTableSummary(table: DocumentTable) {
  const columns = Array.isArray(table.columns) ? table.columns : [];
  return {
    tableId: table.tableId,
    ...(table.sheetName ? { sheetName: table.sheetName } : {}),
    ...(table.name ? { name: table.name } : {}),
    columns: columns.slice(0, TABLE_COLUMN_PREVIEW_LIMIT),
    columnCount: columns.length,
    totalRows: Array.isArray(table.rows) ? table.rows.length : 0,
  };
}

function fitTableRowsToBudget<T>(rows: readonly T[], metadata: unknown): T[] {
  const selected = [];
  const baseChars = safeJsonLength(metadata);
  let chars = baseChars;
  for (const row of rows) {
    const rowChars = safeJsonLength(row) + 1;
    if (selected.length && chars + rowChars > TABLE_RESULT_CHAR_BUDGET) break;
    selected.push(row);
    chars += rowChars;
  }
  return selected;
}

function safeJsonLength(value: unknown) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return TABLE_RESULT_CHAR_BUDGET;
  }
}

function shouldDefaultToTable(model: ProjectionModel) {
  const type = String(model?.type || "").toLowerCase();
  return ["xlsx", "csv"].includes(type) && Array.isArray(model?.sheets) && model.sheets.length > 0;
}

function tableNotFoundError(model: ProjectionModel, query: DocumentReadQuery) {
  const tables = listDocumentTables(model);
  const legacySheetLookup = !query.tableId && Boolean(query.sheetName);
  const availableTables = tables.map(table => ({
    tableId: table.tableId,
    sheetName: table.sheetName || "",
  }));
  return new DocumentReadProjectionError(
    legacySheetLookup ? "DOCUMENT_SHEET_NOT_FOUND" : "DOCUMENT_TABLE_NOT_FOUND",
    query.tableId ? `Table not found: ${query.tableId}` : `Sheet not found: ${query.sheetName || "(default)"}`,
    {
      docModelId: model?.id || "",
      tableId: query.tableId || "",
      sheetName: query.sheetName || "",
      availableTables,
      ...(legacySheetLookup ? {
        availableSheets: availableTables.map(table => table.sheetName).filter(Boolean),
      } : {}),
    },
  );
}

function chunkNotFoundError(model: ProjectionModel, chunkIndex: number, total: number) {
  return new DocumentReadProjectionError(
    "DOCUMENT_CHUNK_NOT_FOUND",
    `Document chunk not found: ${chunkIndex}`,
    { docModelId: model?.id || "", chunkIndex, totalChunks: total },
  );
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
