import { t } from "./i18n.js";
import type { createSettingsFeature } from "./settings-feature.js";
interface OnboardingOptions {
  messagesEl: HTMLElement; inputEl?: HTMLElement | null; storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  welcomeHTML?: string; settings: ReturnType<typeof createSettingsFeature>;
  openSkillCatalog?(): void;
  template?: HTMLTemplateElement | null;
  getCurrentSessionId?(): string | null; showWelcome?(): void;
  switchTab?(tab: string, options: { userInitiated: boolean }): void;
  skillsTab: string; chatTab: string; composer?: { setValue(value: string): void };
}
const STORAGE_KEY = "qingzhou_onboarding_v2";
const LEGACY_STORAGE_KEY = "qingzhou_onboarding_v1";

const TASKS = Object.freeze({
  summarize: {
    prompt: t("summarizePagePrompt"),
  },
  extract: {
    prompt: t("compareOptionsPrompt"),
  },
  assist: {
    prompt: t("researchTopicPrompt"),
  },
  skill: { prompt: t("createWebsiteSkillPrompt") },
});

export function createOnboardingFeature(options: OnboardingOptions) {
  const messagesEl = options.messagesEl;
  const inputEl = options.inputEl;
  const storage = options.storage || globalThis.localStorage;
  let state = loadState();
  let started = false;

  function start() {
    if (started) return;
    started = true;
    messagesEl?.addEventListener("click", handleClick);
    render();
  }

  function stop() {
    if (!started) return;
    started = false;
    messagesEl?.removeEventListener("click", handleClick);
  }

  function render() {
    const welcome = messagesEl?.querySelector<HTMLElement>("#welcome");
    if (!welcome) return;
    if (!welcome.querySelector(".welcome-onboarding") && options.template) {
      welcome.append(options.template.content.cloneNode(true));
    }
    const show = shouldShow();
    welcome.classList.toggle("onboarding-dismissed", !show);
    if (show) options.settings?.renderWelcomeOnboarding(welcome);
  }

  function shouldShow() {
    return state.status === "new";
  }

  function markActivated() {
    if (state.status !== "new") return;
    saveState({ status: "activated" });
  }

  function saveState(nextState: { status: string }) {
    state = {
      status: ["new", "activated", "dismissed"].includes(nextState?.status) ? nextState.status : "new",
    };
    try {
      storage?.setItem?.(STORAGE_KEY, JSON.stringify(state));
    } catch (_error) {}
    render();
  }

  function loadState() {
    try {
      const stored = storage?.getItem?.(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const status = String(parsed?.status || "");
        if (["new", "activated", "dismissed"].includes(status)) return { status };
      }
      const legacy = JSON.parse(storage?.getItem?.(LEGACY_STORAGE_KEY) || "{}");
      return legacy?.status === "dismissed" ? { status: "dismissed" } : { status: "new" };
    } catch (_error) {
      return { status: "new" };
    }
  }

  function reset({ clearStorage = true, render: shouldRender = true } = {}) {
    state = { status: "new" };
    if (clearStorage) {
      try {
        storage?.removeItem?.(STORAGE_KEY);
        storage?.removeItem?.(LEGACY_STORAGE_KEY);
      } catch (_error) {}
    }
    if (shouldRender) render();
  }

  function clearLandingHistory() {
    reset({ clearStorage: true, render: false });
    if (!options.getCurrentSessionId?.()) {
      messagesEl.innerHTML = options.welcomeHTML || "";
      options.showWelcome?.();
      render();
    } else {
      render();
    }
  }

  function handleClick(event: MouseEvent) {
    const actionEl = (event.target instanceof Element ? event.target : null)?.closest<HTMLElement>("[data-onboarding-action]");
    if (!actionEl || !messagesEl?.contains(actionEl)) return;
    const action = actionEl.dataset.onboardingAction || "";
    const settings = options.settings;
    if (action === "setup") {
      settings.open(settings.setupIntent());
      return;
    }
    if (action === "install-skill-pack") {
      options.switchTab?.(options.skillsTab, { userInitiated: true });
      options.openSkillCatalog?.();
      return;
    }
    if (action === "settings") {
      const setup = settings.getOnboardingSetupStatus();
      settings.open(settings.setupIntent(setup.focus, false));
      return;
    }
    if (!Object.hasOwn(TASKS, action)) return;
    const task = TASKS[action as keyof typeof TASKS];
    const setup = settings.getOnboardingSetupStatus();
    if (setup.state !== "ready") {
      settings.open(settings.setupIntent(setup.focus));
      return;
    }
    options.composer?.setValue(task.prompt);
    options.switchTab?.(options.chatTab, { userInitiated: true });
    inputEl?.focus();
  }

  return {
    start,
    stop,
    render,
    shouldShow,
    markActivated,
    reset,
    clearLandingHistory,
    getState: () => ({ ...state }),
  };
}
