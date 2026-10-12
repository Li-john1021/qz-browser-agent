import { t } from "../i18n/backend.js";
export interface MessageDocument {
  sessionId: string;
  messageId: string;
  attachmentId: string;
  fileId: string;
  docModelId: string;
  filename: string;
  mimeType: string;
  format: string;
  size: number;
}
interface AttachmentIdentity { sessionId?: unknown; messageId?: unknown; clientMessageId?: unknown; attachmentId?: unknown }

const ID_LIMIT = 160;
const NAME_LIMIT = 240;
const MIME_LIMIT = 160;
const FORMAT_LIMIT = 24;

/** Ready document reference persisted on a user message and sent over the wire. */
export function normalizeMessageDocument(value: unknown = {}): MessageDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const document = {
    sessionId: clip(input.sessionId, ID_LIMIT),
    messageId: clip(input.messageId || input.clientMessageId, ID_LIMIT),
    attachmentId: clip(input.attachmentId, ID_LIMIT),
    fileId: clip(input.fileId, ID_LIMIT),
    docModelId: clip(input.docModelId, ID_LIMIT),
    filename: clip(input.filename || "document", NAME_LIMIT),
    mimeType: clip(input.mimeType || "application/octet-stream", MIME_LIMIT),
    format: clip(input.format, FORMAT_LIMIT).toLowerCase(),
    size: Math.max(0, Number(input.size) || 0),
  };
  if (!document.sessionId || !document.messageId || !document.attachmentId) return null;
  if (!document.fileId || !document.docModelId) return null;
  return document;
}

export function normalizeMessageDocuments(values: unknown = []): MessageDocument[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const documents = [];
  for (const value of values) {
    const document = normalizeMessageDocument(value);
    if (!document) continue;
    const key = documentAttachmentKey(document);
    if (seen.has(key)) continue;
    seen.add(key);
    documents.push(document);
  }
  return documents;
}

export function documentAttachmentKey(input: AttachmentIdentity = {}) {
  return [input.sessionId, input.messageId || input.clientMessageId, input.attachmentId]
    .map(part => clip(part, ID_LIMIT))
    .join("::");
}

export function assertMessageDocumentOwnership(documents: unknown = [], { sessionId = "", messageId = "" } = {}) {
  const expectedSessionId = clip(sessionId, ID_LIMIT);
  const expectedMessageId = clip(messageId, ID_LIMIT);
  const source = Array.isArray(documents) ? documents : [];
  const normalized = normalizeMessageDocuments(source);
  if (normalized.length !== source.length) throw attachmentError("DOCUMENT_ATTACHMENT_INVALID", t("attachment.invalidReference"));
  for (const document of normalized) {
    if (document.sessionId !== expectedSessionId || document.messageId !== expectedMessageId) {
      throw attachmentError("DOCUMENT_ATTACHMENT_OWNER_MISMATCH", t("attachment.foreignMessage"));
    }
  }
  return normalized;
}

function attachmentError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function clip(value: unknown, limit: number) {
  return String(value || "").trim().slice(0, limit);
}
