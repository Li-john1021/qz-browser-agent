import { createSettingsForm, type SettingsFormState } from "../../src/sdk/sidepanel/settings-form.js";
import type { UiExtensionAPI } from "../../src/sdk/sidepanel.js";

declare const qz: UiExtensionAPI;
let draft = "initial";
const form = createSettingsForm(qz, {
  initialValue: draft,
  getDraft: () => draft,
  setDraft: value => { draft = value; },
  load: async signal => { signal.throwIfAborted(); return "loaded"; },
  save: async (value, signal) => { value.toUpperCase(); signal.throwIfAborted(); },
  renderState: state => { qz.settings.setState("example", { disabled: !state.dirty }); },
});
qz.registerSettings({ id: "example", title: "Example", element: document.createElement("section"),
  activate: form.activate, deactivate: form.deactivate, save: form.save });
form.changed();

declare const state: SettingsFormState;
// @ts-expect-error Public state snapshots cannot be edited.
state.dirty = false;
// @ts-expect-error Error phases remain distinguishable rather than arbitrary strings.
const phase: SettingsFormState["phase"] = "failed";

interface Preferences { enabled: boolean }
let preferences: Preferences = { enabled: false };
createSettingsForm(qz, {
  initialValue: preferences,
  getDraft: () => preferences,
  setDraft: value => { preferences = value; },
  equals: (a, b) => a.enabled === b.enabled,
  load: async () => ({ enabled: true }),
  save: async (value, signal) => { value.enabled; signal.throwIfAborted(); return false; },
  renderState: () => {},
});
createSettingsForm<string>(qz, {
  initialValue: "initial", getDraft: () => draft, setDraft: () => {},
  // @ts-expect-error Loaded values must have the same shape as the draft.
  load: async () => 42,
  save: async () => {}, renderState: () => {},
});
