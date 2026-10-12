import { readSessionRecord, transcriptFromConversation, type TranscriptEntry } from "./session-codec.js";
import { activeConversationKey, normalizeSessionId, storedSessionKey } from "./session-store.js";

/** Read-only history boundary. Storage keys and legacy conversation fallback stay internal. */
export async function readStoredTranscript(sessionId: unknown, signal?: AbortSignal): Promise<TranscriptEntry[]> {
  signal?.throwIfAborted();
  const id = normalizeSessionId(sessionId);
  if (!id) return [];
  const key = storedSessionKey(id);
  const saved = await chrome.storage.local.get(key);
  signal?.throwIfAborted();
  const record = readSessionRecord(saved[key]);
  if (record.transcript.length) return record.transcript;
  if (record.conversation) {
    const transcript = transcriptFromConversation(record.conversation);
    if (transcript.length) return transcript;
  }
  const activeKey = activeConversationKey(id);
  const active = await chrome.storage.local.get(activeKey);
  signal?.throwIfAborted();
  return active[activeKey] ? transcriptFromConversation(active[activeKey]) : [];
}
