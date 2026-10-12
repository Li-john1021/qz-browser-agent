import { t } from "../../shared/i18n/backend.js";
import {
  getDocumentModel,
  saveDocumentFile,
  saveDocumentModel,
  summarizeModelRecord,
} from "../../shared/documents/document-store.js";
import { inferDocumentFormat, parseDocumentBytes } from "../../shared/documents/document-codecs.js";
import {
  listDocumentTables,
  projectDocumentContent,
  projectDocumentTable,
} from "../../shared/documents/document-read-projection.js";
import { resolveSkillHostTarget } from "./skill-host-registry.js";
import {
  decodeSkillResourceBytes,
  inferSkillResourceMimeType,
  isBase64SkillResource,
  isSkillDocumentResource,
} from "../../shared/skills/skill-utils.js";

import type { SavedDocumentModel } from "../../shared/documents/document-store.js";
import type { SkillResource, SkillRecord } from "../../shared/skills/skill-utils.js";
type Fields = Record<string, unknown>;
interface SkillDocumentOptions {
  parseBytes?: typeof parseDocumentBytes; saveFile?: typeof saveDocumentFile; saveModel?: typeof saveDocumentModel;
  getModel?: typeof getDocumentModel; digest?(bytes: Uint8Array): Promise<string>;
  resolveSkillTool?: typeof resolveSkillHostTarget;
}
interface SkillDocumentInput { skill?: Partial<SkillRecord>; resource?: Partial<SkillResource>; path?: string; displayName?: string }
interface DocumentRuntime { signal?: AbortSignal; context?: { sessionId?: string; runId?: string | null; toolCallId?: string; source?: string } }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : error;

const MAX_SKILL_DOCUMENT_BYTES = 12 * 1024 * 1024;
const DEFAULT_SHEET_PREVIEW_ROWS = 50;

export class SkillDocumentResourceError extends Error {
  constructor(readonly code: string, message: string, readonly details: Fields = {}) {
    super(message);
    this.name = "SkillDocumentResourceError";
  }
}

export function createSkillDocumentResourceService(options: SkillDocumentOptions = {}) {
  const parseBytes = options.parseBytes || parseDocumentBytes;
  const saveFile = options.saveFile || saveDocumentFile;
  const saveModel = options.saveModel || saveDocumentModel;
  const getModel = options.getModel || getDocumentModel;
  const digest = options.digest || sha256Hex;
  const resolveSkillTool = options.resolveSkillTool || resolveSkillHostTarget;

  async function load(input: SkillDocumentInput = {}, runtime: DocumentRuntime = {}) {
    throwIfAborted(runtime.signal);
    const skill = input.skill || {};
    const resource = input.resource || {};
    const path = String(input.path || resource.path || "").trim();
    if (!isSkillDocumentResource({ ...resource, path })) {
      throw new SkillDocumentResourceError(
        "SKILL_DOCUMENT_FORMAT_UNSUPPORTED",
        t("skill.documentUnsupported", { path: String(path) }),
        { name: skill.name || "", path },
      );
    }
    if (!isBase64SkillResource(resource)) {
      throw new SkillDocumentResourceError(
        "SKILL_DOCUMENT_BINARY_MISSING",
        t("skill.documentBinaryMissing", { path: String(path) }),
        { name: skill.name || "", path },
      );
    }
    const context = runtime.context || {};
    const sessionId = String(context.sessionId || "").trim();
    if (!sessionId) {
      throw new SkillDocumentResourceError(
        "SKILL_DOCUMENT_SESSION_REQUIRED",
        t("skill.documentSessionRequired"),
        { name: skill.name || "", path },
      );
    }

    let bytes;
    try {
      bytes = decodeSkillResourceBytes(resource);
    } catch (error) {
      throw new SkillDocumentResourceError(
        "SKILL_DOCUMENT_BINARY_INVALID",
        t("skill.documentBase64Invalid", { path: String(path) }),
        { name: skill.name || "", path, cause: String(errorMessage(error)) },
      );
    }
    if (!bytes.byteLength || bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) {
      throw new SkillDocumentResourceError(
        bytes.byteLength ? "SKILL_DOCUMENT_TOO_LARGE" : "SKILL_DOCUMENT_BINARY_MISSING",
        bytes.byteLength ? t("skill.documentTooLarge", { path: String(path) }) : t("skill.documentEmpty", { path: String(path) }),
        { name: skill.name || "", path, size: bytes.byteLength, maxBytes: MAX_SKILL_DOCUMENT_BYTES },
      );
    }

    const mimeType = String(resource.mimeType || inferSkillResourceMimeType(path)).trim();
    const format = inferDocumentFormat({ filename: path, mimeType });
    const fingerprint = await digest(new TextEncoder().encode([
      sessionId,
      skill.name || "",
      path,
      resource.content || "",
    ].join("\u0000")));
    const suffix = String(fingerprint || "").replace(/[^a-z0-9]/giu, "").slice(0, 40);
    const fileId = `file_skill_${suffix}`;
    const docModelId = `model_skill_${suffix}`;
    throwIfAborted(runtime.signal);

    let model: Partial<SavedDocumentModel> | undefined = await getModel(docModelId);
    throwIfAborted(runtime.signal);
    if (!model) {
      const meta = documentMeta(context);
      let parsed;
      try {
        parsed = await parseBytes(bytes, {
          filename: path,
          mimeType,
          chunkSize: 6000,
          signal: runtime.signal,
        });
      } catch (error) {
        throwIfAborted(runtime.signal);
        throw new SkillDocumentResourceError(
          "SKILL_DOCUMENT_PARSE_FAILED",
          t("skill.documentParseFailure", { path: String(path), reason: String(errorMessage(error)) }),
          { name: skill.name || "", path, format },
        );
      }
      throwIfAborted(runtime.signal);
      await saveFile({
        id: fileId,
        filename: path.split("/").pop() || path,
        mimeType,
        extension: format,
        size: bytes.byteLength,
        base64: String(resource.content || ""),
        ...meta,
      });
      throwIfAborted(runtime.signal);
      await saveModel({ id: docModelId, ...parsed, fileId, ...meta });
      throwIfAborted(runtime.signal);
      model = { id: docModelId, ...parsed, fileId, ...meta };
    }

    const preview = buildDocumentPreview(model);
    const summary = summarizeModelRecord(model) || {};
    const reader = preview.truncated ? resolveSkillTool("document_read_chunk") : null;
    return {
      name: skill.name || "",
      displayName: input.displayName || skill.displayName || skill.name || "",
      path,
      type: resource.type || "asset",
      title: resource.title || path.split("/").pop() || path,
      description: resource.description || "",
      size: bytes.byteLength,
      mimeType,
      format,
      content: preview.content,
      truncated: preview.truncated,
      ...preview.structured,
      document: {
        ...summary,
        fileId,
        docModelId,
        format,
      },
      ...(reader ? {
        next: {
          loadSkill: reader.skillName,
          tool: reader.toolName,
          args: preview.nextArgs,
        },
      } : {}),
      note: preview.truncated
        ? reader
          ? t("skill.documentReadNext", { skill: String(reader.skillName), tool: String(reader.toolName) })
          : t("skill.documentPreviewOnly")
        : t("skill.documentParsed"),
    };
  }

  return Object.freeze({ load });
}

function buildDocumentPreview(model: Partial<SavedDocumentModel> = {}) {
  const sheets = Array.isArray(model.sheets) ? model.sheets : [];
  if (model.type === "xlsx" || (sheets.length && !model.blocks?.length)) {
    const sheetTables = listDocumentTables(model).filter(table => table.kind === "sheet");
    const firstTable = sheetTables[0];
    const page: Pick<ReturnType<typeof projectDocumentTable>, "tableId" | "sheetName" | "columns" | "rows" | "offset" | "limit" | "totalRows" | "next"> = firstTable
      ? projectDocumentTable(model, firstTable, { offset: 0, limit: DEFAULT_SHEET_PREVIEW_ROWS })
      : {
          tableId: "sheet:0",
          sheetName: "Sheet1",
          columns: [],
          rows: [],
          offset: 0,
          limit: DEFAULT_SHEET_PREVIEW_ROWS,
          totalRows: 0,
        };
    const nextTable = page.next ? null : sheetTables[1];
    return {
      content: tablePreviewText(page.columns, page.rows),
      truncated: Boolean(page.next || nextTable),
      structured: {
        contentFormat: "tsv",
        tableId: page.tableId,
        sheetName: page.sheetName,
        columns: page.columns,
        offset: page.offset,
        limit: page.limit,
        totalRows: page.totalRows,
        rows: page.rows,
      },
      nextArgs: page.next
        ? {
            docModelId: model.id,
            sheetName: page.sheetName,
            offset: page.next.offset,
            limit: page.next.limit,
          }
        : (nextTable ? {
            docModelId: model.id,
            sheetName: nextTable.sheetName,
            offset: 0,
            limit: DEFAULT_SHEET_PREVIEW_ROWS,
          } : null),
    };
  }

  const page = projectDocumentContent(model, { chunkIndex: 0 });
  return {
    content: page.content,
    truncated: Boolean(page.next),
    structured: {
      contentFormat: page.contentFormat,
      chunk: page.chunk,
      tables: page.tables,
    },
    nextArgs: page.next ? { docModelId: model.id, ...page.next } : null,
  };
}

function tablePreviewText(columns: readonly string[] = [], rows: readonly unknown[] = []) {
  return [
    columns.join("\t"),
    ...rows.map(row => columns.map(column => (row && typeof row === "object" ? (row as Fields)[column] : undefined) ?? "").join("\t")),
  ].filter(Boolean).join("\n");
}

function documentMeta(context: NonNullable<DocumentRuntime["context"]> = {}) {
  return {
    sessionId: String(context.sessionId || "").slice(0, 120),
    runId: String(context.runId || "").slice(0, 120),
    toolCallId: String(context.toolCallId || "").slice(0, 120),
    sourceTool: "load_skill_resource",
  };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new SkillDocumentResourceError("OPERATION_ABORTED", t("skill.documentAborted"));
}

async function sha256Hex(value: Uint8Array) {
  const bytes = Uint8Array.from(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
