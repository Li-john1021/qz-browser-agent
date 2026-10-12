import { requestRuntimeMessage } from "../shared/transport/runtime-request.js";
import { refreshContentLanguage, t } from "./i18n.js";
import { isAllowedSessionExchangeLocation } from "../shared/session/session-exchange-source.js";
declare global {
  interface Window { __QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION?: string }
}
export {};

/**
 * Session export bridge.
 *
 * This intentionally runs at document_start without the page-reading vendor stack so an
 * exported conversation can detect Qingzhou before deferred render dependencies finish.
 */

(() => {
  const BRIDGE_VERSION = "2026-07-16-session-export-import";
  const QINGZHOU_SESSION_EXPORT_PROBE = "qingzhou:session-export:probe";
  const QINGZHOU_SESSION_EXPORT_RESULT = "qingzhou:session-export:result";
  const QINGZHOU_SESSION_EXCHANGE_SCRIPT_ID = "qingzhou-session-exchange";
  let importPending = false;

  if (window.__QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION === BRIDGE_VERSION) return;
  window.__QINGZHOU_SESSION_EXPORT_BRIDGE_VERSION = BRIDGE_VERSION;

  window.addEventListener("message", handleProbeMessage);
  document.addEventListener("click", handleImportClick, true);
  announceBridge();

  function handleProbeMessage(event: MessageEvent<unknown>) {
    if (event.source !== window || !isRecord(event.data) || event.data.type !== QINGZHOU_SESSION_EXPORT_PROBE) return;
    if (!getPayloadScript()) return;
    postBridgeResult("probe", {
      requestId: String(event.data?.requestId || ""),
      installed: true,
      name: chrome.runtime.getManifest?.().name || t("brand"),
      version: chrome.runtime.getManifest?.().version || "",
      bridgeVersion: BRIDGE_VERSION,
    });
  }

  function announceBridge() {
    if (!getPayloadScript()) return;
    postBridgeResult("probe", {
      installed: true,
      name: chrome.runtime.getManifest?.().name || t("brand"),
      version: chrome.runtime.getManifest?.().version || "",
      bridgeVersion: BRIDGE_VERSION,
    });
  }

  async function handleImportClick(event: MouseEvent) {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const button = target?.closest?.("[data-qingzhou-session-import]");
    if (!button || !document.contains(button)) return;
    const script = getPayloadScript();
    if (!script) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (importPending) return;

    importPending = true;
    postBridgeResult("import", { status: "working", ok: false });
    try {
      await refreshContentLanguage();
      const payload = JSON.parse(String(script.textContent || ""));
      const result: unknown = await requestRuntimeMessage({
        type: "session_export_import_request",
        payload,
      });
      if (!isRecord(result) || !result.ok) throw new Error(isRecord(result) ? String(result.error || t("importFailed")) : t("importFailed"));
      postBridgeResult("import", {
        status: "done",
        ok: true,
        sessionId: String((isRecord(result.session) ? result.session.id : "") || result.sessionId || ""),
      });
    } catch (err) {
      postBridgeResult("import", {
        status: "error",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      importPending = false;
    }
  }

  function getPayloadScript() {
    if (!isAllowedLocation()) return null;
    const script = document.getElementById(QINGZHOU_SESSION_EXCHANGE_SCRIPT_ID);
    if (!(script instanceof HTMLScriptElement) || script.type !== "application/json") return null;
    const header = String(script.textContent || "").slice(0, 256);
    if (!/"format"\s*:\s*"qingzhou\.session"/u.test(header)) return null;
    if (!/"version"\s*:\s*1(?:\D|$)/u.test(header)) return null;
    return script;
  }

  function isAllowedLocation() {
    return isAllowedSessionExchangeLocation(location);
  }

  function postBridgeResult(action: "probe" | "import", detail: Record<string, unknown> = {}) {
    const targetOrigin = location.protocol === "file:" || location.origin === "null"
      ? "*"
      : location.origin;
    window.postMessage({
      type: QINGZHOU_SESSION_EXPORT_RESULT,
      action,
      ...detail,
    }, targetOrigin);
  }
})();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
