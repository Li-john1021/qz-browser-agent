import type { createSessionRepository } from "./repository.js";
import type { SessionMetadata } from "../../shared/session/session-store.js";
import type { ToolIdentity } from "../../shared/tools/tool-identity.js";
import type { DataTable } from "../../shared/data-store.js";
import type { SessionListSummary } from "../../shared/session/session-list-summary.js";
import { t } from "../../shared/i18n/backend.js";
import { formatNumber } from "../../shared/i18n/index.js";
type Fields = Record<string, unknown>;
interface Artifact extends Fields {
  id?: string; type?: string; kind?: string; title?: string; filename?: string; table?: string;
  columns?: unknown[]; updatedAt?: string; createdAt?: string; score?: number; totalRows?: number;
}
interface ArtifactCollections { items?: Artifact[]; imageCollections?: Artifact[]; dataTables?: Artifact[]; files?: Artifact[]; total?: number }
interface SessionArtifacts extends ArtifactCollections {
  total: number; summary: { total: number; imageCollections: number; dataTables: number; files: number; note?: string };
  items: Artifact[]; imageCollections: Artifact[]; dataTables: Artifact[]; files: Artifact[];
}
interface ArtifactsOptions {
  sessionRepository: Pick<ReturnType<typeof createSessionRepository>, "updateMetadata">;
  getSessions(): Promise<Record<string, SessionMetadata>>;
  ready?(): Promise<unknown>;
  normalizeSessionId(value: unknown): string;
  nowBeijingDateTime(): string;
  broadcast?(event: Fields): unknown;
  resolveSessionArtifactTranscript(id: string): Promise<readonly unknown[]>;
  collectRunScriptToolArtifacts(name: unknown, args: unknown, result: unknown): unknown[];
  getToolIdentity(name: string): ToolIdentity;
  listTables?: typeof listDataTables;
  appendResources?: typeof appendSessionResourceArtifacts;
  listResources?: typeof listSessionResourceArtifacts;
  logger?: Pick<Console, "debug">;
}
type SummaryPatch = Partial<SessionListSummary>;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
import { listDataTables } from "../../shared/data-store.js";
import {
  appendSessionResourceArtifacts,
  listSessionResourceArtifacts,
} from "../../shared/session/session-resource-ledger.js";
import {
  createSessionArtifactListSummary,
  createSessionListSummaryFromTranscript,
  mergeSessionListSummary,
  SESSION_LIST_SUMMARY_VERSION,
  sessionListSummarySignature,
} from "../../shared/session/session-list-summary.js";
import {
  resolveArtifactUpdatedAt, artifactTimeMs, normalizeDataArtifactKey,
  positiveArtifactNumber, artifactFileExtension, fileArtifactDownloadId as sessionFileArtifactDownloadId,
  fileArtifactUrl as sessionFileArtifactUrl, fileArtifactDedupeKey, artifactToolTime, artifactFormatBytes,
  projectFileArtifact, findFileArtifactMergeKey,
} from "../../shared/tools/artifact-projection.js";

import { projectToolArtifacts, isIntermediateArtifact } from "../../shared/tools/tool-artifacts.js";

const SESSION_ARTIFACT_TABLE_LIMIT = 12;
const SESSION_ARTIFACT_FILE_LIMIT = 24;
const SESSION_ARTIFACT_COLUMN_LIMIT = 10;

export function createSessionArtifacts({
  sessionRepository,
  getSessions,
  ready = async () => {},
  normalizeSessionId,
  nowBeijingDateTime,
  broadcast = () => {},
  resolveSessionArtifactTranscript,
  collectRunScriptToolArtifacts,
  getToolIdentity,
  listTables = listDataTables,
  appendResources = appendSessionResourceArtifacts,
  listResources = listSessionResourceArtifacts,
  logger = console,
}: ArtifactsOptions) {
  if (!sessionRepository || typeof sessionRepository.updateMetadata !== "function") {
    throw new TypeError("session artifacts require a session repository");
  }
  for (const [name, value] of Object.entries({
    normalizeSessionId,
    getSessions,
    nowBeijingDateTime,
    resolveSessionArtifactTranscript,
    collectRunScriptToolArtifacts,
    getToolIdentity,
    listTables,
    appendResources,
    listResources,
  })) {
    if (typeof value !== "function") throw new TypeError(`session artifacts require ${name}`);
  }

  const sessionListSummaryPendingPatches = new Map<string, { patch: SummaryPatch; touchSession: boolean; action: string }>();
  const sessionListSummaryPatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionArtifactSummaryRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function mergeSessionListSummaryPatch(existing: SummaryPatch = {}, patch: SummaryPatch = {}): SummaryPatch {
    const out: Fields = {
      ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    };
    const input = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      out[key] = value;
    }
    return out;
  }

  function applySessionListSummaryPatchToSessions(sessions: Record<string, SessionMetadata>, sessionId: string, patch: SummaryPatch = {}, { touchSession = false } = {}) {
    const id = normalizeSessionId(sessionId);
    const session = id ? sessions[id] : null;
    if (!session) return null;
    const nextSummary = mergeSessionListSummary(session.listSummary, patch);
    if (sessionListSummarySignature(nextSummary) === sessionListSummarySignature(session.listSummary)) {
      return null;
    }
    sessions[id] = {
      ...session,
      ...(touchSession ? { updatedAt: nextSummary.updatedAt || nowBeijingDateTime() } : {}),
      listSummary: nextSummary,
    };
    return sessions[id];
  }

  async function patchStoredSessionListSummary(sessionId: string, patch: SummaryPatch = {}, {
    touchSession = true,
    action = "list_summary",
    preserveUnchangedArtifactTime = false,
  } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id || !patch || typeof patch !== "object") return null;
    const result = await sessionRepository.updateMetadata(id, (current) => {
      const sessions = { [id]: current };
      const effectivePatch = preserveUnchangedArtifactTime
        ? preserveArtifactSummaryTime(current.listSummary, patch)
        : patch;
      return applySessionListSummaryPatchToSessions(sessions, id, effectivePatch, { touchSession }) || null;
    });
    const updated = result.changed ? result.session : null;
    if (updated) broadcast({ type: "sessions_changed", action, sessionId: id, session: updated });
    return updated;
  }

  function scheduleStoredSessionListSummaryPatch(sessionId: string, patch: SummaryPatch = {}, { touchSession = true, action = "list_summary", delay = 240 } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id || !patch || typeof patch !== "object") return;
    const previous = sessionListSummaryPendingPatches.get(id);
    sessionListSummaryPendingPatches.set(id, {
      patch: mergeSessionListSummaryPatch(previous?.patch, patch),
      touchSession: Boolean(previous?.touchSession || touchSession),
      action: action || previous?.action || "list_summary",
    });
    if (sessionListSummaryPatchTimers.has(id)) clearTimeout(sessionListSummaryPatchTimers.get(id));
    sessionListSummaryPatchTimers.set(id, setTimeout(() => {
      sessionListSummaryPatchTimers.delete(id);
      flushStoredSessionListSummaryPatch(id).catch((err) => {
        logger.debug?.("[轻舟] flush session list summary failed:", errorMessage(err));
      });
    }, Math.max(0, Number(delay) || 0)));
  }

  async function flushStoredSessionListSummaryPatch(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    if (!id) return null;
    const pending = sessionListSummaryPendingPatches.get(id);
    if (!pending) return null;
    sessionListSummaryPendingPatches.delete(id);
    return patchStoredSessionListSummary(id, pending.patch, {
      touchSession: pending.touchSession,
      action: pending.action,
    });
  }

  function clearPendingSessionListSummaryPatch(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const timer = sessionListSummaryPatchTimers.get(id);
    if (timer) clearTimeout(timer);
    sessionListSummaryPatchTimers.delete(id);
    sessionListSummaryPendingPatches.delete(id);
  }

  function scheduleStoredSessionArtifactSummaryRefresh(sessionId: string, { touchSession = true, action = "artifacts", delay = 300 } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const previous = sessionArtifactSummaryRefreshTimers.get(id);
    if (previous) clearTimeout(previous);
    sessionArtifactSummaryRefreshTimers.set(id, setTimeout(() => {
      sessionArtifactSummaryRefreshTimers.delete(id);
      refreshStoredSessionArtifactSummary(id, { touchSession, action }).catch((err) => {
        logger.debug?.("[轻舟] refresh session artifact summary failed:", errorMessage(err));
      });
    }, Math.max(0, Number(delay) || 0)));
  }

  async function refreshStoredSessionArtifactSummary(sessionId: string, { touchSession = true, action = "artifacts" } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) return null;
    const artifacts = await collectSessionArtifactsRuntime(id).catch((err) => {
      logger.debug?.("[轻舟] collect canonical session artifacts failed:", errorMessage(err));
      return emptySessionArtifacts();
    });
    return patchStoredSessionListSummary(
      id,
      createSessionArtifactListSummary(artifacts, nowBeijingDateTime()),
      { touchSession, action, preserveUnchangedArtifactTime: true },
    );
  }

  async function syncSessionArtifactListSummaryRuntime(sessionId: string, artifacts: ArtifactCollections = {}, { action = "summary_reconcile" } = {}) {
    const id = normalizeSessionId(sessionId);
    if (!id) return { updated: false, sessionId: "" };
    const updated = await patchStoredSessionListSummary(
      id,
      createSessionArtifactListSummary(artifacts, nowBeijingDateTime()),
      { touchSession: false, action, preserveUnchangedArtifactTime: true },
    );
    return { updated: Boolean(updated), sessionId: id };
  }

  async function buildSessionListSummaryRuntime(sessionId: string, transcript: readonly unknown[] = [], fallbackAt = nowBeijingDateTime()) {
    const id = normalizeSessionId(sessionId);
    const summaryAt = fallbackAt || nowBeijingDateTime();
    const safeTranscript = transcript.map(objectOrEmpty);
    const artifacts = id
      ? await collectSessionArtifactsRuntime(id, safeTranscript).catch((err) => {
        logger.debug?.("[轻舟] collect session list summary artifacts failed:", errorMessage(err));
        return emptySessionArtifacts();
      })
      : emptySessionArtifacts();
    return mergeSessionListSummary(
      createSessionListSummaryFromTranscript(safeTranscript, summaryAt),
      createSessionArtifactListSummary(artifacts, summaryAt),
    );
  }

  function clearPendingSessionArtifactSummaryRefresh(sessionId: string) {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const timer = sessionArtifactSummaryRefreshTimers.get(id);
    if (timer) clearTimeout(timer);
    sessionArtifactSummaryRefreshTimers.delete(id);
  }

  function preserveArtifactSummaryTime(existingSummary: unknown = {}, patch: SummaryPatch = {}) {
    const existing = mergeSessionListSummary(null, existingSummary);
    const next = mergeSessionListSummary(existing, patch);
    if (
      existing.artifactSignature !== next.artifactSignature
      || existing.artifactCount !== next.artifactCount
      || existing.dataCount !== next.dataCount
      || existing.fileCount !== next.fileCount
    ) {
      return patch;
    }
    return {
      ...patch,
      artifactUpdatedAt: existing.artifactUpdatedAt,
      updatedAt: existing.updatedAt,
    };
  }

  function recordSessionResourceEvent(sessionId: string, event: Fields = {}) {
    if (event?.type !== "tool_execution_end" || event.isError) return;
    const artifacts = collectRunScriptToolArtifacts(event.toolCapabilityId || event.toolName, event.args, event.result);
    if (!artifacts.length) return;
    appendResources({
      sessionId,
      runId: String(event.runId || ""),
      toolCallId: String(event.toolCallId || ""),
      sourceTool: String(event.toolName || ""),
      artifacts,
    })
      .then((items) => {
        scheduleStoredSessionArtifactSummaryRefresh(sessionId, { action: "artifacts", touchSession: true, delay: 220 });
        broadcast({
          type: "session_resources_changed",
          sessionId,
          runId: String(event.runId || ""),
          toolCallId: String(event.toolCallId || ""),
          sourceTool: String(event.toolName || ""),
          artifactCount: Array.isArray(items) ? items.length : 0,
        });
      })
      .catch((err) => {
        logger.debug?.("[轻舟] record session resource artifacts failed:", errorMessage(err));
      });
  }
  async function collectTranscriptArtifactContext(transcript: readonly unknown[] = []) {
    const dataMap = new Map<string, Artifact>();
    const fileMap = new Map<string, Artifact>();
    for (const tool of flattenTranscriptArtifactToolEntries(transcript)) {
      if (!tool || tool.isError || tool.isRunning) continue;
      const name = toolCapabilityName(tool);
      const args = objectOrEmpty(tool.args);
      const result = objectOrEmpty(tool.result);
      const toolTime = artifactToolTime(tool);
      collectExplicitTranscriptArtifacts(dataMap, fileMap, projectToolArtifacts(name, args, result), toolTime);
    }

    const tablesMeta = await getArtifactTableMeta();
    const dataItems = [...dataMap.values()]
      .map((item) => enrichDataArtifact(item, tablesMeta.get(item.table || item.title || "")))
      .sort(compareArtifactContextItems)
      .slice(0, SESSION_ARTIFACT_TABLE_LIMIT);
    const imageCollections = dataItems.filter(item => item.kind === "image_collection");
    const dataTables = dataItems.filter(item => item.kind !== "image_collection");
    const files = [...fileMap.values()]
      .sort(compareArtifactContextItems)
      .slice(0, SESSION_ARTIFACT_FILE_LIMIT)
      .map(compactFileArtifactForContext);

    return {
      summary: {
        dataTables: dataTables.length,
        imageCollections: imageCollections.length,
        files: files.length,
        note: t("artifact.contextNote"),
      },
      dataTables: dataTables.map(compactDataArtifactForContext),
      imageCollections: imageCollections.map(compactDataArtifactForContext),
      files,
    };
  }

  function flattenTranscriptArtifactToolEntries(history: readonly unknown[] = []): Fields[] {
    const out = [];
    for (const rawEntry of history) {
      const entry = objectOrEmpty(rawEntry);
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "tool") {
        out.push(entry);
        continue;
      }
      if (entry.type === "tool-group") {
        const tools = Array.isArray(entry.tools)
          ? entry.tools
          : (Array.isArray(entry.items) ? entry.items : []);
        out.push(...tools.map(objectOrEmpty).filter(tool => tool.type === "tool" || tool.name));
      }
    }
    return out;
  }

  function toolCapabilityName(toolOrName: unknown) {
    if (toolOrName && typeof toolOrName === "object" && !Array.isArray(toolOrName)) {
      return String(objectOrEmpty(toolOrName).capabilityId || objectOrEmpty(toolOrName).name || "").trim();
    }
    const name = String(toolOrName || "").trim();
    return name ? getToolIdentity(name).capabilityId : "";
  }

  function collectExplicitTranscriptArtifacts(dataMap: Map<string, Artifact>, fileMap: Map<string, Artifact>, artifacts: Fields[], fallbackTime = "") {
    for (const item of artifacts) {
      if (isLegacyBriefArtifact(item) || isIntermediateArtifact(item, toolCapabilityName)) continue;
      const type = String(item.type || item.kind || "").trim().toLowerCase();
      if (type === "data" || type === "table" || item.table || item.totalRows != null || item.rowCount != null) {
        upsertDataArtifact(dataMap, {
          id: normalizeDataArtifactKey(item.table || item.title || item.name || item.id || ""),
          title: normalizeDataArtifactKey(item.title || item.table || item.name || item.id || ""),
          table: normalizeDataArtifactKey(item.table || item.title || item.name || item.id || ""),
          kind: normalizeArtifactKind(item),
          totalRows: positiveArtifactNumber(item.totalRows ?? item.totalMatched ?? item.rowCount ?? item.count ?? (Array.isArray(item.rows) ? item.rows.length : 0)),
          columns: normalizeArtifactColumns(item.columns),
          action: String(item.action || "").trim(),
          sourceTool: String(item.sourceTool || "").trim(),
          updatedAt: resolveArtifactUpdatedAt(item, fallbackTime),
          score: positiveArtifactNumber(item.score) || 1,
        });
        continue;
      }
      if (type === "file" || type === "download" || type === "document" || item.filename || item.url || item.fileUrl || item.finalUrl) {
        upsertFileArtifact(fileMap, normalizeFileArtifact({
          ...item,
          sourceTool: item.sourceTool || "",
        }, fallbackTime));
      }
    }
  }

  async function getArtifactTableMeta() {
    const out = new Map<string, DataTable>();
    try {
      for (const table of await listTables()) {
        if (!table?.name) continue;
        out.set(table.name, table);
      }
    } catch (err) {
      logger.debug?.("[轻舟] collect artifact table meta failed:", errorMessage(err));
    }
    return out;
  }

  function enrichDataArtifact(item: Artifact = {}, table: DataTable | null | undefined = null) {
    const kind = item.kind || (isImageCollectionTable(table) ? "image_collection" : "");
    const totalRows = positiveArtifactNumber(table?.count) || positiveArtifactNumber(item.totalRows);
    const columns = normalizeArtifactColumns(table?.columns || item.columns).slice(0, SESSION_ARTIFACT_COLUMN_LIMIT);
    return {
      ...item,
      kind,
      totalRows,
      columns,
      updatedAt: table?.updatedAt || item.updatedAt || "",
    };
  }

  function compactDataArtifactForContext(item: Artifact = {}) {
    const type = item.kind === "image_collection" ? "imageCollection" : "dataTable";
    const totalRows = positiveArtifactNumber(item.totalRows);
    return {
      type,
      table: item.table || item.title || "",
      title: item.title || item.table || "",
      summary: dataArtifactSummary(type, totalRows),
      totalRows,
      columns: (item.columns || []).slice(0, SESSION_ARTIFACT_COLUMN_LIMIT),
      sourceTool: item.sourceTool || "",
      action: item.action || "",
      updatedAt: item.updatedAt || "",
      usage: t(type === "imageCollection" ? "artifact.imageUsage" : "artifact.tableUsage"),
    };
  }

  function compactFileArtifactForContext(item: Artifact = {}) {
    return {
      type: "file",
      filename: item.filename,
      title: item.title || item.filename,
      format: item.format || artifactFileExtension(item.filename),
      size: item.size || 0,
      sizeLabel: artifactFormatBytes(item.size),
      downloadId: item.downloadId || "",
      artifactId: item.artifactId || "",
      fileId: item.fileId || "",
      url: item.url || "",
      sourceTool: item.sourceTool || "",
      updatedAt: item.updatedAt || "",
      usage: t("artifact.fileUsage"),
    };
  }

  function upsertDataArtifact(map: Map<string, Artifact>, item: Fields = {}) {
    const table = normalizeDataArtifactKey(item.table || item.id || item.title || "");
    if (!table) return;
    const next = {
      id: table,
      title: normalizeDataArtifactKey(item.title || table),
      table,
      kind: String(item.kind || ""),
      totalRows: positiveArtifactNumber(item.totalRows),
      columns: normalizeArtifactColumns(item.columns),
      action: String(item.action || "").trim(),
      sourceTool: String(item.sourceTool || "").trim(),
      updatedAt: resolveArtifactUpdatedAt(item),
      score: positiveArtifactNumber(item.score) || 1,
    };
    const existing = map.get(table);
    map.set(table, mergeArtifactItems(existing, next));
  }

  function upsertFileArtifact(map: Map<string, Artifact>, item: Artifact | null = null) {
    if (!item?.filename) return;
    const id = String(item.id || item.downloadId || item.artifactId || item.fileId || item.url || item.filename || "").trim();
    if (!id) return;
    let key = findSessionArtifactMergeKey(map, item, id);
    const existing = map.get(key);
    if (!existing && !isDownloadableSessionFileArtifact(item)) return;
    const merged = mergeArtifactItems(existing, { ...item, id });
    if (merged?.id && merged.id !== key && !map.has(merged.id)) {
      map.delete(key);
      key = merged.id;
    }
    map.set(key, merged);
  }

  function normalizeFileArtifact(item: Fields = {}, fallbackTime = "") {
    if (isLegacyBriefArtifact(item) || isIntermediateArtifact(item, toolCapabilityName)) return null;
    return projectFileArtifact(item, fallbackTime);
  }

  function isLegacyBriefArtifact(item: Fields = {}) {
    const type = String(item.type || item.kind || "").trim().toLowerCase();
    if (type === "report" || type === "brief") return true;
    const filename = String(item.filename || item.title || item.name || "").trim().toLowerCase();
    if (!filename) return false;
    return /^轻舟简报(?:\.html?)?$/.test(filename) || /^任务简报(?:\.html?)?$/.test(filename);
  }

  function compareArtifactContextItems(a: Artifact = {}, b: Artifact = {}) {
    const timeDiff = artifactTimeMs(b.updatedAt) - artifactTimeMs(a.updatedAt);
    if (timeDiff) return timeDiff;
    const scoreDiff = positiveArtifactNumber(b.score) - positiveArtifactNumber(a.score);
    if (scoreDiff) return scoreDiff;
    const countDiff = positiveArtifactNumber(b.totalRows) - positiveArtifactNumber(a.totalRows);
    if (countDiff) return countDiff;
    return String(a.title || a.filename || "").localeCompare(String(b.title || b.filename || ""), "zh-Hans-CN");
  }

  function mergeArtifactItems(existing: Artifact | undefined = undefined, next: Artifact = {}): Artifact {
    if (!existing) return next;
    const richer = artifactCompletenessScore(next) >= artifactCompletenessScore(existing) ? next : existing;
    const older = richer === next ? existing : next;
    const newest = artifactTimeMs(next.updatedAt) >= artifactTimeMs(existing.updatedAt) ? next : existing;
    const merged: Artifact = {
      ...older,
      ...richer,
      score: Math.max(positiveArtifactNumber(existing.score), positiveArtifactNumber(next.score)),
      totalRows: Math.max(positiveArtifactNumber(existing.totalRows), positiveArtifactNumber(next.totalRows)) || richer.totalRows || older.totalRows,
      updatedAt: newest.updatedAt || richer.updatedAt || older.updatedAt || "",
    };
    for (const key of ["downloadId", "artifactId", "fileId", "url", "format", "size", "sizeLabel"]) {
      merged[key] = richer[key] || older[key] || "";
    }
    return merged;
  }

  function artifactCompletenessScore(item: Artifact = {}) {
    let score = positiveArtifactNumber(item.score) * 10;
    if (item.totalRows) score += 2;
    if (Array.isArray(item.columns) && item.columns.length) score += 2;
    if (item.size || item.sizeLabel) score += 1;
    if (item.downloadId || item.artifactId || item.fileId || item.url) score += 4;
    return score;
  }

  function normalizeArtifactKind(item: Fields) {
    if (item.kind === "image_collection" || item.type === "imageCollection") return "image_collection";
    if (item.kind === "data_table" || item.type === "dataTable") return "";
    const text = String(item.kind || item.kindLabel || "").trim().toLowerCase();
    if (text === "image_collection" || text.includes("图集") || text.includes("image")) return "image_collection";
    return "";
  }

  function normalizeArtifactColumns(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => String(item?.key || item?.name || item?.label || item || "").trim())
      .filter(Boolean)
      .slice(0, 50);
  }

  function objectOrEmpty(value: unknown): Fields {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
  }

  function isImageCollectionTable(table: DataTable | null | undefined) {
    return String(table?.kind || "").trim() === "image_collection"
      || String(table?.assetKind || "").trim() === "image";
  }

  async function collectSessionArtifactsRuntime(sessionId: string, transcript: readonly unknown[] | null = null): Promise<SessionArtifacts> {
    const id = normalizeSessionId(sessionId);
    if (!id) return emptySessionArtifacts();
    const source = Array.isArray(transcript) ? transcript : await resolveSessionArtifactTranscript(id);
    const [flowArtifacts, ledgerArtifacts] = await Promise.all([
      collectTranscriptArtifactContext(source).catch((err) => {
        logger.debug?.("[轻舟] collect session flow artifacts failed:", errorMessage(err));
        return { dataTables: [], imageCollections: [], files: [] };
      }),
      listResources(id).catch((err) => {
        logger.debug?.("[轻舟] collect session ledger artifacts failed:", errorMessage(err));
        return [];
      }),
    ]);
    const ledger = splitSessionResourceArtifacts(ledgerArtifacts);

    const dataItems = mergeSessionDataArtifacts(
      normalizeSessionArtifactList(flowArtifacts?.imageCollections, compactSessionDataArtifact),
      normalizeSessionArtifactList(flowArtifacts?.dataTables, compactSessionDataArtifact),
      normalizeSessionArtifactList(ledger.imageCollections, compactSessionDataArtifact),
      normalizeSessionArtifactList(ledger.dataTables, compactSessionDataArtifact),
    );
    const imageCollections = dataItems
      .filter(item => item.type === "imageCollection")
      .sort(compareSessionArtifactItems);
    const dataTables = dataItems
      .filter(item => item.type === "dataTable")
      .sort(compareSessionArtifactItems);
    const files = mergeSessionArtifactItems(
      normalizeSessionArtifactList(flowArtifacts?.files, compactSessionFileArtifact),
      normalizeSessionArtifactList(ledger.files, compactSessionFileArtifact),
    ).sort(compareSessionArtifactItems);
    const items = [...imageCollections, ...dataTables, ...files].sort(compareSessionArtifactItems);
    return {
      total: items.length,
      summary: {
        total: items.length,
        imageCollections: imageCollections.length,
        dataTables: dataTables.length,
        files: files.length,
        note: t("artifact.indexNote"),
      },
      items,
      imageCollections,
      dataTables,
      files,
    };
  }
  async function hydrateSessionListSummariesRuntime({ sessionIds = [], limit = 24, force = false }: { sessionIds?: unknown; limit?: number; force?: boolean } = {}) {
    await ready();
    const max = Math.max(1, Math.min(80, Math.floor(Number(limit) || 24)));
    const sessions = await getSessions();
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
      .map(normalizeSessionId)
      .filter((id) => id && sessions[id]))]
      .slice(0, max);
    if (!ids.length) return { updated: 0, sessionIds: [] };

    const patches = [];
    for (const id of ids) {
      const session = sessions[id];
      if (!force && !isStoredSessionListSummaryStale(session?.listSummary)) continue;
      const fallbackAt = session?.updatedAt || session?.createdAt || nowBeijingDateTime();
      const transcript = await resolveSessionArtifactTranscript(id).catch(() => []);
      const patch = await buildSessionListSummaryRuntime(id, transcript, fallbackAt);
      patches.push({ id, patch });
    }
    if (!patches.length) return { updated: 0, sessionIds: [] };

    const updatedSessionIds = [];
    for (const { id, patch } of patches) {
      const result = await sessionRepository.updateMetadata(id, (current) => {
        const sessions = { [id]: current };
        const effectivePatch = preserveArtifactSummaryTime(current.listSummary, patch);
        return applySessionListSummaryPatchToSessions(sessions, id, effectivePatch, { touchSession: false }) || null;
      });
      if (result.changed) updatedSessionIds.push(id);
    }
    if (updatedSessionIds.length) {
      broadcast({ type: "sessions_changed", action: "summary_backfill" });
    }
    return {
      updated: updatedSessionIds.length,
      sessionIds: updatedSessionIds,
    };
  }

  function isStoredSessionListSummaryStale(summary: unknown) {
    const normalized = mergeSessionListSummary(null, summary);
    if (objectOrEmpty(summary).version !== SESSION_LIST_SUMMARY_VERSION || !normalized.updatedAt) return true;
    return hasRepeatedArtifactPreviewTokens(normalized);
  }

  function hasRepeatedArtifactPreviewTokens(summary: SummaryPatch = {}) {
    const count = Number(summary.artifactCount || 0);
    if (count <= 1) return false;
    const tokens = String(summary.artifactPreview || "")
      .split("·")
      .map(token => token.trim())
      .filter(Boolean);
    return tokens.length > 1 && new Set(tokens).size < tokens.length;
  }
  function emptySessionArtifacts(): SessionArtifacts {
    return {
      total: 0,
      summary: { total: 0, imageCollections: 0, dataTables: 0, files: 0 },
      items: [],
      imageCollections: [],
      dataTables: [],
      files: [],
    };
  }

  function normalizeSessionArtifactList(items: unknown, mapper: (item: Fields) => Artifact | null): Artifact[] {
    if (!Array.isArray(items)) return [];
    return items.map(item => mapper(objectOrEmpty(item))).filter((item): item is Artifact => item !== null);
  }

  function splitSessionResourceArtifacts(items: readonly Fields[] = []) {
    const out: { dataTables: Fields[]; imageCollections: Fields[]; files: Fields[] } = { dataTables: [], imageCollections: [], files: [] };
    for (const resource of Array.isArray(items) ? items : []) {
      const [item] = projectToolArtifacts(toolCapabilityName(resource.sourceTool), {}, { artifacts: [resource] }, "resource");
      if (!item) continue;
      const type = String(item?.type || "").trim();
      if (normalizeArtifactKind(item) === "image_collection") {
        out.imageCollections.push({ ...item, type: "imageCollection" });
      } else if (type === "data" || item?.table) {
        out.dataTables.push({ ...item, type: "dataTable" });
      } else {
        out.files.push(item);
      }
    }
    return out;
  }

  function mergeSessionArtifactItems(...lists: Artifact[][]) {
    const byId = new Map<string, Artifact>();
    for (const item of lists.flat()) {
      if (!item) continue;
      const key = String(item.id || item.table || item.filename || item.title || "").trim();
      if (!key) continue;
      let mergeKey = findSessionArtifactMergeKey(byId, item, key);
      const previous = byId.get(mergeKey);
      if (!previous && !isDownloadableSessionFileArtifact(item)) continue;
      const merged: Artifact = {
        ...(previous || {}),
        ...item,
        createdAt: previous?.createdAt || item.createdAt,
        updatedAt: newerSessionArtifactTime(previous?.updatedAt, item.updatedAt),
      };
      for (const field of ["downloadId", "artifactId", "fileId", "url", "format", "size", "sizeLabel"]) {
        merged[field] = item[field] || previous?.[field] || "";
      }
      if (merged.id && merged.id !== mergeKey && !byId.has(merged.id)) {
        byId.delete(mergeKey);
        mergeKey = merged.id;
      }
      byId.set(mergeKey, merged);
    }
    return [...byId.values()];
  }

  function mergeSessionDataArtifacts(...lists: Artifact[][]) {
    const byTable = new Map<string, Artifact>();
    for (const item of lists.flat()) {
      if (!item) continue;
      const table = normalizeDataArtifactKey(item.table || sessionDataArtifactTableFromId(item.id) || item.title || "");
      if (!table) continue;
      const previous = byTable.get(table);
      const merged: Artifact = {
        ...(previous || {}),
        ...item,
        id: "",
        table,
        createdAt: previous?.createdAt || item.createdAt,
        updatedAt: newerSessionArtifactTime(previous?.updatedAt, item.updatedAt),
      };
      if (previous?.type === "imageCollection" || item.type === "imageCollection") {
        merged.type = "imageCollection";
      } else {
        merged.type = "dataTable";
      }
      // Labels and count summaries are projections, regenerated after merging stable facts.
      merged.kindLabel = t(merged.type === "imageCollection" ? "artifact.imageCollection" : "artifact.dataTable");
      merged.summary = dataArtifactSummary(merged.type, positiveArtifactNumber(merged.totalRows));
      merged.id = `${merged.type}:${table}`;
      byTable.set(table, merged);
    }
    return [...byTable.values()];
  }

  function sessionDataArtifactTableFromId(id: unknown) {
    return String(id || "").trim().replace(/^(?:imageCollection|dataTable):/i, "");
  }

  function findSessionArtifactMergeKey(map: Map<string, Artifact>, item: Artifact = {}, fallbackKey = "") {
    return findFileArtifactMergeKey(map, item, fallbackKey, sessionFileArtifactDedupeKey);
  }

  function sessionFileArtifactDedupeKey(item: Fields = {}) {
    return item.type && String(item.type).trim() !== "file" ? "" : fileArtifactDedupeKey(item);
  }

  function isDownloadableSessionFileArtifact(item: Fields = {}) {
    const type = String(item.type || "").trim();
    if (type && type !== "file") return true;
    return Boolean(sessionFileArtifactDownloadId(item) || sessionFileArtifactUrl(item));
  }

  function compactSessionDataArtifact(item: Fields = {}) {
    const type = item.type === "imageCollection" ? "imageCollection" : "dataTable";
    const table = String(item.table || item.title || "").trim();
    const totalRows = positiveArtifactNumber(item.totalRows);
    return compactSessionArtifactObject({
      id: table ? `${type}:${table}` : "",
      type,
      title: item.title || table,
      table,
      totalRows,
      columns: Array.isArray(item.columns) ? item.columns.slice(0, SESSION_ARTIFACT_COLUMN_LIMIT) : [],
      sourceTool: item.sourceTool || "",
      updatedAt: item.updatedAt || "",
      action: item.action || "",
    });
  }

  function dataArtifactSummary(type: string, totalRows: number) {
    const imageCollection = type === "imageCollection";
    return totalRows
      ? t(imageCollection ? "artifact.imageSummary" : "artifact.tableSummary", { count: formatNumber(totalRows) })
      : t(imageCollection ? "artifact.imageCollection" : "artifact.dataTable");
  }

  function compactSessionFileArtifact(item: Fields = {}) {
    const filename = String(item.filename || item.title || "").trim();
    if (!filename) return null;
    return compactSessionArtifactObject({
      id: item.downloadId
        ? `download:${item.downloadId}`
        : item.artifactId
          ? `artifact:${item.artifactId}`
          : item.fileId
            ? `docfile:${item.fileId}`
            : item.url
              ? `url:${item.url}`
              : `file:${filename}`,
      type: "file",
      kindLabel: t("artifact.file"),
      title: item.title || filename,
      filename,
      format: item.format || artifactFileExtension(filename),
      size: positiveArtifactNumber(item.size),
      sizeLabel: item.sizeLabel || artifactFormatBytes(item.size),
      downloadId: item.downloadId || "",
      artifactId: item.artifactId || "",
      fileId: item.fileId || "",
      url: item.url || "",
      sourceTool: item.sourceTool || "",
      updatedAt: item.updatedAt || "",
    });
  }

  function compactSessionArtifactObject(item: Fields = {}): Fields | null {
    const out: Fields = {};
    for (const [key, value] of Object.entries(item || {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  }

  function compareSessionArtifactItems(a: Fields = {}, b: Fields = {}) {
    const timeDiff = artifactTimeMs(b.updatedAt || b.generatedAt || b.createdAt) - artifactTimeMs(a.updatedAt || a.generatedAt || a.createdAt);
    if (timeDiff) return timeDiff;
    const scoreDiff = positiveArtifactNumber(b.score) - positiveArtifactNumber(a.score);
    if (scoreDiff) return scoreDiff;
    return String(a.title || a.filename || "").localeCompare(String(b.title || b.filename || ""), "zh-Hans-CN");
  }

  function newerSessionArtifactTime(a: string | undefined = "", b: string | undefined = "") {
    if (!a) return b || "";
    if (!b) return a || "";
    return artifactTimeMs(a) >= artifactTimeMs(b) ? a : b;
  }

  return Object.freeze({
    scheduleListSummaryPatch: scheduleStoredSessionListSummaryPatch,
    clearListSummaryPatch: clearPendingSessionListSummaryPatch,
    scheduleSummaryRefresh: scheduleStoredSessionArtifactSummaryRefresh,
    clearSummaryRefresh: clearPendingSessionArtifactSummaryRefresh,
    syncSummary: syncSessionArtifactListSummaryRuntime,
    buildListSummary: buildSessionListSummaryRuntime,
    recordResourceEvent: recordSessionResourceEvent,
    collectContext: collectTranscriptArtifactContext,
    collect: collectSessionArtifactsRuntime,
    empty: emptySessionArtifacts,
    hydrateListSummaries: hydrateSessionListSummariesRuntime,
  });
}
