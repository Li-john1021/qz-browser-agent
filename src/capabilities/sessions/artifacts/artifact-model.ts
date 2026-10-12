import { getLocale } from "#sdk/shared/i18n";
import { t } from "../i18n.js";
import messages from "../messages.js";
import { stringSessionId as normalizeSessionId } from "#sdk/sidepanel/sessions";
import type { TranscriptEntry } from "#sdk/sidepanel/presentation";
import { record as objectOrEmpty } from "#sdk/sidepanel/presentation";
import type { UiEvent as PortMessage } from "#sdk/sidepanel";
type Fields = Record<string, unknown>;
/** Read model: merging richer data must retain the user's existing ordering anchor. */
export interface ArtifactItem extends Fields {
  id: string; title?: string; type?: string; kind?: string; kindLabel?: string; table?: string; meta?: string;
  count?: number; totalRows?: number; rowCount?: number; columns?: unknown[]; action?: string; score?: number;
  format?: string; downloadId?: string; artifactId?: string; fileId?: string; url?: string;
  updatedAt?: string; timeMs?: number; sortUpdatedAt?: string; sortTimeMs?: number; timeLabel?: string; fullTimeLabel?: string;
}
export interface ArtifactSummary { sessionId: string; data: ArtifactItem[]; files: ArtifactItem[]; total: number; signature: string }
type ArtifactMap = Map<string, ArtifactItem>;
interface ArtifactModelOptions {
  getTranscript?(sessionId: string): TranscriptEntry[];
  request(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
}

import {
  resolveArtifactUpdatedAt, artifactTimeMs, normalizeDataArtifactKey,
  positiveArtifactNumber, artifactFileExtension, fileArtifactDownloadId, fileArtifactUrl,
  artifactToolTime as resolveToolArtifactTime, artifactFormatBytes as formatBytes,
  projectFileArtifact, findFileArtifactMergeKey,
} from "#sdk/shared/artifacts";
import { projectToolArtifacts, isIntermediateArtifact } from "#sdk/shared/catalog";
import { enrichSkillToolIdentity } from "#sdk/sidepanel/skills";
import { timelineGroupTools } from "#sdk/sidepanel/presentation";
import { hashText } from "#sdk/sidepanel/dom";

// Older summaries stored display labels instead of a stable kind. Keep those inputs readable
// when labels are shortened or the user changes language; these strings are never displayed.
const legacyImageCollectionLabels = new Set([
  "图集", "圖集", "Image collection", "画像コレクション", "이미지 모음",
  "Colección de imágenes", "Collection d’images", "Bildersammlung", "Coleção de imagens",
  "Подборка изображений", "مجموعة صور", "इमेज संग्रह",
]);

export function createArtifactModel(options: ArtifactModelOptions) {
  const getTranscript = options.getTranscript || (() => []);
  const request = options.request;
  if (typeof request !== "function") throw new Error("artifact request adapter is required");

function collectSessionArtifacts(sessionId: unknown, history: TranscriptEntry[] | null = null): ArtifactSummary {
  const id = normalizeSessionId(sessionId);
  const source = Array.isArray(history) ? history : getTranscript(id);
  const data: ArtifactMap = new Map();
  const files: ArtifactMap = new Map();

  for (const tool of flattenArtifactToolEntries(source)) {
    if (!tool || tool.isError || tool.isRunning) continue;
    const name = toolCapabilityName(tool);
    const args = objectOrEmpty(tool.args);
    const result = objectOrEmpty(tool.result);
    const toolTime = resolveToolArtifactTime(tool);
    collectExplicitArtifacts(data, files, projectToolArtifacts(name, args, result, "display"), toolTime);
  }

  const dataItems = Array.from(data.values());
  const fileItems = Array.from(files.values());
  const total = dataItems.length + fileItems.length;
  return {
    sessionId: id,
    data: dataItems,
    files: fileItems,
    total,
    signature: createArtifactsSignature({ data: dataItems, files: fileItems }),
  };
}

async function collectSessionArtifactsWithRuntime(sessionId: unknown, history: TranscriptEntry[] | null = null) {
  const id = normalizeSessionId(sessionId);
  if (!id) return emptyArtifactSummary("");
  const transcriptSummary = collectSessionArtifacts(id, history);
  try {
    const runtimeSummary = await fetchRuntimeArtifactSummary(id);
    return mergeArtifactSummaries(id, transcriptSummary, runtimeSummary);
  } catch (_err) {
    return transcriptSummary;
  }
}

async function fetchRuntimeArtifactSummary(sessionId = "") {
  const id = normalizeSessionId(sessionId);
  if (!id) return emptyArtifactSummary("");
  const event = await request("get_session_artifacts", { sessionId: id }, 4000);
  return buildArtifactSummaryFromRuntimeArtifacts(id, event?.artifacts || null);
}

function buildArtifactSummaryFromRuntimeArtifacts(sessionId = "", input: unknown = null) {
  const artifacts = objectOrEmpty(input);
  const id = normalizeSessionId(sessionId);
  const data: ArtifactMap = new Map();
  const files: ArtifactMap = new Map();
  const dataItems = [
    ...(Array.isArray(artifacts?.imageCollections) ? artifacts.imageCollections.map(item => ({ ...objectOrEmpty(item), type: "imageCollection" })) : []),
    ...(Array.isArray(artifacts?.dataTables) ? artifacts.dataTables : []),
  ];
  const fileItems = Array.isArray(artifacts?.files) ? artifacts.files : [];
  for (const item of dataItems) collectRuntimeDataArtifact(data, item);
  for (const item of fileItems) collectRuntimeFileArtifact(files, item);
  return createArtifactSummary(id, data, files);
}

function collectRuntimeDataArtifact(map: ArtifactMap, input: unknown = {}) {
  const item = objectOrEmpty(input);
  const table = normalizeDataArtifactKey(item.table || item.title || item.id || "");
  if (!table) return;
  const rowCount = maxPositiveArtifactNumber(item.totalRows, item.rowCount, item.count);
  const columns = Array.isArray(item.columns) ? item.columns : [];
  const kind = dataArtifactKind(item);
  const kindLabel = dataArtifactKindLabel(item);
  const next = withArtifactTime({
    id: table,
    type: "data",
    kind,
    kindLabel,
    title: normalizeDataArtifactKey(item.title || table),
    table,
    meta: String(item.meta || formatDataArtifactMeta({ ...item, kind, kindLabel }, rowCount, columns.length)),
    count: rowCount,
    totalRows: rowCount,
    rowCount,
    columns,
    action: String(item.action || ""),
    score: Number(item.score || (rowCount > 0 || columns.length > 0 ? 3 : 1)),
  }, item, item.updatedAt || item.createdAt || "");
  upsertArtifactItem(map, table, next);
}

function collectRuntimeFileArtifact(map: ArtifactMap, input: unknown = {}) {
  const item = objectOrEmpty(input);
  const filename = String(item.filename || item.title || filenameFromUrl(item.url || "") || "").trim();
  if (!filename) return;
  const downloadId = fileArtifactDownloadId(item);
  const url = fileArtifactUrl(item);
  if (!downloadId && !url) return;
  upsertFileArtifact(map, {
    id: downloadId ? `download:${downloadId}` : (url ? `url:${url}` : `file:${filename}`),
    title: String(item.title || filename),
    meta: String(item.meta || item.summary || formatFileMeta(filename, {
      size: item.size,
      sizeLabel: item.sizeLabel,
      format: item.format,
      downloadId,
      artifactId: item.artifactId,
      fileId: item.fileId,
    })),
    format: String(item.format || artifactFileExtension(filename)),
    downloadId,
    artifactId: String(item.artifactId || ""),
    fileId: String(item.fileId || ""),
    url,
    score: Number(item.score || 2),
  }, item, item.updatedAt || item.createdAt || "");
}

function mergeArtifactSummaries(sessionId = "", ...summaries: (Partial<ArtifactSummary> | null | undefined)[]) {
  const id = normalizeSessionId(sessionId);
  const data: ArtifactMap = new Map();
  const files: ArtifactMap = new Map();
  for (const summary of summaries) {
    if (!summary || typeof summary !== "object") continue;
    for (const item of Array.isArray(summary.data) ? summary.data : []) {
      const normalized = normalizeArtifactSummaryDataItem(item);
      if (normalized) upsertArtifactItem(data, normalized.id, normalized, { preserveSort: true });
    }
    for (const item of Array.isArray(summary.files) ? summary.files : []) {
      const normalized = normalizeArtifactSummaryFileItem(item);
      if (normalized) upsertArtifactItem(files, normalized.id, normalized, { preserveSort: true });
    }
  }
  return createArtifactSummary(id, data, files);
}

function normalizeArtifactSummaryDataItem(value: unknown = {}): ArtifactItem | null {
  const item = objectOrEmpty(value);
  if (!item || typeof item !== "object") return null;
  const id = normalizeDataArtifactKey(item.id || item.table || item.title || "");
  if (!id) return null;
  const count = maxPositiveArtifactNumber(item.count, item.totalRows, item.rowCount);
  const columns = Array.isArray(item.columns) ? item.columns : [];
  const kindLabel = dataArtifactKindLabel(item);
  return {
    ...item,
    id,
    type: "data",
    kind: dataArtifactKind(item),
    kindLabel,
    title: normalizeDataArtifactKey(item.title || item.table || id),
    meta: String(item.meta || formatDataArtifactMeta({ ...item, kindLabel }, count, columns.length)),
    count,
    totalRows: positiveArtifactNumber(item.totalRows) || count,
    rowCount: positiveArtifactNumber(item.rowCount) || count,
  };
}

function normalizeArtifactSummaryFileItem(value: unknown = {}): ArtifactItem | null {
  const item = objectOrEmpty(value);
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || item.downloadId || item.artifactId || item.fileId || item.url || item.title || "").trim();
  if (!id) return null;
  if (!isDownloadableFileArtifact(item)) return null;
  return {
    ...item,
    id,
    type: "file",
    kindLabel: t("file"),
    downloadId: fileArtifactDownloadId(item),
    url: fileArtifactUrl(item),
  };
}

function createArtifactSummary(sessionId = "", dataMap: ArtifactMap = new Map(), fileMap: ArtifactMap = new Map()): ArtifactSummary {
  const id = normalizeSessionId(sessionId);
  const dataItems = Array.from(dataMap.values()).sort(compareArtifactItems);
  const fileItems = Array.from(fileMap.values()).sort(compareArtifactItems);
  const total = dataItems.length + fileItems.length;
  return {
    sessionId: id,
    data: dataItems,
    files: fileItems,
    total,
    signature: createArtifactsSignature({ data: dataItems, files: fileItems }),
  };
}

function emptyArtifactSummary(sessionId = "") {
  return createArtifactSummary(sessionId, new Map(), new Map());
}

function flattenArtifactToolEntries(history: TranscriptEntry[] = []) {
  const out = [];
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "tool") {
      out.push(entry);
      continue;
    }
    if (entry.type === "tool-group") {
      out.push(...timelineGroupTools(entry));
    }
  }
  return out;
}

function collectExplicitArtifacts(dataMap: ArtifactMap, fileMap: ArtifactMap, artifacts: Fields[], fallbackTime: unknown = "") {
  for (const item of artifacts) {
    collectExplicitArtifactItem(dataMap, fileMap, item, fallbackTime);
  }
}

function collectExplicitArtifactItem(dataMap: ArtifactMap, fileMap: ArtifactMap, item: Fields = {}, fallbackTime: unknown = "") {
  if (isIntermediateArtifact(item, toolCapabilityName)) return;
  const type = String(item.type || item.kind || "").trim().toLowerCase();
  if (type === "data" || type === "table" || item.table || item.totalRows != null || item.rowCount != null) {
    collectExplicitDataArtifact(dataMap, item, fallbackTime);
    return;
  }
  if (type === "file" || type === "download" || type === "document" || item.filename || item.url || item.fileUrl || item.finalUrl) {
    collectExplicitFileArtifact(fileMap, item, fallbackTime);
  }
}

function toolCapabilityName(toolOrName: unknown = "") {
  const tool = toolOrName && typeof toolOrName === "object" && !Array.isArray(toolOrName)
    ? objectOrEmpty(toolOrName)
    : { name: String(toolOrName || "").trim() };
  const identified = enrichSkillToolIdentity({ ...tool, name: String(tool.name || "") });
  return String(identified?.capabilityId || identified?.name || "").trim();
}

function isImageCollectionDataArtifact(item: Fields = {}) {
  const kind = String(item.kind || "").trim();
  if (kind === "image_collection" || item.type === "imageCollection") return true;
  if (kind === "data_table" || item.type === "dataTable") return false;
  const kindLabel = String(item.kindLabel || item.typeLabel || "").trim();
  // Legacy labels are input compatibility only; normalized items retain a stable kind.
  return kindLabel === t("imageCollection") || legacyImageCollectionLabels.has(kindLabel)
    || Object.values(messages.messages.imageCollection).some(label => label === kindLabel);
}

function dataArtifactKind(item: Fields = {}) {
  return isImageCollectionDataArtifact(item) ? "image_collection" : "data_table";
}

function dataArtifactKindLabel(item: Fields = {}) {
  return t(isImageCollectionDataArtifact(item) ? "imageCollection" : "dataTable");
}

function formatDataArtifactMeta(item: Fields = {}, rowCount: unknown = 0, columnCount: unknown = 0) {
  const count = positiveArtifactNumber(rowCount);
  if (count > 0) return t(isImageCollectionDataArtifact(item) ? "imageCount" : "rowCount", { count });
  const columns = positiveArtifactNumber(columnCount);
  return columns > 0 ? t("columns", { count: String(columns) }) : t("referenced");
}

function maxPositiveArtifactNumber(...values: unknown[]) {
  return Math.max(0, ...values.map((value) => (
    Array.isArray(value) ? value.length : positiveArtifactNumber(value)
  )));
}

function collectExplicitDataArtifact(map: ArtifactMap, item: Fields = {}, fallbackTime: unknown = "") {
  const table = normalizeDataArtifactKey(item.table || item.title || item.name || item.id || "");
  if (!table) return;
  const rowsValue = item.totalRows ?? item.totalMatched ?? item.rowCount ?? item.count ?? item.rows;
  const rows = Array.isArray(rowsValue) ? rowsValue.length : Number(rowsValue || 0);
  const columnsValue = item.columns ?? item.columnCount;
  const columns = Array.isArray(columnsValue) ? columnsValue.length : Number(columnsValue || 0);
  const changed = Number(item.changed || 0)
    || Number(item.inserted || 0) + Number(item.updated || 0) + Number(item.replaced || 0) + Number(item.deleted || 0);
  const rowCount = Number.isFinite(rows) && rows > 0 ? rows : Math.max(changed, 0);
  const action = String(item.action || "").trim();
  const score = Number(item.score || (["insert", "upsert", "update", "replace", "delete"].includes(action) ? 3 : (rowCount > 0 || columns > 0 ? 1 : 0)));
  if (score <= 0) return;
  const id = table;
  const next = withArtifactTime({
    id,
    type: "data",
    kind: dataArtifactKind(item),
    kindLabel: dataArtifactKindLabel(item),
    title: normalizeDataArtifactKey(item.title || table),
    meta: String(item.meta || formatDataArtifactMeta(item, rowCount, columns)),
    count: rowCount,
    totalRows: rowCount,
    rowCount,
    action,
    score,
  }, item, fallbackTime);
  upsertArtifactItem(map, id, next);
}

function collectExplicitFileArtifact(map: ArtifactMap, item: Fields = {}, fallbackTime: unknown = "") {
  const file = projectFileArtifact(item, fallbackTime, filenameFromUrl);
  if (!file || !isDownloadableFileArtifact(file)) return;
  upsertFileArtifact(map, {
    ...displayFileArtifact(file, item),
    meta: String(item.meta || formatFileMeta(file.filename, { ...file, artifactId: item.artifactId, fileId: item.fileId })),
    score: Number(item.score || (file.artifactId ? 3 : 2)),
  }, item, fallbackTime);
}

function displayFileArtifact(file: NonNullable<ReturnType<typeof projectFileArtifact>>, source: Fields) {
  return {
    id: file.id, title: file.filename, format: file.format, downloadId: file.downloadId,
    artifactId: String(source.artifactId || ""), fileId: String(source.fileId || ""), url: file.url, score: file.score,
  };
}

function upsertFileArtifact(map: ArtifactMap, item: Partial<ArtifactItem> = {}, source: Fields = {}, fallbackTime: unknown = "") {
  const id = String(item.id || item.title || "").trim();
  if (!id || !item.title) return;
  const next = withArtifactTime({
    type: "file",
    kindLabel: t("file"),
    score: 1,
    ...item,
    id,
  }, source, fallbackTime);
  const key = findFileArtifactMergeKey(map, next, id);
  const existing = map.get(key);
  if (!existing && !isDownloadableFileArtifact(next)) return;
  upsertArtifactItem(map, key, next);
}

function compareArtifactItems(a: ArtifactItem, b: ArtifactItem) {
  const timeDiff = artifactSortTimeMs(b) - artifactSortTimeMs(a);
  if (timeDiff) return timeDiff;
  return String(a.title || "").localeCompare(String(b.title || ""), getLocale());
}

function artifactSortTimeMs(item: Fields = {}) {
  return Number(item?.sortTimeMs || 0)
    || Number(item?.timeMs || 0)
    || artifactTimeMs(item?.sortUpdatedAt || item?.updatedAt || item?.createdAt || "");
}

function createArtifactsSignature(summary: Partial<ArtifactSummary> = {}) {
  const payload = {
    data: (summary.data || []).map(item => [item.id, item.title, item.meta, item.count, item.updatedAt]),
    files: (summary.files || []).map(item => [item.id, item.title, item.meta, item.updatedAt]),
  };
  try {
    return hashText(JSON.stringify(payload));
  } catch(_e) {
    return hashText(String(summary.total || 0));
  }
}

function withArtifactTime<T extends Fields>(item: T, source: Fields = {}, fallbackTime: unknown = "") {
  const updatedAt = resolveArtifactUpdatedAt(source, fallbackTime);
  const timeMs = artifactTimeMs(updatedAt);
  return {
    ...item,
    updatedAt,
    timeMs,
    sortUpdatedAt: updatedAt,
    sortTimeMs: timeMs,
    timeLabel: formatArtifactTimeLabel(updatedAt),
    fullTimeLabel: formatArtifactFullTimeLabel(updatedAt),
  };
}

function upsertArtifactItem(map: ArtifactMap, id: string, next: ArtifactItem, options: { preserveSort?: boolean } = {}) {
  if (!map || !id) return;
  let key = id;
  const existing = map.get(key);
  const merged = mergeArtifactItems(existing, next, options);
  if (merged?.id && merged.id !== key && !map.has(merged.id)) {
    map.delete(key);
    key = merged.id;
  }
  map.set(key, merged);
}

function isDownloadableFileArtifact(item: Fields = {}) {
  return Boolean(fileArtifactDownloadId(item) || fileArtifactUrl(item));
}

function mergeArtifactItems(existing: ArtifactItem | undefined, next: ArtifactItem, { preserveSort = false } = {}) {
  if (!existing) return next;
  const richer = artifactCompletenessScore(next) >= artifactCompletenessScore(existing) ? next : existing;
  const older = richer === next ? existing : next;
  const newest = Number(next.timeMs || 0) >= Number(existing.timeMs || 0) ? next : existing;
  const updatedAt = newest.updatedAt || richer.updatedAt || older.updatedAt || "";
  const existingSortTime = artifactSortTimeMs(existing);
  const nextSortTime = artifactSortTimeMs(next);
  const sortAnchor = preserveSort && existingSortTime ? existing : newest;
  const sortTimeMs = preserveSort && existingSortTime ? existingSortTime : artifactSortTimeMs(sortAnchor) || nextSortTime;
  const sortUpdatedAt = preserveSort && existingSortTime
    ? (existing.sortUpdatedAt || existing.updatedAt || "")
    : (sortAnchor.sortUpdatedAt || sortAnchor.updatedAt || updatedAt);
  const merged: ArtifactItem = {
    ...older,
    ...richer,
    score: Math.max(Number(existing.score || 0), Number(next.score || 0)),
    count: Math.max(Number(existing.count || 0), Number(next.count || 0)) || richer.count || older.count,
    updatedAt,
    timeMs: artifactTimeMs(updatedAt),
    sortUpdatedAt,
    sortTimeMs,
    timeLabel: formatArtifactTimeLabel(updatedAt),
    fullTimeLabel: formatArtifactFullTimeLabel(updatedAt),
  };
  for (const key of ["downloadId", "artifactId", "fileId", "url", "format"]) {
    merged[key] = richer[key] || older[key] || "";
  }
  return merged;
}

function artifactCompletenessScore(item: Fields = {}) {
  let score = Number(item.score || 0) * 10;
  if (item.meta) score += 2;
  if (item.count || item.totalRows) score += 2;
  if (item.downloadId || item.artifactId || item.fileId || item.url) score += 4;
  if (item.format) score += 1;
  if (item.size || item.sizeLabel) score += 1;
  return score;
}

function formatArtifactTimeLabel(value: unknown = "") {
  const text = String(value || "").trim();
  const match = text.match(/^\d{4}-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  return match ? `${match[1]}-${match[2]} ${match[3]}:${match[4]}` : "";
}

function formatArtifactFullTimeLabel(value: unknown = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?::\d{2})?/);
  return match ? match[1] : "";
}

function artifactMetaWithTime(item: Fields = {}, { full = false } = {}) {
  const parts = [item.meta || ""];
  const time = full ? (item.fullTimeLabel || item.updatedAt || "") : item.timeLabel;
  if (time) parts.push(time);
  return parts.filter(Boolean).join(" · ");
}

function filenameFromUrl(url: unknown = "") {
  try {
    const parsed = new URL(String(url || ""));
    const tail = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
    return tail || "";
  } catch(_e) {
    return String(url || "").split(/[/?#]/).filter(Boolean).pop() || "";
  }
}

function formatFileMeta(filename: unknown = "", meta: Fields = {}) {
  const parts = [];
  const format = String(meta.format || artifactFileExtension(filename) || "").trim();
  if (format) parts.push(format);
  const size = Number(meta.size || 0);
  if (Number.isFinite(size) && size > 0) parts.push(formatBytes(size));
  if (!parts.length && meta.artifactId) parts.push(t("localArtifact"));
  if (!parts.length && meta.fileId) parts.push(t("documentLibrary"));
  return parts.join(" · ") || t("file");
}

  return {
    collectSessionArtifacts,
    collectSessionArtifactsWithRuntime,
    fetchRuntimeArtifactSummary,
    buildArtifactSummaryFromRuntimeArtifacts,
    mergeArtifactSummaries,
    compareArtifactItems,
    fileArtifactDownloadId,
    fileArtifactUrl,
    isDownloadableFileArtifact,
    artifactMetaWithTime,
    artifactFileExtension,
    createArtifactSummary,
    emptyArtifactSummary,
    normalizeArtifactSummaryDataItem,
    normalizeArtifactSummaryFileItem,
    dataArtifactKindLabel,
  };
}
