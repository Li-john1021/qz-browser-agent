import { extractUserMessageImages } from "../../shared/session/conversation-edit.js";
import { normalizeMessageDocuments } from "../../shared/documents/document-attachments.js";
import type { ModelMessage } from "../../shared/contracts/model-message.js";

/** Per-Agent pending values only. Admission, persistence, rollback and scheduling belong to Agent. */
export class MessageQueue<T extends { clientMessageId?: string }> {
  _messages: T[] = [];
  mode: "all" | "one-at-a-time";

  constructor(mode: "all" | "one-at-a-time" = "one-at-a-time") {
    this.mode = mode;
  }

  enqueue(msg: T) {
    this._messages.push(msg);
  }

  setAll(messages: T[] = []) {
    this._messages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  }

  hasItems() {
    return this._messages.length > 0;
  }

  drain() {
    if (this.mode === "all") {
      const drained = this._messages.slice();
      this._messages = [];
      return drained;
    }
    if (this._messages.length === 0) return [];
    return [this._messages.shift()!];
  }

  peekAll() {
    return this._messages.slice();
  }

  removeByClientMessageId(clientMessageId = "", fallback: T | null = null) {
    const id = String(clientMessageId || "").trim();
    const index = id ? this._messages.findIndex(msg => String(msg?.clientMessageId || "").trim() === id) : (fallback ? this._messages.indexOf(fallback) : -1);
    if (index < 0) return null;
    const [message] = this._messages.splice(index, 1);
    return { message, index };
  }

  insertAt(index: number, message: T) {
    if (!message) return;
    const position = Math.max(0, Math.min(this._messages.length, Number(index) || 0));
    this._messages.splice(position, 0, message);
  }

  reorderByClientMessageIds(clientMessageIds: string[] = []) {
    const order = Array.isArray(clientMessageIds)
      ? clientMessageIds.map(id => String(id || "").trim()).filter(Boolean)
      : [];
    if (!order.length) return false;
    const byId = new Map<string, T>();
    const rest = [];
    for (const msg of this._messages) {
      const id = String(msg?.clientMessageId || "").trim();
      if (id && order.includes(id) && !byId.has(id)) byId.set(id, msg);
      else rest.push(msg);
    }
    const next = [];
    for (const id of order) {
      const msg = byId.get(id);
      if (msg) next.push(msg);
    }
    next.push(...rest);
    const changed = next.length === this._messages.length
      && next.some((msg, index) => msg !== this._messages[index]);
    if (changed) this._messages = next;
    return changed;
  }

  clear() {
    this._messages = [];
  }
}

function userMessageText(message: Partial<ModelMessage> = {}) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => {
      if (!part || typeof part !== "object" || !("type" in part) || part.type !== "text") return [];
      return [String("text" in part ? part.text || "" : "")];
    })
    .join("\n")
    .trim();
}

export function summarizeQueuedUserMessage(message: Partial<ModelMessage> = {}, index = 0) {
  const images = extractUserMessageImages(message);
  const documents = normalizeMessageDocuments(message?.documents);
  return {
    clientMessageId: String(message?.clientMessageId || "").trim(),
    text: userMessageText(message),
    imageCount: images.length,
    ...(documents.length ? { attachmentCount: documents.length } : {}),
    index,
  };
}
