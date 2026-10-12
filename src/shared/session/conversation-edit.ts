import { t } from "../i18n/backend.js";
import type { TranscriptImage } from "../contracts/session.js";
import type { ModelMessage } from "../contracts/model-message.js";
import type { MessageDocument } from "../documents/document-attachments.js";
export interface UserImage { dataUrl: string; type: string; name: string }
interface EditableTranscript { type?: string; clientMessageId?: unknown; editedAt?: string }
interface TranscriptEdit {
  clientMessageId?: string;
  text?: string;
  images?: readonly TranscriptImage[];
  documents?: readonly MessageDocument[];
  now?: string | (() => string);
}

import { isHiddenContextUserMessage } from "../message-blocks.js";

export function normalizeEditMessageId(value: unknown = "") {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : "";
}

export function findEditableUserMessageIndex(messages: readonly ModelMessage[] = [], clientMessageId = "") {
  const id = normalizeEditMessageId(clientMessageId);
  const source: readonly ModelMessage[] = Array.isArray(messages) ? messages : [];
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const msg = source[i];
    if (!msg || msg.role !== "user") continue;
    if (isHiddenContextUserMessage(msg)) continue;
    if (!id || normalizeEditMessageId(msg.clientMessageId) === id) return i;
  }
  return -1;
}

export function extractUserMessageImages(message: { content?: unknown } = {}): UserImage[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    const url = part?.image_url?.url;
    if (part?.type === "image_url" && typeof url === "string" && url.startsWith("data:image/")) {
      out.push({
        dataUrl: url,
        type: dataUrlMimeType(url),
        name: "",
      });
    }
  }
  return out;
}

export function normalizeUserImageInputs(images: readonly unknown[] = []): UserImage[] {
  if (!Array.isArray(images)) return [];
  const out = [];
  for (const item of images) {
    const image = item as Partial<Record<keyof UserImage, unknown>> | null;
    const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
    if (!dataUrl.startsWith("data:image/")) continue;
    out.push({
      dataUrl,
      type: typeof image?.type === "string" && image.type ? image.type : dataUrlMimeType(dataUrl),
      name: typeof image?.name === "string" ? image.name : "",
    });
  }
  return out;
}

export function replaceUserMessageAndTruncate(messages: readonly ModelMessage[] = [], replacement: ModelMessage, { clientMessageId = "" } = {}) {
  const source: readonly ModelMessage[] = Array.isArray(messages) ? messages : [];
  const targetIndex = findEditableUserMessageIndex(source, clientMessageId);
  if (targetIndex < 0) throw new Error(t("session.editMissing"));
  if (!replacement || replacement.role !== "user") throw new Error(t("session.editRole"));
  return {
    messages: [...source.slice(0, targetIndex), replacement],
    previous: source[targetIndex],
    targetIndex,
  };
}

export function editUserTranscriptAndTruncate<T extends EditableTranscript>(
  history: readonly T[] = [],
  { clientMessageId = "", text = "", images = [], documents = [], now = "" }: TranscriptEdit = {},
) {
  const source: readonly T[] = Array.isArray(history) ? history : [];
  const targetIndex = findEditableTranscriptUserIndex(source, clientMessageId);
  if (targetIndex < 0) {
    return {
      changed: false,
      transcript: source.slice(),
      targetIndex,
      entry: null,
    };
  }

  const timestamp = typeof now === "function" ? now() : now;
  const entry = {
    ...source[targetIndex],
    text: String(text ?? ""),
    images: Array.isArray(images) ? images.slice() : [],
    documents: Array.isArray(documents) ? documents.slice() : [],
    deliveryStatus: "pending",
    editedAt: timestamp || source[targetIndex].editedAt || "",
  };
  return {
    changed: true,
    transcript: [...source.slice(0, targetIndex), entry],
    targetIndex,
    entry,
  };
}

function findEditableTranscriptUserIndex(history: readonly EditableTranscript[] = [], clientMessageId = "") {
  const id = normalizeEditMessageId(clientMessageId);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.type !== "user") continue;
    if (!id || normalizeEditMessageId(entry.clientMessageId) === id) return i;
  }
  return -1;
}

function dataUrlMimeType(url = "") {
  const match = String(url || "").match(/^data:([^;,]+)[;,]/i);
  return match?.[1] || "";
}
