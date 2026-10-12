import { tHtml } from "../i18n/index.js";
interface ToastOptions {
  tone?: string; durationMs?: number | null; anchorEl?: Element | null; key?: string; toggle?: boolean;
  variant?: string; title?: string; actionLabel?: string; onAction?: (() => unknown) | null; dismissible?: boolean | null;
}
interface ToastContent { title?: unknown; message?: unknown; body?: unknown; description?: unknown }

const TOAST_TONES = new Set(["info", "error", "warning", "success"]);
const TOAST_ICON_PATHS = Object.freeze({
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>',
  error: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5"></path><path d="M12 16h.01"></path>',
  warning: '<path d="M10.3 3.8 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.8a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  success: '<circle cx="12" cy="12" r="9"></circle><path d="m8.5 12 2.3 2.3 4.8-5"></path>',
});

export function createToastFeature(options: { root?: Document; hasBlockingOverlay?: () => boolean } = {}) {
  const root = options.root || document;
  const hasBlockingOverlay = options.hasBlockingOverlay || (() => false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeKey = "";
  let activeAction: (() => unknown) | null = null;

  function hide({ key = "" } = {}) {
    const normalizedKey = String(key || "");
    if (normalizedKey && normalizedKey !== activeKey) return false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    activeKey = "";
    activeAction = null;
    root.querySelector<HTMLElement>(".case-toast")?.classList.remove("visible");
    return true;
  }

  function show(message: unknown, {
    tone = "info",
    durationMs = null,
    anchorEl = null,
    key = "",
    toggle = false,
    variant = "",
    title = "",
    actionLabel = "",
    onAction = null,
    dismissible = null,
  }: ToastOptions = {}) {
    const content = normalizeToastContent(message, title);
    if (!content.title && !content.message) return;
    const toast = ensureToast();
    if (!toast) return;
    const normalizedKey = String(key || "");
    if (toggle && normalizedKey && normalizedKey === activeKey && toast.classList.contains("visible")) {
      hide({ key: normalizedKey });
      return;
    }

    const normalizedTone = isToastTone(tone) ? tone : "info";
    const resolvedDurationMs = normalizeDuration(durationMs, normalizedTone);
    const action = typeof onAction === "function" && String(actionLabel || "").trim()
      ? onAction
      : null;
    const canDismiss = dismissible == null
      ? normalizedTone === "error" || Boolean(action) || resolvedDurationMs === 0
      : Boolean(dismissible);
    const titleEl = toast.querySelector<HTMLElement>(".case-toast-title")!;
    const messageEl = toast.querySelector<HTMLElement>(".case-toast-message")!;
    const actionEl = toast.querySelector<HTMLButtonElement>(".case-toast-action")!;
    const closeEl = toast.querySelector<HTMLButtonElement>(".case-toast-close")!;
    const iconEl = toast.querySelector(".case-toast-icon svg");

    titleEl.textContent = content.title;
    titleEl.hidden = !content.title;
    messageEl.textContent = content.message;
    messageEl.hidden = !content.message;
    if (iconEl) iconEl.innerHTML = TOAST_ICON_PATHS[normalizedTone];
    actionEl.textContent = action ? String(actionLabel).trim() : "";
    actionEl.hidden = !action;
    closeEl.hidden = !canDismiss;
    activeAction = action;
    activeKey = normalizedKey;

    toast.dataset.tone = normalizedTone;
    toast.setAttribute("role", normalizedTone === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", normalizedTone === "error" ? "assertive" : "polite");
    toast.classList.toggle("has-title", Boolean(content.title));
    toast.classList.toggle("has-action", Boolean(action));
    toast.classList.toggle("is-dismissible", canDismiss);
    for (const knownTone of TOAST_TONES) {
      toast.classList.toggle(knownTone, knownTone === normalizedTone);
    }
    toast.classList.toggle("goal-status-toast", variant === "goal-status");
    position(toast, anchorEl);
    toast.classList.add("visible");

    if (timer) clearTimeout(timer);
    timer = null;
    if (resolvedDurationMs > 0) {
      timer = setTimeout(() => {
        toast.classList.remove("visible");
        if (activeKey === normalizedKey) {
          activeKey = "";
          activeAction = null;
        }
        timer = null;
      }, resolvedDurationMs);
    }
  }

  function ensureToast() {
    let toast = root.querySelector<HTMLElement>(".case-toast");
    if (!toast) {
      toast = root.createElement("div");
      toast.className = "case-toast";
      root.body?.appendChild(toast);
    }
    if (!toast || toast.querySelector(".case-toast-copy")) return toast;
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.innerHTML = `
      <span class="case-toast-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none"></svg>
      </span>
      <span class="case-toast-copy">
        <strong class="case-toast-title"></strong>
        <span class="case-toast-message"></span>
      </span>
      <button class="qz-btn qz-btn--secondary qz-btn--sm case-toast-action" type="button" hidden></button>
      <button class="qz-icon-btn qz-icon-btn--sm case-toast-close" type="button" title="${tHtml("close")}" aria-label="${tHtml("close")}" hidden>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>
      </button>
    `;
    toast.querySelector(".case-toast-action")?.addEventListener("click", () => {
      const action = activeAction;
      hide();
      if (!action) return;
      try {
        Promise.resolve(action()).catch(error => {
          console.debug("[轻舟] toast action failed:", error instanceof Error ? error.message : error);
        });
      } catch (error) {
        console.debug("[轻舟] toast action failed:", error instanceof Error ? error.message : error);
      }
    });
    toast.querySelector(".case-toast-close")?.addEventListener("click", () => hide());
    return toast;
  }

  function position(toast: HTMLElement | null, anchorEl: Element | null = null) {
    if (!toast) return;
    const anchor = anchorEl && typeof anchorEl.getBoundingClientRect === "function" ? anchorEl : null;
    toast.classList.toggle("in-artifacts", hasBlockingOverlay() === true);
    toast.classList.toggle("anchored", Boolean(anchor));
    toast.style.removeProperty("--toast-left");
    toast.style.removeProperty("--toast-top");
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const margin = 16;
    const toastMaxWidth = toast.classList.contains("goal-status-toast") ? 420 : 380;
    const maxWidth = Math.min(toastMaxWidth, Math.max(220, window.innerWidth - margin * 2));
    const center = Math.min(
      Math.max(rect.left + rect.width / 2, margin + maxWidth / 2),
      window.innerWidth - margin - maxWidth / 2,
    );
    const toastHeight = Math.min(toast.offsetHeight || 40, Math.max(40, window.innerHeight - margin * 2));
    const preferredTop = rect.bottom + 8;
    const maxTop = window.innerHeight - toastHeight - margin;
    const top = preferredTop <= maxTop ? preferredTop : Math.max(margin, rect.top - toastHeight - 8);
    toast.style.setProperty("--toast-left", `${Math.round(center)}px`);
    toast.style.setProperty("--toast-top", `${Math.round(top)}px`);
  }

  return { show, hide, position };
}

function normalizeToastContent(value: unknown, title = "") {
  const objectValue = value && typeof value === "object" ? value as ToastContent : null;
  return {
    title: String(title || objectValue?.title || "").trim(),
    message: String(
      objectValue?.message
      ?? objectValue?.body
      ?? objectValue?.description
      ?? (objectValue ? "" : value)
      ?? "",
    ).trim(),
  };
}

function normalizeDuration(value: unknown, tone: keyof typeof TOAST_ICON_PATHS) {
  if (value == null || value === "") return tone === "error" ? 6000 : 3200;
  const duration = Number(value);
  return Number.isFinite(duration) ? Math.max(0, duration) : (tone === "error" ? 6000 : 3200);
}

function isToastTone(value: string): value is keyof typeof TOAST_ICON_PATHS { return TOAST_TONES.has(value); }
