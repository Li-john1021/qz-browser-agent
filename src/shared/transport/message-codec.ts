import { createTranslator } from "../i18n/index.js";
import { defineMessages } from "../i18n/definition.js";

export type WireMessage = Record<string, unknown>;
export const MESSAGE_FRAME_BYTES = 8 * 1024 * 1024;
export const MESSAGE_CHUNK_BYTES = 512 * 1024;
export const MESSAGE_TRANSFER_BYTES = 128 * 1024 * 1024;

/** A local immutable envelope, prepared once before queue admission. Never a wire frame. */
export interface PreparedMessage { readonly json: string; readonly bytes: number; readonly identity: WireMessage }

const t = createTranslator(defineMessages("transport", {
  tooLarge: { en: "This message is too large to transfer. Reduce its attachments or read the result in smaller parts.", "zh-CN": "这条消息过大，无法传输。请减少附件或分段读取结果。" },
  invalid: { en: "This message could not be encoded. Check the submitted data and try again.", "zh-CN": "无法编码这条消息。请检查提交的数据后重试。" },
  disconnected: { en: "The connection closed before the transfer finished. Reopen the task and check its state before retrying.", "zh-CN": "传输完成前连接已关闭。请重新打开任务，确认状态后再试。" },
  upgrade: { en: "Reopen the side panel to transfer this large message with the updated extension.", "zh-CN": "请重新打开侧栏，使用更新后的扩展传输这条大消息。" },
  busy: { en: "Another large transfer is using the available buffer. Wait for it to finish and try again.", "zh-CN": "其他大消息传输正在占用缓冲空间，请等待完成后重试。" },
  timeout: { en: "The message transfer timed out. Check the task state before retrying.", "zh-CN": "消息传输超时，请确认任务状态后再试。" },
  cancelled: { en: "The message transfer was cancelled.", "zh-CN": "消息传输已取消。" },
  protocol: { en: "The message transfer was incomplete or invalid. Reopen the task and try again.", "zh-CN": "消息传输不完整或格式无效，请重新打开任务后再试。" },
  failed: { en: "The message could not be sent. Check the connection and task state before retrying.", "zh-CN": "消息发送失败，请检查连接和任务状态后再试。" },
}));

export type TransportErrorCode = "MESSAGE_TOO_LARGE" | "MESSAGE_SERIALIZATION_FAILED" | "TRANSPORT_DISCONNECTED"
  | "TRANSPORT_UPGRADE_REQUIRED" | "TRANSPORT_BUSY" | "TRANSPORT_TIMEOUT" | "TRANSPORT_CANCELLED"
  | "TRANSPORT_PROTOCOL_ERROR" | "TRANSPORT_SEND_FAILED";
const errorMessages = {
  MESSAGE_TOO_LARGE: "tooLarge", MESSAGE_SERIALIZATION_FAILED: "invalid", TRANSPORT_DISCONNECTED: "disconnected",
  TRANSPORT_UPGRADE_REQUIRED: "upgrade", TRANSPORT_BUSY: "busy", TRANSPORT_TIMEOUT: "timeout",
  TRANSPORT_CANCELLED: "cancelled", TRANSPORT_PROTOCOL_ERROR: "protocol", TRANSPORT_SEND_FAILED: "failed",
} as const;

export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode, readonly details: WireMessage = {}) {
    super(t(errorMessages[code]));
    this.name = "TransportError";
  }
}

/** The Chrome message budget applies to serialized UTF-8, including base64 and the envelope. */
export function encodeMessage(value: unknown, limit = MESSAGE_FRAME_BYTES) {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { throw new TransportError("MESSAGE_SERIALIZATION_FAILED"); }
  if (json === undefined) throw new TransportError("MESSAGE_SERIALIZATION_FAILED");
  const bytes = utf8ByteLength(json);
  if (bytes > limit) throw new TransportError("MESSAGE_TOO_LARGE", { actualBytes: bytes, limitBytes: limit });
  return { json, bytes };
}

export function prepareMessage(message: WireMessage, limit = MESSAGE_TRANSFER_BYTES): PreparedMessage {
  return Object.freeze({ ...encodeMessage(message, limit), identity: Object.freeze(messageIdentity(message)) });
}

export function messageIdentity(message: WireMessage): WireMessage {
  return Object.fromEntries(["type", "sessionId", "requestId"].flatMap(key => {
    const value = message[key];
    return typeof value === "string" && value.length <= 200 ? [[key, value]] : [];
  }));
}

export function utf8ByteLength(value: string) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }
    else bytes += 3;
  }
  return bytes;
}

export function normalizeTransportError(cause: unknown): TransportError {
  if (cause instanceof TransportError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/maximum allowed size|message.*too large|64\s*MiB/i.test(message)) return new TransportError("MESSAGE_TOO_LARGE");
  if (/disconnected|receiving end does not exist|message port closed|extension context invalidated/i.test(message)) {
    return new TransportError("TRANSPORT_DISCONNECTED");
  }
  return new TransportError("TRANSPORT_SEND_FAILED");
}

export function isConnectionFailure(cause: unknown) {
  const code = cause instanceof TransportError ? cause.code : normalizeTransportError(cause).code;
  return code === "TRANSPORT_DISCONNECTED" || code === "TRANSPORT_SEND_FAILED";
}

/** These failures settle a request; they must never become Agent terminal events. */
export function transportFailure(cause: unknown, original: WireMessage = {}, type: "request_failed" | "transport_error" = "request_failed") {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const fields = cause && typeof cause === "object" ? cause as WireMessage : {};
  return {
    type,
    ...(typeof original.sessionId === "string" ? { sessionId: original.sessionId } : {}),
    ...(typeof original.requestId === "string" ? { requestId: original.requestId } : {}),
    requestType: String(original.requestType || original.type || ""),
    code: String(fields.code || "TRANSPORT_SEND_FAILED"),
    message: error.message.slice(0, 2000),
    // Keep diagnostic detail bounded and never echo the failed payload.
    details: cause instanceof TransportError ? cause.details : diagnosticDetails(fields.details),
  };
}

function diagnosticDetails(value: unknown): WireMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 24).flatMap(([key, item]) => {
    if (typeof item === "boolean" || typeof item === "number" || item === null) return [[key.slice(0, 80), item]];
    return [];
  }));
}
