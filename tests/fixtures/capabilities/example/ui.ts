import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createSettingsForm } from "#sdk/sidepanel/settings-form";
import { t } from "./i18n.js";

/** Templates, drafts and persisted preferences belong to this package's mount. */
export default function (qz: UiExtensionAPI) {
  const view = qz.mountTemplate("example-ui-template");
  const page = view.querySelector<HTMLElement>("#example-page")!;
  const query = page.querySelector<HTMLInputElement>("input")!;
  const status = page.querySelector<HTMLOutputElement>("output")!;
  status.classList.add("qz:font-code");
  const settings = view.querySelector<HTMLElement>("#example-settings")!;
  const setting = settings.querySelector<HTMLInputElement>("input")!;
  query.addEventListener("input", qz.notifyViewChange, { signal: qz.signal });
  const form = createSettingsForm(qz, {
    initialValue: "initial",
    getDraft: () => setting.value,
    setDraft: value => { setting.value = value; },
    async load(signal) {
      const value = await qz.storage.get("settings", { signal });
      return value && typeof value === "object" && "value" in value && typeof value.value === "string" ? value.value : "initial";
    },
    save: (value, signal) => qz.storage.set("settings", { value }, { signal }),
    renderState({ phase, dirty }) {
      const loading = phase === "loading";
      const saving = phase === "saving";
      const failed = phase === "load-error" || phase === "save-error";
      const text = loading ? t("settingsLoading") : saving ? t("settingsSaving")
        : phase === "load-error" ? t("settingsLoadFailed") : phase === "save-error" ? t("settingsSaveFailed")
        : dirty ? t("settingsDirty") : t("settingsSaved");
      qz.settings.setState("example-settings", {
        text, tone: failed ? "error" : loading || saving ? "muted" : dirty ? "dirty" : "saved",
        disabled: loading || !dirty, busy: saving,
      });
    },
  });
  setting.addEventListener("input", form.changed, { signal: qz.signal });
  qz.on("example_result", event => { status.textContent = String(event.value); });
  qz.registerPage({
    id: "example-page", title: t("pageTitle"), order: 80, elements: [page],
    activate: () => { page.dataset.active = "true"; },
    deactivate: () => { page.dataset.active = "false"; },
    capture: () => ({ query: query.value }),
    restore(state) {
      const value = state && typeof state === "object" ? (state as { query?: unknown }).query : "";
      query.value = typeof value === "string" ? value : "";
    },
  });
  qz.registerSettings({
    id: "example-settings", title: t("settingsTitle"), element: settings,
    activate: form.activate,
    deactivate: form.deactivate,
    save: form.save,
  });
}
