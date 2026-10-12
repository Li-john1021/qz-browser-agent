import { contentMessages, parseContentLanguageSnapshot, type ContentLanguageSnapshot } from "../shared/i18n/content.js";
import { createTranslator, interpolate } from "../shared/i18n/index.js";
export { contentMessages };
const fallback = createTranslator(contentMessages);
let snapshot: ContentLanguageSnapshot | null = null;
let pending: Promise<void> | undefined;
export const t: typeof fallback = (key, parameters) => snapshot
  ? interpolate(snapshot.messages[key], parameters)
  : fallback(key, parameters);

/** Refresh only when displaying page UI. Private dictionaries never become web-accessible resources. */
export function refreshContentLanguage(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: "get_content_language" });
      if (response && typeof response === "object" && "ok" in response && response.ok === true && "result" in response) {
        snapshot = parseContentLanguageSnapshot(response.result);
      }
    } catch { /* The authored/native fallback works when the extension is restarting. */ }
  })().finally(() => { pending = undefined; });
  return pending;
}
