import { t, tHtml } from "../i18n/index.js";
type DialogMode = "confirm" | "choice" | "input";
type DialogResult = boolean | string | null;
interface DialogInput {
  title?: unknown; message?: unknown; confirmLabel?: unknown; cancelLabel?: unknown; tone?: unknown;
  choices?: unknown; inputLabel?: unknown; value?: unknown; placeholder?: unknown; required?: unknown; maxLength?: unknown;
  signal?: AbortSignal;
}
type Config = ReturnType<typeof normalizeConfig>;
interface Elements {
  dialog: HTMLDialogElement; panel: HTMLElement; title: HTMLElement; message: HTMLElement; options: HTMLElement;
  inputGroup: HTMLElement; inputLabel: HTMLElement; input: HTMLInputElement; cancel: HTMLButtonElement; confirm: HTMLButtonElement;
}
interface ActiveDialog { config: Config; previousFocus: HTMLElement | null; resolve(result: DialogResult): void; settling: boolean; timer?: ReturnType<typeof setTimeout> }

const DIALOG_CLOSE_MS = 180;

export function createDecisionDialogFeature(options: { root?: Document | Element; shouldReduceMotion?: () => boolean; hideToast?: () => unknown } = {}) {
  const root = options.root || document;
  const documentRef = "createElement" in root ? root : root.ownerDocument || document;
  const shouldReduceMotion = options.shouldReduceMotion || (() => (
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  ));
  const hideToast = options.hideToast || (() => {});
  let queue: Promise<unknown> = Promise.resolve();
  let active: ActiveDialog | null = null;
  let elements: Elements | null = null;

  function confirm(messageOrOptions: unknown, input: DialogInput = {}) {
    const config = normalizeConfig("confirm", messageOrOptions, input);
    return enqueue(config).then(result => result === true);
  }

  function choose(input: DialogInput = {}) {
    const config = normalizeConfig("choice", input, {});
    return enqueue(config).then(result => typeof result === "string" ? result : null);
  }

  function requestText(input: DialogInput = {}) {
    const config = normalizeConfig("input", input, {});
    return enqueue(config).then(result => typeof result === "string" ? result : null);
  }

  function enqueue(config: Config) {
    if (config.signal?.aborted) return Promise.resolve(null);
    const result = queue.then(() => open(config));
    queue = result.catch(() => null);
    const signal = config.signal;
    if (!signal) return result;
    return new Promise<DialogResult>((resolve, reject) => {
      const cancel = () => {
        if (active?.config === config) settle(null, true);
        signal.removeEventListener("abort", cancel);
        resolve(null);
      };
      signal.addEventListener("abort", cancel, { once: true });
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
  }

  function open(config: Config): Promise<DialogResult> {
    if (config.signal?.aborted) return Promise.resolve(null);
    const ui = ensureElements();
    if (typeof ui.dialog.showModal !== "function") {
      return Promise.resolve(config.mode === "confirm" ? false : null);
    }

    const HTMLElementRef = documentRef.defaultView?.HTMLElement;
    const previousFocus = HTMLElementRef && documentRef.activeElement instanceof HTMLElementRef
      ? documentRef.activeElement
      : null;
    hideToast();
    ui.dialog.dataset.mode = config.mode;
    ui.dialog.dataset.tone = config.tone;
    ui.dialog.classList.remove("is-closing");
    ui.title.textContent = config.title;
    ui.message.textContent = config.message;
    ui.message.classList.toggle("hidden", !config.message);
    ui.dialog.toggleAttribute("aria-describedby", Boolean(config.message));
    if (config.message) ui.dialog.setAttribute("aria-describedby", ui.message.id);
    ui.cancel.textContent = config.cancelLabel;
    ui.confirm.textContent = config.confirmLabel;
    ui.confirm.className = `qz-btn ${config.tone === "danger" ? "qz-btn--danger" : "qz-btn--primary"} qz-btn--sm`;
    ui.confirm.classList.toggle("hidden", config.mode === "choice");
    renderChoices(ui, config.choices);
    ui.options.classList.toggle("hidden", config.mode !== "choice");
    ui.inputGroup.classList.toggle("hidden", config.mode !== "input");
    ui.inputLabel.textContent = config.inputLabel;
    ui.input.value = config.value;
    ui.input.placeholder = config.placeholder;
    ui.input.maxLength = config.maxLength;
    syncInputState(ui, config);

    return new Promise<DialogResult>(resolve => {
      active = {
        config,
        previousFocus,
        resolve,
        settling: false,
      };
      ui.dialog.showModal();
      requestFrame(() => {
        if (active?.config !== config || active.settling) return;
        const target = config.mode === "choice"
          ? ui.options.querySelector<HTMLElement>(".qz-decision-option")
          : config.mode === "input" ? ui.input
          : config.tone === "danger" ? ui.cancel : ui.confirm;
        target?.focus?.({ preventScroll: true });
        if (target === ui.input) ui.input.select();
      });
    });
  }

  function ensureElements(): Elements {
    if (elements?.dialog?.isConnected) return elements;
    const dialog = documentRef.createElement("dialog");
    dialog.id = "qz-decision-dialog";
    dialog.className = "qz-decision-dialog";
    dialog.setAttribute("aria-labelledby", "qz-decision-title");
    dialog.innerHTML = `
      <section class="qz-decision-panel">
        <header class="qz-decision-copy">
          <h3 id="qz-decision-title" data-qz-decision-title></h3>
          <p id="qz-decision-message" data-qz-decision-message></p>
        </header>
        <div id="qz-decision-options" class="qz-decision-options hidden" role="group" aria-label="${tHtml("availableActions")}" data-qz-decision-options></div>
        <label class="qz-decision-input hidden" data-qz-decision-input-group>
          <span class="qz-field-label" data-qz-decision-input-label></span>
          <input class="qz-field qz-field--sm" type="text" autocomplete="off" data-qz-decision-input>
        </label>
        <footer class="qz-decision-actions">
          <button id="qz-decision-cancel" class="qz-btn qz-btn--ghost qz-btn--sm" type="button" data-qz-decision-cancel>${tHtml("cancel")}</button>
          <button id="qz-decision-confirm" class="qz-btn qz-btn--primary qz-btn--sm" type="button" data-qz-decision-confirm>${tHtml("confirm")}</button>
        </footer>
      </section>
    `;
    documentRef.body.append(dialog);
    elements = {
      dialog,
      panel: dialog.querySelector<HTMLElement>(".qz-decision-panel")!,
      title: dialog.querySelector<HTMLElement>("[data-qz-decision-title]")!,
      message: dialog.querySelector<HTMLElement>("[data-qz-decision-message]")!,
      options: dialog.querySelector<HTMLElement>("[data-qz-decision-options]")!,
      inputGroup: dialog.querySelector<HTMLElement>("[data-qz-decision-input-group]")!,
      inputLabel: dialog.querySelector<HTMLElement>("[data-qz-decision-input-label]")!,
      input: dialog.querySelector<HTMLInputElement>("[data-qz-decision-input]")!,
      cancel: dialog.querySelector<HTMLButtonElement>("[data-qz-decision-cancel]")!,
      confirm: dialog.querySelector<HTMLButtonElement>("[data-qz-decision-confirm]")!,
    };
    const ui = elements;
    ui.cancel.addEventListener("click", () => settle(null));
    ui.confirm.addEventListener("click", () => {
      if (active?.config.mode === "input") settle(ui.input.value.trim());
      else settle(true);
    });
    ui.input.addEventListener("input", () => {
      if (active?.config.mode === "input") syncInputState(ui, active.config);
    });
    ui.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (!ui.confirm.disabled) settle(ui.input.value.trim());
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      settle(null);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) settle(null);
    });
    return elements;
  }

  function renderChoices(ui: Elements, choices: Config["choices"]) {
    ui.options.replaceChildren();
    for (const choice of choices) {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = `qz-btn qz-btn--ghost qz-decision-option${choice.tone === "danger" ? " qz-btn--danger" : ""}`;
      button.dataset.qzDecisionValue = choice.value;
      const label = documentRef.createElement("strong");
      label.textContent = choice.label;
      button.append(label);
      if (choice.description) {
        const description = documentRef.createElement("small");
        description.textContent = choice.description;
        button.append(description);
      }
      button.addEventListener("click", () => settle(choice.value));
      ui.options.append(button);
    }
  }

  function settle(result: DialogResult, cancelled = false) {
    const state = active;
    if (!state || (state.settling && !cancelled)) return;
    if (state.timer) clearTimeout(state.timer);
    state.settling = true;
    const ui = ensureElements();
    ui.dialog.classList.add("is-closing");
    const finish = () => {
      if (ui.dialog.open) ui.dialog.close();
      ui.dialog.classList.remove("is-closing");
      ui.options.replaceChildren();
      ui.input.value = "";
      active = null;
      if (!cancelled) state.previousFocus?.focus?.({ preventScroll: true });
      if (state.config.mode === "choice" || state.config.mode === "input") {
        state.resolve(typeof result === "string" ? result : null);
      } else {
        state.resolve(result === true);
      }
    };
    if (cancelled) finish();
    else state.timer = setTimeout(finish, shouldReduceMotion() ? 0 : DIALOG_CLOSE_MS);
  }

  return Object.freeze({ confirm, choose, requestText });
}

function normalizeConfig(mode: DialogMode, messageOrOptions: unknown, options: DialogInput) {
  const raw = typeof messageOrOptions === "object" && messageOrOptions
    ? messageOrOptions as DialogInput
    : { ...options, message: messageOrOptions };
  return {
    mode,
    signal: options.signal || raw.signal,
    title: String(raw.title || (mode === "choice" ? t("pleaseSelect") : mode === "input" ? t("enterContent") : t("confirmAction"))).trim(),
    message: String(raw.message || "").trim(),
    confirmLabel: String(raw.confirmLabel || t("confirm")).trim(),
    cancelLabel: String(raw.cancelLabel || t("cancel")).trim(),
    tone: raw.tone === "danger" ? "danger" : "neutral",
    choices: normalizeChoices(raw.choices),
    inputLabel: String(raw.inputLabel || "").trim(),
    value: String(raw.value || ""),
    placeholder: String(raw.placeholder || ""),
    required: raw.required !== false,
    maxLength: normalizeMaxLength(raw.maxLength),
  };
}

function normalizeChoices(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((choice, index) => ({
    value: String(choice?.value || `choice-${index + 1}`),
    label: String(choice?.label || choice?.value || t("optionNumber", { number: index + 1 })),
    description: String(choice?.description || ""),
    tone: choice?.tone === "danger" ? "danger" : "neutral",
  }));
}

function requestFrame(callback: FrameRequestCallback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    globalThis.requestAnimationFrame(callback);
  } else {
    setTimeout(() => callback(Date.now()), 0);
  }
}

function syncInputState(ui: Elements, config: Config) {
  ui.confirm.disabled = config.mode === "input" && config.required && !ui.input.value.trim();
}

function normalizeMaxLength(value: unknown) {
  const parsed = Number(value || 200);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(1, Math.min(2000, Math.round(parsed)));
}
