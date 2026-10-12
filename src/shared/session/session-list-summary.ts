import { t } from "../i18n/backend.js";
export type SessionListSummary = typeof DEFAULT_SUMMARY;
interface SummaryEntry { type?: string; streaming?: boolean; [key: string]: unknown }
interface ArtifactPreview {
  type?: unknown; kind?: unknown; id?: unknown; table?: unknown; name?: unknown; title?: unknown;
  totalRows?: unknown; rowCount?: unknown; size?: unknown; updatedAt?: unknown;
  downloadId?: unknown; url?: unknown; fileUrl?: unknown; finalUrl?: unknown; filename?: unknown;
}
interface ArtifactCollections {
  items?: readonly ArtifactPreview[]; imageCollections?: readonly ArtifactPreview[];
  dataTables?: readonly ArtifactPreview[]; files?: readonly ArtifactPreview[]; data?: readonly ArtifactPreview[];
  total?: unknown; signature?: unknown;
}
type ArtifactMaps = { [key in "imageCollections" | "dataTables" | "files"]: Map<string, ArtifactPreview> };

import { nowBeijingDateTime } from "../time-utils.js";

export const SESSION_LIST_SUMMARY_VERSION = 4;

const DEFAULT_SUMMARY = {
  version: SESSION_LIST_SUMMARY_VERSION,
  lastText: "",
  lastType: "",
  lastAt: "",
  messageCount: 0,
  artifactCount: 0,
  artifactPreview: "",
  dataCount: 0,
  fileCount: 0,
  artifactSignature: "",
  artifactUpdatedAt: "",
  updatedAt: "",
};

const DISPLAY_ENTRY_TYPES = new Set(["assistant", "user", "note", "error", "tool", "run-status"]);

export function normalizeSessionListSummary(summary: unknown = {}) {
  const input = summary && typeof summary === "object" && !Array.isArray(summary) ? summary as Record<string, unknown> : {};
  const dataCount = positiveInteger(input.dataCount);
  const fileCount = positiveInteger(input.fileCount);
  const containerCount = dataCount + fileCount;
  return {
    ...DEFAULT_SUMMARY,
    version: SESSION_LIST_SUMMARY_VERSION,
    lastText: cleanText(input.lastText, 240),
    lastType: cleanText(input.lastType, 40),
    lastAt: cleanText(input.lastAt, 64),
    messageCount: positiveInteger(input.messageCount),
    artifactCount: containerCount || positiveInteger(input.artifactCount),
    artifactPreview: cleanText(input.artifactPreview, 240),
    dataCount,
    fileCount,
    artifactSignature: cleanText(input.artifactSignature, 400),
    artifactUpdatedAt: cleanText(input.artifactUpdatedAt, 64),
    updatedAt: cleanText(input.updatedAt, 64),
  };
}

export function mergeSessionListSummary(existing: unknown = {}, patch: unknown = {}) {
  const prev = normalizeSessionListSummary(existing);
  const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch as Record<string, unknown> : {};
  const next = { ...prev, version: SESSION_LIST_SUMMARY_VERSION };

  for (const key of ["lastText", "lastType", "lastAt", "artifactPreview", "artifactSignature", "artifactUpdatedAt", "updatedAt"] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = cleanText(input[key], key === "artifactSignature" ? 400 : 240);
    }
  }
  for (const key of ["messageCount", "artifactCount", "dataCount", "fileCount"] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      next[key] = positiveInteger(input[key]);
    }
  }
  const containerCount = positiveInteger(next.dataCount) + positiveInteger(next.fileCount);
  if (containerCount) next.artifactCount = containerCount;

  if (!next.updatedAt) next.updatedAt = cleanText(input.lastAt, 240) || cleanText(input.artifactUpdatedAt, 240) || prev.updatedAt || nowBeijingDateTime();
  return next;
}

export function createSessionListSummaryFromFirstMessage(firstMessage: unknown = "", at = nowBeijingDateTime()) {
  const text = cleanPreviewText(firstMessage);
  return mergeSessionListSummary(null, {
    lastText: text ? t("summary.user", { text }) : "",
    lastType: text ? "user" : "",
    lastAt: text ? at : "",
    messageCount: text ? 1 : 0,
    updatedAt: at,
  });
}

export function createSessionListSummaryFromTranscript(transcript: readonly SummaryEntry[] = [], fallbackAt = "") {
  const entries: SummaryEntry[] = Array.isArray(transcript) ? transcript.filter(Boolean) : [];
  const messageCount = entries.filter((entry) => DISPLAY_ENTRY_TYPES.has(entry?.type || "")).length;
  const latest = findLatestDisplayEntry(entries);
  if (!latest) {
    return mergeSessionListSummary(null, {
      messageCount,
      updatedAt: fallbackAt || "",
    });
  }
  const lastText = summarizeTranscriptEntry(latest);
  const lastAt = entryTime(latest) || fallbackAt || "";
  return mergeSessionListSummary(null, {
    lastText,
    lastType: cleanText(latest.type, 40),
    lastAt,
    messageCount,
    updatedAt: lastAt || fallbackAt || "",
  });
}

export function createSessionListSummaryFromAgentEvent(event: Record<string, unknown> = {}) {
  if (!event || typeof event !== "object") return null;
  const now = nowBeijingDateTime();
  if (event.type === "message_end") {
    const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : {};
    const role = String(message.role || "").trim();
    if (role === "user") {
      const text = cleanPreviewText(messageContentText(message.content));
      return {
        lastText: text ? t("summary.user", { text }) : t("summary.userImage"),
        lastType: "user",
        lastAt: now,
        updatedAt: now,
      };
    }
    if (role === "assistant") {
      const text = cleanPreviewText(messageContentText(message.content));
      if (!text) return null;
      return {
        lastText: text,
        lastType: "assistant",
        lastAt: now,
        updatedAt: now,
      };
    }
  }
  if (event.type === "tool_execution_end") {
    const toolName = cleanText(event.toolTitle || event.title || event.displayName || event.toolName || event.name || t("common.tool"), 80);
    return {
      lastText: t(event.isError ? "summary.toolFailed" : "summary.toolCompleted", { name: toolName }),
      lastType: "tool",
      lastAt: now,
      updatedAt: now,
    };
  }
  if (event.type === "error") {
    const text = cleanPreviewText(event.message || t("status.runFailed"));
    return {
      lastText: text ? t("summary.error", { text }) : t("common.error"),
      lastType: "error",
      lastAt: now,
      updatedAt: now,
    };
  }
  if (event.type === "aborted") {
    return {
      lastText: t("status.cancelled"),
      lastType: "run-status",
      lastAt: now,
      updatedAt: now,
    };
  }
  return null;
}

export function createSessionArtifactListSummary(artifacts: ArtifactCollections = {}, fallbackAt = nowBeijingDateTime()) {
  const normalized = normalizeArtifactCollections(artifacts);
  const items = [...normalized.imageCollections, ...normalized.dataTables, ...normalized.files];
  const dataCount = normalized.imageCollections.length + normalized.dataTables.length;
  const fileCount = normalized.files.length;
  const containerCount = dataCount + fileCount;
  const artifactCount = containerCount || (hasExplicitArtifactCollections(artifacts) ? 0 : positiveInteger(artifacts.total));
  const out: Partial<SessionListSummary> = {
    artifactCount,
    artifactPreview: artifactPreviewText(items),
    dataCount,
    fileCount,
    artifactSignature: cleanText(artifacts.signature || artifactSignature(items), 400),
  };
  if (artifactCount) {
    out.artifactUpdatedAt = fallbackAt;
    out.updatedAt = fallbackAt;
  }
  return out;
}

export function sessionListSummarySearchText(summary: unknown = {}) {
  const normalized = normalizeSessionListSummary(summary);
  return [
    formatSessionListSummaryText(normalized),
    normalized.lastType,
    normalized.artifactPreview,
    normalized.artifactCount ? t("summary.artifacts", { count: normalized.artifactCount }) : "",
    normalized.dataCount ? t("summary.tables", { count: normalized.dataCount }) : "",
    normalized.fileCount ? t("summary.files", { count: normalized.fileCount }) : "",
  ].filter(Boolean).join(" ");
}

/** Re-project the display-only v4 cache without rewriting user content or stored records. */
export function formatSessionListSummaryText(summary: unknown = {}): string {
  const { lastType, lastText } = normalizeSessionListSummary(summary);
  if (lastType === "user") {
    const match = lastText.match(/^(?:用户|User): (.*)$/su);
    if (match) return t("summary.user", { text: match[1] });
    if (lastText === "用户发送了图片" || lastText === "User sent an image") return t("summary.userImage");
  }
  if (lastType === "error") {
    const match = lastText.match(/^(?:错误|Error): (.*)$/su);
    if (match) return t("summary.error", { text: match[1] });
    if (lastText === "错误" || lastText === "Error") return t("common.error");
  }
  if (lastType === "tool") {
    const match = lastText.match(/^(.*) (出错|完成|failed|completed)$/su);
    if (match) return t(match[2] === "出错" || match[2] === "failed" ? "summary.toolFailed" : "summary.toolCompleted", { name: match[1] });
  }
  if (lastType === "run-status") {
    if (lastText === "已取消" || lastText === "Cancelled" || lastText === "Canceled") return t("status.cancelled");
    if (lastText === "运行失败" || lastText === "Run failed") return t("status.runFailed");
    if (lastText === "已完成" || lastText === "Completed") return t("status.completed");
    if (lastText === "已中断" || lastText === "Interrupted") return t("status.interrupted");
  }
  return lastText;
}

export function sessionListSummarySignature(summary: unknown = {}) {
  const normalized = normalizeSessionListSummary(summary);
  return JSON.stringify(normalized);
}

function findLatestDisplayEntry(entries: readonly SummaryEntry[] = []) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.streaming) continue;
    if (DISPLAY_ENTRY_TYPES.has(entry.type || "")) return entry;
  }
  return null;
}

function summarizeTranscriptEntry(item: SummaryEntry = {}) {
  if (item.type === "assistant") return cleanPreviewText(item.content || item.text || "");
  if (item.type === "user") {
    const text = cleanPreviewText(item.text || item.content || "");
    return text ? t("summary.user", { text }) : t("summary.userImage");
  }
  if (item.type === "tool") {
    const name = cleanText(item.title || item.displayName || item.name || t("common.tool"), 80);
    return t(item.isError ? "summary.toolFailed" : "summary.toolCompleted", { name });
  }
  if (item.type === "run-status") return cleanPreviewText(item.text || runStatusText(item.status));
  if (item.type === "error") {
    const text = cleanPreviewText(item.text || item.message || "");
    return text ? t("summary.error", { text }) : t("common.error");
  }
  return cleanPreviewText(item.text || item.content || "");
}

function runStatusText(status: unknown = "") {
  switch (String(status || "").trim()) {
    case "aborted": return t("status.cancelled");
    case "error": return t("status.runFailed");
    case "completed": return t("status.completed");
    case "interrupted": return t("status.interrupted");
    default: return "";
  }
}

function normalizeArtifactCollections(artifacts: ArtifactCollections = {}) {
  const imageCollections = new Map<string, ArtifactPreview>();
  const dataTables = new Map<string, ArtifactPreview>();
  const files = new Map<string, ArtifactPreview>();
  if (Array.isArray(artifacts.items) && artifacts.items.length) {
    for (const item of artifacts.items) collectArtifactItem({ imageCollections, dataTables, files }, item);
    return artifactCollectionMapsToArrays({ imageCollections, dataTables, files });
  }

  for (const item of normalizeArtifactItems(artifacts.imageCollections)) upsertArtifactCollectionItem(imageCollections, item, "image");
  for (const item of normalizeArtifactItems(artifacts.dataTables)) upsertArtifactCollectionItem(dataTables, item, "data");
  for (const item of normalizeArtifactItems(artifacts.files).filter(isDownloadableListFileArtifact)) upsertArtifactCollectionItem(files, item, "file");
  if (Array.isArray(artifacts.data)) {
    for (const item of artifacts.data) {
      const kind = String(item?.kind || item?.type || "").trim();
      if (kind === "image_collection" || kind === "imageCollection") upsertArtifactCollectionItem(imageCollections, item, "image");
      else upsertArtifactCollectionItem(dataTables, item, "data");
    }
  }
  return artifactCollectionMapsToArrays({ imageCollections, dataTables, files });
}

function hasExplicitArtifactCollections(artifacts: ArtifactCollections = {}) {
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return false;
  return (["items", "imageCollections", "dataTables", "files", "data"] as const).some((key) => Array.isArray(artifacts[key]));
}

function collectArtifactItem(target: ArtifactMaps, item: ArtifactPreview = {}) {
  const type = String(item?.type || item?.kind || "").trim();
  if (type === "imageCollection" || type === "image_collection") upsertArtifactCollectionItem(target.imageCollections, item, "image");
  else if (type === "file" && isDownloadableListFileArtifact(item)) upsertArtifactCollectionItem(target.files, item, "file");
  else if (type === "data" || type === "dataTable" || item?.table) upsertArtifactCollectionItem(target.dataTables, item, "data");
}

function upsertArtifactCollectionItem(map: Map<string, ArtifactPreview>, item: ArtifactPreview = {}, kind = "") {
  if (!map || !item || typeof item !== "object") return;
  const key = artifactCollectionItemKey(item, kind);
  if (!key) return;
  map.set(key, mergeArtifactCollectionItems(map.get(key), item));
}

function artifactCollectionItemKey(item: ArtifactPreview = {}, kind = "") {
  if (kind === "file") {
    return cleanText(item.downloadId || item.url || item.fileUrl || item.finalUrl || item.filename || item.title || item.name || item.id || "", 260);
  }
  return cleanText(item.table || item.title || item.name || item.id || "", 260);
}

function mergeArtifactCollectionItems(existing: ArtifactPreview | null | undefined = null, next: ArtifactPreview = {}): ArtifactPreview {
  if (!existing) return next;
  return {
    ...existing,
    ...next,
    totalRows: Math.max(positiveInteger(existing.totalRows), positiveInteger(next.totalRows)) || next.totalRows || existing.totalRows,
    rowCount: Math.max(positiveInteger(existing.rowCount), positiveInteger(next.rowCount)) || next.rowCount || existing.rowCount,
    updatedAt: next.updatedAt || existing.updatedAt,
  };
}

function artifactCollectionMapsToArrays({ imageCollections, dataTables, files }: ArtifactMaps) {
  return {
    imageCollections: Array.from(imageCollections.values()),
    dataTables: Array.from(dataTables.values()),
    files: Array.from(files.values()),
  };
}

function normalizeArtifactItems(items: unknown): ArtifactPreview[] {
  return Array.isArray(items) ? items.filter((item) => item && typeof item === "object") : [];
}

function isDownloadableListFileArtifact(item: ArtifactPreview = {}) {
  return Boolean(item.downloadId || item.url || item.fileUrl || item.finalUrl);
}

function artifactPreviewText(items: readonly ArtifactPreview[] = []) {
  const names = items
    .map((item) => cleanText(item.title || item.table || item.filename || item.name || item.id || "", 80))
    .filter(Boolean)
    .slice(0, 3);
  return names.join(" · ");
}

function artifactSignature(items: readonly ArtifactPreview[] = []) {
  return items
    .map((item) => [
      item.type || item.kind || "",
      item.id || item.table || item.filename || item.name || "",
      item.totalRows || item.rowCount || item.size || "",
      item.updatedAt || "",
    ].join(":"))
    .join("|");
}

function entryTime(entry: SummaryEntry = {}) {
  return cleanText(entry.endedAt || entry.timestamp || entry.updatedAt || entry.createdAt || "", 64);
}

function cleanPreviewText(value: unknown = "") {
  return cleanText(stripMarkdownText(value), 240);
}

function messageContentText(content: unknown = "") {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        return part.text || part.content || "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function stripMarkdownText(text: unknown = "") {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown = "", limit = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function positiveInteger(value: unknown) {
  const number = Math.floor(Number(value) || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
