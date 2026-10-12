import { t } from "../i18n.js";
interface LogsOptions {
  signal?: AbortSignal;
  root?: Document;
  send?(message: { type: "clear_trace" | "get_trace" }): unknown;
  onClearLandingHistory?(): unknown;
  isEnabled?(): boolean;
}

export function createLogsFeature(options: LogsOptions = {}) {
  const lifetime = new AbortController();
  const lifecycleSignal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  lifecycleSignal.throwIfAborted();
  const root = options.root || document;
  const panel = root.querySelector<HTMLElement>("#logs-panel");
  const content = root.querySelector("#logs-content");
  const refreshButton = root.querySelector("#btn-refresh-logs");
  const clearButton = root.querySelector("#btn-clear-logs");
  const clearLandingButton = root.querySelector("#btn-clear-landing-history");
  const actionStatus = root.querySelector("#logs-action-status");
  let disposed = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  const onRefresh = () => load();
  const onClear = () => options.send?.({ type: "clear_trace" });
  const onClearLanding = () => {
    options.onClearLandingHistory?.();
    flashStatus(t("landingHistoryCleared"));
  };
  refreshButton?.addEventListener("click", onRefresh, { signal: lifecycleSignal });
  clearButton?.addEventListener("click", onClear, { signal: lifecycleSignal });
  clearLandingButton?.addEventListener("click", onClearLanding, { signal: lifecycleSignal });

  lifecycleSignal.addEventListener("abort", dispose, { once: true });
  return { panel, load, render, flashStatus, dispose };

  function load() {
    if (disposed) return;
    if (options.isEnabled?.() === false) return;
    if (content) content.textContent = t("loading");
    options.send?.({ type: "get_trace" });
  }

  function render(logs: unknown[] = []) {
    if (disposed) return;
    if (!content) return;
    if (!logs.length) {
      content.textContent = t("noLogs");
      return;
    }
    content.textContent = logs.join("\n");
    content.scrollTop = content.scrollHeight;
  }

  function flashStatus(text = "") {
    if (disposed) return;
    if (!actionStatus) return;
    actionStatus.textContent = text;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      if (actionStatus.textContent === text) actionStatus.textContent = "";
    }, 2200);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    clearTimeout(feedbackTimer);
  }
}
