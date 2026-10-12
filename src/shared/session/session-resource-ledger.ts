interface ResourceMeta { sessionId?: string; runId?: string; toolCallId?: string; sourceTool?: string }
export type SessionResourceArtifact = NonNullable<ReturnType<typeof normalizeSessionResourceArtifact>>;

import { compareBeijingDateTimeDesc, nowBeijingDateTime } from "../time-utils.js";

export const SESSION_RESOURCE_LEDGER_KEY = "_session_resource_ledger_v1";

const MAX_SESSION_RESOURCES = 300;
let resourceLedgerWriteQueue: Promise<unknown> = Promise.resolve();

export async function appendSessionResourceArtifacts({
  sessionId = "",
  runId = "",
  toolCallId = "",
  sourceTool = "",
  artifacts = [],
}: ResourceMeta & { artifacts?: readonly unknown[] } = {}) {
  const cleanSessionId = cleanText(sessionId, 120);
  if (!cleanSessionId) return [];

  const normalized = (Array.isArray(artifacts) ? artifacts : [])
    .map((artifact) =>
      normalizeSessionResourceArtifact(artifact, {
        sessionId: cleanSessionId,
        runId,
        toolCallId,
        sourceTool,
      }),
    )
    .filter(item => item !== null);
  if (!normalized.length) return [];

  return enqueueResourceLedgerWrite(async () => {
    const ledger = await readResourceLedger();
    const current = Array.isArray(ledger[cleanSessionId]) ? ledger[cleanSessionId] : [];
    const merged = mergeSessionResourceArtifacts(current, normalized).slice(0, MAX_SESSION_RESOURCES);
    ledger[cleanSessionId] = merged;
    await writeResourceLedger(ledger);
    return merged;
  });
}

export async function listSessionResourceArtifacts(sessionId = "") {
  const cleanSessionId = cleanText(sessionId, 120);
  if (!cleanSessionId) return [];
  const ledger = await readResourceLedger();
  const normalized = (Array.isArray(ledger[cleanSessionId]) ? ledger[cleanSessionId] : [])
    .map((item) => normalizeSessionResourceArtifact(item, { sessionId: cleanSessionId }))
    .filter(item => item !== null);
  return mergeSessionResourceArtifacts(normalized, []);
}

export async function clearSessionResourceArtifacts(sessionId = "") {
  const cleanSessionId = cleanText(sessionId, 120);
  if (!cleanSessionId) return {};
  return enqueueResourceLedgerWrite(async () => {
    const ledger = await readResourceLedger();
    delete ledger[cleanSessionId];
    await writeResourceLedger(ledger);
    return ledger;
  });
}

export function mergeSessionResourceArtifacts(existing: readonly unknown[] = [], incoming: readonly unknown[] = []) {
  const byKey = new Map<string, SessionResourceArtifact>();
  for (const item of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const normalized = normalizeSessionResourceArtifact(item, { sessionId: item?.sessionId || "" });
    if (!normalized) continue;
    const previous = byKey.get(normalized.resourceKey);
    byKey.set(normalized.resourceKey, {
      ...(previous || {}),
      ...normalized,
      createdAt: previous?.createdAt || normalized.createdAt,
      updatedAt: newerTimestamp(previous?.updatedAt, normalized.updatedAt),
    });
  }
  return [...byKey.values()].sort(sortResourceArtifacts);
}

export function normalizeSessionResourceArtifact(value: unknown = {}, meta: ResourceMeta = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifact = value as Record<string, unknown>;

  const sessionId = cleanText(artifact.sessionId || meta.sessionId || "", 120);
  if (!sessionId) return null;

  const rawType = cleanText(artifact.type || inferResourceType(artifact), 48);
  const type = normalizeResourceType(rawType, artifact);
  const kind = normalizeResourceKind(artifact.kind || artifact.assetKind || (isImageCollectionType(rawType) ? "image_collection" : ""));
  const dataLike = type === "data";
  const table = cleanText(artifact.table || artifact.tableName || (dataLike ? artifact.id : ""), 160);
  const filename = cleanText(artifact.filename || artifact.name || "", 240);
  const artifactId = cleanText(artifact.artifactId || (dataLike ? "" : artifact.id) || "", 180);
  const downloadId = cleanText(artifact.downloadId || "", 80);
  const fileId = cleanText(artifact.fileId || "", 180);
  const url = cleanText(artifact.url || artifact.sourceUrl || artifact.downloadUrl || "", 4000);
  const canonicalResourceKey = stableResourceKey({ type, kind, table, filename, artifactId, downloadId, fileId, url });
  const resourceKey = (dataLike && table)
    ? canonicalResourceKey
    : (cleanText(artifact.resourceKey || "", 260) || canonicalResourceKey);
  if (!resourceKey) return null;

  const now = nowBeijingDateTime();
  return {
    resourceKey,
    id: artifactId || resourceKey,
    sessionId,
    runId: cleanText(artifact.runId || meta.runId || "", 120),
    toolCallId: cleanText(artifact.toolCallId || meta.toolCallId || "", 120),
    sourceTool: cleanText(artifact.sourceTool || meta.sourceTool || "", 120),
    type,
    kind,
    kindLabel: cleanText(artifact.kindLabel || artifact.typeLabel || "", 80),
    title: cleanText(artifact.title || artifact.label || filename || table || artifactId || type, 240),
    filename,
    table,
    artifactId,
    downloadId,
    fileId,
    url,
    format: cleanText(artifact.format || artifact.extension || "", 40),
    mimeType: cleanText(artifact.mimeType || "", 160),
    size: positiveNumber(artifact.size),
    sizeLabel: cleanText(artifact.sizeLabel || "", 80),
    totalRows: positiveNumber(artifact.totalRows ?? artifact.rowCount ?? artifact.rows),
    rowCount: positiveNumber(artifact.rowCount ?? artifact.totalRows ?? artifact.rows),
    assetCount: positiveNumber(artifact.assetCount ?? artifact.imageCount),
    columns: normalizeStringList(artifact.columns, 40, 120),
    createdAt: cleanText(artifact.createdAt || artifact.updatedAt || now, 64),
    updatedAt: cleanText(artifact.updatedAt || artifact.createdAt || now, 64),
  };
}

function inferResourceType(artifact: Record<string, unknown> = {}): string {
  if (isImageCollectionType(artifact.type || artifact.kind)) return "data";
  if (artifact.table || artifact.totalRows != null || artifact.rowCount != null) return "data";
  if (artifact.downloadId || artifact.filename || artifact.artifactId || artifact.fileId) return "file";
  if (artifact.url) return "link";
  return "artifact";
}

function stableResourceKey({ type, kind, table, filename, artifactId, downloadId, fileId, url }: Record<"type" | "kind" | "table" | "filename" | "artifactId" | "downloadId" | "fileId" | "url", string>) {
  if (type === "data" && table) return "data:table:" + table;
  if (artifactId) return `${type}:artifact:${artifactId}`;
  if (downloadId) return `${type}:download:${downloadId}`;
  if (fileId) return `${type}:file:${fileId}`;
  if (table) return `${type}:table:${table}`;
  if (filename) return `${type}:filename:${filename}`;
  if (url) return `${type}:url:${url}`;
  if (kind) return `${type}:kind:${kind}`;
  return "";
}

function normalizeResourceType(type = "", artifact: Record<string, unknown> = {}) {
  const text = cleanText(type, 48).toLowerCase();
  if (text === "data" || text === "table" || text === "datatable" || text === "data_table" || isImageCollectionType(text)) return "data";
  if (text === "file" || text === "download" || text === "document") return "file";
  if (text === "link" || text === "url") return "link";
  return inferResourceType({ ...artifact, type: text });
}

function normalizeResourceKind(kind: unknown = "") {
  const text = cleanText(kind, 80).toLowerCase();
  if (isImageCollectionType(text) || text.includes("图集") || text.includes("image")) return "image_collection";
  return text;
}

function isImageCollectionType(value: unknown = "") {
  const text = cleanText(value, 80).toLowerCase();
  return text === "imagecollection" || text === "image_collection";
}

function sortResourceArtifacts(a: SessionResourceArtifact, b: SessionResourceArtifact) {
  return compareBeijingDateTimeDesc(a?.updatedAt || a?.createdAt || "", b?.updatedAt || b?.createdAt || "");
}

function newerTimestamp(a = "", b = "") {
  if (!a) return b || "";
  if (!b) return a || "";
  return compareBeijingDateTimeDesc(a, b) <= 0 ? a : b;
}

function enqueueResourceLedgerWrite<T>(work: () => T | Promise<T>): Promise<T> {
  const next = resourceLedgerWriteQueue.catch(() => {}).then(work);
  resourceLedgerWriteQueue = next.catch(() => {});
  return next;
}

async function readResourceLedger(): Promise<Record<string, unknown>> {
  const stored = await readStorage(SESSION_RESOURCE_LEDGER_KEY);
  const value = stored?.[SESSION_RESOURCE_LEDGER_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function writeResourceLedger(ledger: Record<string, unknown> = {}) {
  await writeStorage({ [SESSION_RESOURCE_LEDGER_KEY]: ledger });
}

async function readStorage(key: string): Promise<Record<string, unknown>> {
  if (typeof globalThis.chrome?.storage?.local?.get === "function") {
    return chrome.storage.local.get(key);
  }
  return {};
}

async function writeStorage(values: Record<string, unknown>) {
  if (typeof globalThis.chrome?.storage?.local?.set === "function") {
    await chrome.storage.local.set(values);
  }
}

function cleanText(value: unknown, limit: number) {
  return String(value ?? "").trim().slice(0, limit);
}

function normalizeStringList(values: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => cleanText(value, maxLength)).filter(Boolean).slice(0, maxItems);
}

function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
