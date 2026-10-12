import { getLanguage } from "../i18n/index.js";
import { t } from "../i18n/backend.js";
/** Persisted versions, distinct from runtime checkpoints and portable exchange files. */
export const CURRENT_SESSION_VERSION = 1;
export const CURRENT_SESSION_RECORD_VERSION = 4;
export const SESSION_RECORD_TYPE = 'qz-browser-agent-session';

export class SessionFormatError extends Error {
  readonly code: 'UNSUPPORTED_SESSION_RECORD_VERSION' | 'UNSUPPORTED_CONVERSATION_VERSION' | 'INVALID_SESSION_FORMAT';
  constructor(kind: 'record' | 'conversation' | 'invalid', version?: unknown) {
    super(kind === 'invalid'
      ? t("session.unrecognizedFormat")
      : t("session.unsupportedVersion", { version: String(typeof version === 'number' ? (getLanguage() === 'zh-CN' ? `（${version}）` : ` (${version})`) : '') }));
    this.name = 'SessionFormatError';
    this.code = kind === 'record' ? 'UNSUPPORTED_SESSION_RECORD_VERSION' : kind === 'conversation' ? 'UNSUPPORTED_CONVERSATION_VERSION' : 'INVALID_SESSION_FORMAT';
  }
}

export function isSessionFormatError(error: unknown): error is SessionFormatError {
  return error instanceof SessionFormatError || Boolean(error && typeof error === 'object'
    && 'code' in error && ['UNSUPPORTED_SESSION_RECORD_VERSION', 'UNSUPPORTED_CONVERSATION_VERSION', 'INVALID_SESSION_FORMAT'].includes(String(error.code)));
}

export function assertSessionRecordReadable(value: unknown): void {
  if (value == null) return;
  if (!isRecord(value) || value.type !== SESSION_RECORD_TYPE) throw new SessionFormatError('invalid');
  // v3 is the original repository format (17c8d2cd); v4 adds transcript repair.
  if (value.version !== 3 && value.version !== CURRENT_SESSION_RECORD_VERSION) throw new SessionFormatError('record', value.version);
  assertConversationReadable(value.conversation);
}

export function assertConversationReadable(value: unknown): void {
  if (value == null || Array.isArray(value)) return;
  if (!isRecord(value)) throw new SessionFormatError('invalid');
  if (value.version !== undefined && value.version !== CURRENT_SESSION_VERSION) throw new SessionFormatError('conversation', value.version);
  if (value.type !== undefined && value.type !== 'conversation') throw new SessionFormatError('invalid');
  // Unversioned arrays/messages/entries are the pre-versioned forms read by the original codec.
  if (!Array.isArray(value.entries) && !Array.isArray(value.messages)) throw new SessionFormatError('invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
