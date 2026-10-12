import { formatBeijingDateTime, parseBeijingDateTime } from '../time-utils.js';
type Fields = Record<string, unknown>;
const objectOrEmpty = (value: unknown): Fields => value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};

/** Legacy results had distinct ledger, model-context and display projections. New tools return artifacts[]. */
export interface ToolArtifactAdapter {
  /** Normalize the package's older explicit envelopes without changing source content or resource identity. */
  normalize?(artifact: Readonly<Fields>): Fields;
  project?(args: Fields, result: Fields, consumer: "resource" | "context" | "display"): readonly Fields[];
  intermediate?: boolean;
}

export function resolveArtifactUpdatedAt(source: Fields = {}, fallbackTime: unknown = "") {
  const candidates = [
    source.updatedAt,
    source.generatedAt,
    source.createdAt,
    source.finishedAt,
    source.endedAt,
    source.timestamp,
    fallbackTime,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeArtifactTimeValue(candidate);
    if (normalized) return normalized;
  }
  return "";
}

export function normalizeArtifactTimeValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (value instanceof Date || typeof value === "number") return formatBeijingDateTime(value);
  const text = String(value || "").trim();
  if (!text) return "";
  if (parseBeijingDateTime(text)) return text;
  if (/^\d{10,13}$/.test(text)) {
    const number = Number(text);
    if (Number.isFinite(number)) return formatBeijingDateTime(text.length === 10 ? number * 1000 : number);
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? formatBeijingDateTime(parsed) : "";
}

export function artifactTimeMs(value: unknown = "") {
  return parseBeijingDateTime(value) || 0;
}

export function normalizeDataArtifactKey(value: unknown = "") {
  return String(value || "").trim().replace(/^data:/i, "");
}

export function positiveArtifactNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function artifactFileExtension(filename: unknown = "") {
  const text = String(filename || "").split(/[?#]/)[0];
  const ext = text.includes(".") ? text.split(".").pop()!.toLowerCase() : "";
  return ext && ext.length <= 12 ? ext : "";
}

export function fileArtifactDownloadId(item: Fields = {}) {
  const direct = String(item.downloadId || objectOrEmpty(item.downloaded).downloadId || "").trim();
  if (direct) return direct;
  const match = String(item.id || "").trim().match(/^download:(.+)$/);
  return match?.[1] || "";
}

export function fileArtifactUrl(item: Fields = {}) {
  return String(item.url || item.fileUrl || item.finalUrl || "").trim();
}

export function artifactFormatBytes(value: unknown = 0) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

export function fileArtifactDedupeKey(item: Fields = {}) {
  const title = String(item.filename || item.title || "").trim().toLowerCase();
  if (!title) return "";
  const format = String(item.format || artifactFileExtension(title) || "").trim().toLowerCase();
  return `file:${title}|${format}`;
}

export function artifactToolTime(tool: { endedAt?: unknown; updatedAt?: unknown; timestamp?: unknown; startedAt?: unknown } = {}) {
  return normalizeArtifactTimeValue(tool.endedAt || tool.updatedAt || tool.timestamp || tool.startedAt || "");
}

export function projectFileArtifact(item: Fields = {}, fallbackTime: unknown = "", filenameFromUrl = artifactFilenameFromUrl) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const url = String(item.url || item.fileUrl || item.finalUrl || "").trim();
  const filename = String(item.filename || item.title || item.name || filenameFromUrl(url) || "").trim();
  if (!filename) return null;
  const downloadId = fileArtifactDownloadId(item);
  const artifactId = String(item.artifactId || "").trim();
  const fileId = String(item.fileId || "").trim();
  return {
    id: String((downloadId ? `download:${downloadId}` : "") || (url ? `url:${url}` : "") || item.id || (fileId ? `docfile:${fileId}` : "") || (artifactId ? `artifact:${artifactId}` : "") || `file:${filename}`),
    filename,
    title: String(item.title || item.name || filename).trim(),
    format: String(item.format || item.ext || artifactFileExtension(filename) || "").trim(),
    size: positiveArtifactNumber(item.size || item.bytes || item.totalBytes),
    downloadId,
    artifactId,
    fileId,
    url,
    sourceTool: String(item.sourceTool || "").trim(),
    updatedAt: resolveArtifactUpdatedAt(item, fallbackTime),
    score: positiveArtifactNumber(item.score) || (artifactId ? 3 : 2),
  };
}

export function artifactFilenameFromUrl(url: unknown) {
  try {
    const parsed = new URL(String(url || ""));
    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "");
  } catch(_e) {
    return String(url || "").split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
  }
}

/** Legacy single-artifact envelopes are accepted by the authoritative context projection only. */
export function explicitArtifactCandidates(result: Fields, { includeSingle = false } = {}): Fields[] {
  const nested = objectOrEmpty(result.result);
  const candidates = [
    ...(Array.isArray(result.artifacts) ? result.artifacts : []),
    ...(includeSingle && result.artifact ? [result.artifact] : []),
    ...(Array.isArray(nested.artifacts) ? nested.artifacts : []),
    ...(includeSingle && nested.artifact ? [nested.artifact] : []),
  ];
  return candidates.filter(candidate => candidate && typeof candidate === "object" && !Array.isArray(candidate)).map(objectOrEmpty);
}

export function findFileArtifactMergeKey<T extends Fields>(map: ReadonlyMap<string, T>, item: Fields, fallbackId: string,
  aliasOf: (item: Fields) => string = fileArtifactDedupeKey) {
  const id = String(fallbackId || item.id || item.table || item.filename || item.title || "").trim();
  if (!id || map.has(id)) return id;
  const alias = aliasOf(item);
  if (alias) for (const [key, existing] of map) if (aliasOf(existing) === alias) return key;
  return id;
}
