import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createSettingsForm } from "#sdk/sidepanel/settings-form";
import { getAvailableLanguages, getLanguagePreference, readLanguagePreference, saveLanguagePreference } from "#sdk/shared/i18n";
import { t } from "./i18n.js";

/** Preference changes take effect by reloading the panel after the shared save succeeds. */
export default function (qz: UiExtensionAPI) {
  const startupPreference = getLanguagePreference();
  let savedPreference = startupPreference;
  const sectionId = "i18n-language";
  const view = qz.mountTemplate("i18n-language-template");
  const section = view.querySelector<HTMLElement>("#i18n-language-settings")!;
  const select = section.querySelector<HTMLSelectElement>("#i18n-language-select")!;
  const languages = getAvailableLanguages();
  const supported = new Set(["system", ...languages.map(language => language.language)]);
  const normalize = (value: string) => supported.has(value) ? value : "system";
  for (const language of [{ language: "system", name: t("followBrowser"), direction: undefined }, ...languages]) {
    const option = qz.root.createElement("option");
    option.value = language.language;
    option.textContent = language.name;
    option.dir = language.direction || "auto";
    if (language.language !== "system") option.lang = language.language;
    select.append(option);
  }

  const form = createSettingsForm(qz, {
    initialValue: normalize(startupPreference),
    getDraft: () => select.value,
    setDraft: value => { select.value = value; },
    load: async signal => {
      const value = normalize(await readLanguagePreference());
      signal.throwIfAborted();
      // A cancelled write can reach storage without updating the runtime's preference cache.
      savedPreference = value;
      return value;
    },
    save: async (value, signal) => {
      await saveLanguagePreference(value, { signal });
      savedPreference = value;
    },
    renderState({ phase, dirty }) {
      const loading = phase === "loading";
      const saving = phase === "saving";
      const failed = phase === "load-error" || phase === "save-error";
      const text = loading ? t("loading") : saving ? t("saving")
        : phase === "load-error" ? t("loadFailed") : phase === "save-error" ? t("saveFailed")
        : dirty ? t("unsavedChanges") : t("saved");
      qz.settings.setState(sectionId, {
        text,
        tone: failed ? "error" : loading || saving ? "muted" : dirty ? "dirty" : "saved",
        saveLabel: saving ? t("saving") : t("save"),
        disabled: loading || !dirty,
        busy: saving,
      });
    },
  });
  select.addEventListener("change", form.changed, { signal: qz.signal });

  qz.registerSettings({
    id: sectionId,
    title: t("title"),
    tab: { id: "advanced", title: t("advanced"), order: 30 },
    order: 10,
    element: section,
    activate: form.activate,
    deactivate: form.deactivate,
    save: form.save,
    afterSave({ signal }) {
      if (!signal.aborted && !qz.signal.aborted && savedPreference !== startupPreference) {
        qz.root.defaultView?.location.reload();
      }
    },
  });
}
