import { t } from "../../i18n/index.js";
import type { TabReference } from "../../../shared/tab-utils.js";
import type { PortMessage } from "../app/port-client.js";
interface ElementPickerOptions {
  input: HTMLTextAreaElement; button?: HTMLButtonElement | null;
  request?(type: string, payload: PortMessage, timeout: number): Promise<PortMessage>;
  closeSlashMenu?(): void; isComposing?(): boolean;
  showToast?(message: unknown, options: { tone: string; anchorEl: Element | null }): void;
}
interface PickerRequest { id: number; tabId: number; confirming?: boolean }

import { createElementReferenceToken } from "../../../shared/element-reference.js";
import { getEffectiveTabUrl } from "../../../shared/tab-utils.js";

export function createElementPickerFeature(options: ElementPickerOptions) {
  const button = options.button || null;
  const input = options.input;
  const sendRequest: NonNullable<ElementPickerOptions["request"]> = options.request || (async () => ({}));
  const closeSlashMenu = options.closeSlashMenu || (() => {});
  const showToast = options.showToast || (() => {});
  const isComposing = options.isComposing || (() => false);
  if (!input) throw new Error("element picker input is required");

  let elementPickerRequest: PickerRequest | null = null;
  let elementPickerRequestSeq = 0;

function setElementPickerButtonActive(active: boolean) {
  if (!button) return;
  button.classList.toggle("is-active", active);
  button.setAttribute("aria-pressed", String(active));
  button.title = active ? t("confirmSelectionHint") : t("selectElement");
  button.setAttribute("aria-label", active ? t("confirmElement") : t("selectElement"));
}

function isElementPickerTabSupported(tab: TabReference | undefined): tab is TabReference & { id: number } {
  const tabId = Number(tab?.id);
  if (!Number.isInteger(tabId) || tabId <= 0) return false;
  try {
    const url = new URL(getEffectiveTabUrl(tab));
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.hostname === "chromewebstore.google.com") return false;
    return !(url.hostname === "chrome.google.com" && /^\/webstore(?:\/|$)/.test(url.pathname));
  } catch (_err) {
    return false;
  }
}

let elementPickerAvailabilityRequest = 0;

async function syncElementPickerAvailability() {
  if (!button) return;
  const request = ++elementPickerAvailabilityRequest;
  let available = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    available = isElementPickerTabSupported(tab);
  } catch (_err) {}
  if (request !== elementPickerAvailabilityRequest) return;
  button.classList.toggle("hidden", !available);
  if (!available && elementPickerRequest) void cancelActiveElementPicker();
}

function installElementPickerAvailabilityTracking() {
  chrome.tabs?.onActivated?.addListener(() => {
    void syncElementPickerAvailability();
  });
  chrome.tabs?.onUpdated?.addListener((_tabId, changeInfo, tab) => {
    if (!tab?.active || !Object.prototype.hasOwnProperty.call(changeInfo || {}, "url")) return;
    void syncElementPickerAvailability();
  });
  void syncElementPickerAvailability();
}

async function toggleElementPicker() {
  if (elementPickerRequest) {
    await confirmActiveElementPicker();
    return;
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (_err) {
    button?.classList.add("hidden");
    return;
  }
  if (!isElementPickerTabSupported(tab)) {
    button?.classList.add("hidden");
    return;
  }

  closeSlashMenu();
  const pickerRequest = { id: ++elementPickerRequestSeq, tabId: tab.id };
  elementPickerRequest = pickerRequest;
  setElementPickerButtonActive(true);
  try {
    const result = await sendRequest("start_element_picker", { tabId: tab.id }, 65000);
    if (elementPickerRequest !== pickerRequest) return;
    if (result?.selector) {
      insertPickedElementSelector(result.selector);
    } else if (result?.error) {
      showToast(result.error, { tone: "error", anchorEl: button });
    }
  } catch (err) {
    if (elementPickerRequest === pickerRequest && !/timed out/i.test(String(err instanceof Error ? err.message : ""))) {
      showToast(err instanceof Error ? err.message : t("selectElementFailed"), { tone: "error", anchorEl: button });
    }
  } finally {
    if (elementPickerRequest === pickerRequest) {
      elementPickerRequest = null;
      setElementPickerButtonActive(false);
    }
  }
}

async function confirmActiveElementPicker() {
  const request = elementPickerRequest;
  if (!request || request.confirming) return;
  request.confirming = true;
  try {
    await sendRequest("confirm_element_picker", { tabId: request.tabId }, 4000);
  } catch (err) {
    if (elementPickerRequest === request) {
      showToast(err instanceof Error ? err.message : t("confirmElementFailed"), { tone: "error", anchorEl: button });
    }
  } finally {
    if (elementPickerRequest === request) request.confirming = false;
  }
}

async function cancelActiveElementPicker() {
  const request = elementPickerRequest;
  if (!request) return;
  elementPickerRequest = null;
  setElementPickerButtonActive(false);
  try {
    await sendRequest("cancel_element_picker", { tabId: request.tabId }, 4000);
  } catch (_err) {
    // The page may have navigated or closed; local picker state is already clear.
  }
}

function insertPickedElementSelector(value: unknown) {
  const reference = createElementReferenceToken({
    selector: value,
  });
  if (!reference) return;
  const hasLiveSelection = document.hasFocus() && document.activeElement === input;
  const start = hasLiveSelection && Number.isInteger(input.selectionStart)
    ? input.selectionStart
    : input.value.length;
  const end = hasLiveSelection && Number.isInteger(input.selectionEnd)
    ? input.selectionEnd
    : start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const leading = before && !/\s$/.test(before) ? "\n" : "";
  const trailing = after && !/^\s/.test(after) ? "\n" : " ";
  const inserted = `${leading}${reference}${trailing}`;
  input.value = `${before}${inserted}${after}`;
  const caret = before.length + inserted.length;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  focusComposerAt(caret);
}

function focusComposerAt(caret: number) {
  const position = Math.max(0, Math.min(input.value.length, Number(caret) || 0));
  input.setSelectionRange(position, position);
  input.scrollTop = input.scrollHeight;
  if (!document.hasFocus()) return;
  input.focus({ preventScroll: true });
}

  document.addEventListener("keydown", (event) => {
    if (!elementPickerRequest || event.isComposing || isComposing() || event.keyCode === 229) return;
    const confirm = event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    const cancel = event.key === "Escape";
    if (!confirm && !cancel) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (confirm) void confirmActiveElementPicker();
    else void cancelActiveElementPicker();
  }, true);
  button?.addEventListener("click", toggleElementPicker);

  return {
    toggle: toggleElementPicker,
    confirm: confirmActiveElementPicker,
    cancel: cancelActiveElementPicker,
    isActive: () => Boolean(elementPickerRequest),
    installAvailabilityTracking: installElementPickerAvailabilityTracking,
  };
}
