import { t, tHtml } from "../../../i18n/index.js";
import { copyPlainText, fallbackCopyText } from "../../../ui/ui-utils.js";

interface ActionOptions {
  root: HTMLElement;
  downloadFilename(): string;
  onCopy?(message: HTMLElement, kind: "full" | "selection", text?: string): void;
}

/** Owns message I/O feedback. Retiring a row revokes its handlers and all late DOM writes. */
export function createMessageActions(options: ActionOptions) {
  const owners = new Map<HTMLElement, AbortController>();
  const flashes = new Map<HTMLElement, { timer: ReturnType<typeof setTimeout>; restore(): void }>();

  function own(el: HTMLElement) {
    let owner = owners.get(el);
    if (!owner) { owner = new AbortController(); owners.set(el, owner); }
    return owner;
  }

  function dispose(el: HTMLElement) {
    for (const node of flashes.keys()) if (node === el || el.contains(node)) clearFlash(node);
    for (const [node, owner] of owners) {
      if (node === el || el.contains(node)) {
        owners.delete(node);
        owner.abort();
        node.querySelector(".msg-actions")?.remove();
      }
    }
  }

  function reset() {
    for (const el of owners.keys()) dispose(el);
    for (const el of flashes.keys()) clearFlash(el);
  }

  function current(el: HTMLElement, owner: AbortController, button: HTMLElement) {
    return owners.get(el) === owner && !owner.signal.aborted && button.isConnected
      && options.root.contains(button);
  }

  function syncAssistantMessageActions(el: HTMLElement, showActions: boolean) {
    let existing = el.querySelector<HTMLElement>(".msg-actions");
    if (existing && !owners.has(el)) { existing.remove(); existing = null; }
    if (!showActions || !getAssistantMarkdown(el)) {
      dispose(el);
      existing?.remove();
      return false;
    }
    if (!existing) {
      const owner = own(el);
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      actions.innerHTML = `
        <button class="qz-icon-btn qz-icon-btn--xs msg-action-btn" type="button" data-action="copy-markdown" title="${tHtml("copyMarkdown")}" aria-label="${tHtml("copyMarkdown")}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="10" height="12" rx="2"/><path d="M6 16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="qz-icon-btn qz-icon-btn--xs msg-action-btn" type="button" data-action="download-markdown" title="${tHtml("downloadMessage")}" aria-label="${tHtml("downloadMessage")}">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M6 15V9l3 3 3-3v6M17 9v6m-2-2 2 2 2-2"/></svg>
        </button>
      `;
      actions.addEventListener("click", event => {
        const btn = event.target instanceof Element ? event.target.closest<HTMLElement>(".msg-action-btn") : null;
        if (!btn || !current(el, owner, btn)) return;
        const markdown = getAssistantMarkdown(el);
        if (!markdown) return flashMessageAction(btn, t("noContent"));
        const isCurrent = () => current(el, owner, btn) && getAssistantMarkdown(el) === markdown;
        if (btn.dataset.action === "copy-markdown") void copyText(markdown, isCurrent, () => {
          flashMessageAction(btn, t("copied")); options.onCopy?.(el, "full");
        }, () => flashMessageAction(btn, t("copyFailed")));
        if (btn.dataset.action === "download-markdown") void downloadAssistantMarkdown(markdown, btn, isCurrent);
      }, { signal: owner.signal });
      el.appendChild(actions);
    }
    return true;
  }

  function hideAll() {
    for (const el of options.root.querySelectorAll<HTMLElement>(".msg-assistant")) {
      dispose(el);
      el.querySelector(".msg-actions")?.remove();
    }
  }

  async function copyText(text: string, isCurrent: () => boolean, success: () => void, failure: () => void) {
    try {
      await copyPlainText(text);
    } catch (_error) {
      if (!isCurrent()) return;
      try { fallbackCopyText(text); }
      catch (_fallbackError) { if (isCurrent()) failure(); return; }
    }
    if (isCurrent()) success();
  }

  async function downloadAssistantMarkdown(markdown: string, btn: HTMLElement, isCurrent: () => boolean) {
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    try {
      await chrome.downloads.download({ url, filename: options.downloadFilename(), saveAs: true });
      if (isCurrent()) flashMessageAction(btn, t("downloaded"));
    } catch (_error) {
      if (isCurrent()) flashMessageAction(btn, t("downloadFailed"));
    } finally {
      // Downloads may still consume the URL after the initiating row has been retired.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function clearFlash(el: HTMLElement) {
    const flash = flashes.get(el);
    if (!flash) return;
    flashes.delete(el);
    clearTimeout(flash.timer);
    flash.restore();
  }

  function flashMessageAction(btn: HTMLElement | null, label: string) {
    if (!btn) return;
    clearFlash(btn);
    const originalTitle = btn.dataset.originalTitle || btn.title || "";
    btn.dataset.originalTitle = originalTitle;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.classList.add("is-confirmed");
    const restore = () => {
      btn.title = originalTitle; btn.setAttribute("aria-label", originalTitle); btn.classList.remove("is-confirmed");
    };
    flashes.set(btn, { restore, timer: setTimeout(() => clearFlash(btn), 1400) });
  }

  async function handleCodeBlockCopyClick(event: Event) {
    const btn = event.target instanceof Element ? event.target.closest<HTMLElement>(".code-copy-btn") : null;
    if (!btn || !options.root.contains(btn)) return;
    const block = btn.closest<HTMLElement>(".copyable-code-block");
    if (!block) return;
    const el = btn.closest<HTMLElement>("[data-transcript-key], .msg") || block;
    const owner = own(el);
    const readText = () => block.dataset.copyText
      || (block.querySelector<HTMLElement>("pre code") || block.querySelector<HTMLElement>("pre"))?.textContent || "";
    const text = readText();
    event.preventDefault(); event.stopPropagation();
    if (!text) return flashMessageAction(btn, t("noContent"));
    await copyText(text, () => current(el, owner, btn) && readText() === text, () => {
      clearFlash(block);
      block.classList.remove("copy-confirmed");
      void block.offsetWidth;
      block.classList.add("copy-confirmed");
      flashes.set(block, { restore: () => block.classList.remove("copy-confirmed"), timer: setTimeout(() => clearFlash(block), 760) });
      const message = btn.closest<HTMLElement>(".msg-assistant");
      if (message) options.onCopy?.(message, "selection", text);
    }, () => flashMessageAction(btn, t("copyFailed")));
  }

  return { sync: syncAssistantMessageActions, hideAll, dispose, reset, flash: flashMessageAction, handleCodeBlockCopyClick };
}

function getAssistantMarkdown(el: HTMLElement) {
  return String(el.dataset.finalContent || el.dataset.content || "").trimEnd();
}
