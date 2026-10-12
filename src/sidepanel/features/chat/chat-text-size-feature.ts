import { t } from "../../i18n/index.js";
interface TextSizeOptions {
  root?: Document;
  messagesEl: HTMLElement; control: HTMLElement; trigger: HTMLButtonElement;
  popover: HTMLElement; decrease: HTMLButtonElement; increase: HTMLButtonElement; reset: HTMLButtonElement;
  storage?: Pick<Storage, "getItem" | "setItem">;
  scroll?: { preserveViewportDuringContentLayout(update: () => void): unknown };
}

export const CHAT_TEXT_SIZES = Object.freeze([
  Object.freeze({ id: "small", percent: 80 }),
  Object.freeze({ id: "compact", percent: 90 }),
  Object.freeze({ id: "standard", percent: 100 }),
  Object.freeze({ id: "comfortable", percent: 110 }),
  Object.freeze({ id: "large", percent: 125 }),
  Object.freeze({ id: "xlarge", percent: 140 }),
]);

export const DEFAULT_CHAT_TEXT_SIZE = "standard";
export const CHAT_TEXT_SIZE_STORAGE_KEY = "qingzhou.chatTextSize";

const SIZE_INDEX = new Map<string, number>(CHAT_TEXT_SIZES.map((size, index) => [size.id, index]));

export function normalizeChatTextSize(value: unknown) {
  const id = String(value || "").trim().toLowerCase();
  return SIZE_INDEX.has(id) ? id : DEFAULT_CHAT_TEXT_SIZE;
}

export function stepChatTextSize(value: unknown, delta: unknown) {
  const current = SIZE_INDEX.get(normalizeChatTextSize(value))!;
  const direction = Math.sign(Number(delta) || 0);
  const next = Math.max(0, Math.min(CHAT_TEXT_SIZES.length - 1, current + direction));
  return CHAT_TEXT_SIZES[next].id;
}

export function createChatTextSizeFeature(options: TextSizeOptions) {
  const root = options.root || document;
  const messagesEl = options.messagesEl;
  const control = options.control;
  const trigger = options.trigger;
  const popover = options.popover;
  const decrease = options.decrease;
  const increase = options.increase;
  const reset = options.reset;
  const storage = options.storage;
  const scroll = options.scroll;
  if (!messagesEl || !control || !trigger || !popover || !decrease || !increase || !reset) {
    throw new Error("chat text size elements are required");
  }

  let current = readStoredSize(storage);
  applySize(current, { persist: false, preserveViewport: false });

  function render() {
    const index = SIZE_INDEX.get(current)!;
    const size = CHAT_TEXT_SIZES[index];
    const text = `${size.percent}%`;
    reset.textContent = text;
    reset.disabled = current === DEFAULT_CHAT_TEXT_SIZE;
    reset.title = reset.disabled ? t("standardTextSize") : t("resetTextSize");
    trigger.title = t("chatTextSizeValue", { size: text });
    trigger.setAttribute("aria-label", t("chatTextSizeCurrent", { size: text }));
    decrease.disabled = index === 0;
    increase.disabled = index === CHAT_TEXT_SIZES.length - 1;
  }

  function applySize(nextValue: unknown, { persist = true, preserveViewport = true } = {}) {
    const next = normalizeChatTextSize(nextValue);
    const update = () => {
      current = next;
      messagesEl.dataset.chatTextSize = next;
      render();
    };
    if (preserveViewport && current !== next && typeof scroll?.preserveViewportDuringContentLayout === "function") {
      scroll.preserveViewportDuringContentLayout(update);
    } else {
      update();
    }
    if (persist) writeStoredSize(storage, next);
    return next;
  }

  function setOpen(open: boolean) {
    const next = open === true;
    popover.classList.toggle("hidden", !next);
    trigger.setAttribute("aria-expanded", String(next));
    if (next) (decrease.disabled ? increase : decrease).focus({ preventScroll: true });
  }

  function handleTriggerClick(event: Event) {
    event.stopPropagation();
    setOpen(popover.classList.contains("hidden"));
  }

  function handleControlClick(event: Event) {
    const action = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-chat-text-size-action]")?.dataset.chatTextSizeAction : undefined;
    if (!action) return;
    if (action === "decrease") applySize(stepChatTextSize(current, -1));
    else if (action === "increase") applySize(stepChatTextSize(current, 1));
    else if (action === "reset") applySize(DEFAULT_CHAT_TEXT_SIZE);
  }

  function handleOutsidePointer(event: Event) {
    if (!popover.classList.contains("hidden") && event.target instanceof Node && !control.contains(event.target)) setOpen(false);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || popover.classList.contains("hidden")) return;
    setOpen(false);
    trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener("click", handleTriggerClick);
  control.addEventListener("click", handleControlClick);
  root.addEventListener("pointerdown", handleOutsidePointer);
  root.addEventListener("keydown", handleKeydown);

  return {
    getSize: () => current,
    setSize: (value: unknown) => applySize(value),
    close: () => setOpen(false),
    destroy() {
      trigger.removeEventListener("click", handleTriggerClick);
      control.removeEventListener("click", handleControlClick);
      root.removeEventListener("pointerdown", handleOutsidePointer);
      root.removeEventListener("keydown", handleKeydown);
    },
  };
}

function readStoredSize(storage: TextSizeOptions["storage"]) {
  try {
    return normalizeChatTextSize(storage?.getItem?.(CHAT_TEXT_SIZE_STORAGE_KEY));
  } catch {
    return DEFAULT_CHAT_TEXT_SIZE;
  }
}

function writeStoredSize(storage: TextSizeOptions["storage"], value: unknown) {
  try {
    storage?.setItem?.(CHAT_TEXT_SIZE_STORAGE_KEY, normalizeChatTextSize(value));
  } catch {
    // The preference is optional; storage failure must not block reading chat.
  }
}
