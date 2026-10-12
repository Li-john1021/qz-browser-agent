import type { UiActivation, UiExtensionAPI } from "./ui.js";

export type SettingsFormPhase = "idle" | "loading" | "saving" | "saved" | "load-error" | "save-error";

export interface SettingsFormState {
  readonly phase: SettingsFormPhase;
  readonly dirty: boolean;
  readonly error?: unknown;
}

export interface SettingsFormOptions<Value> {
  /** Values must support structuredClone; the helper snapshots saved and submitted values. */
  readonly initialValue: Value;
  getDraft(): Value;
  setDraft(value: Value): void;
  load(signal: AbortSignal): Value | Promise<Value>;
  /** Throw or return false on failure. Cancellation cannot undo an already committed write. */
  save(value: Value, signal: AbortSignal): void | boolean | Promise<void | boolean>;
  /** Localized status and button presentation remain owned by the capability. */
  renderState(state: SettingsFormState): void;
  /** Defaults to Object.is for scalar values; object drafts must supply a field comparison. */
  equals?(left: Value, right: Value): boolean;
}

export interface SettingsForm {
  activate(context: UiActivation): Promise<void>;
  deactivate(): void;
  save(context: UiActivation): Promise<boolean>;
  /** Call after each user edit, including edits made while a load or save is pending. */
  changed(): void;
}

/** One form per settings section. It owns transient lifecycle state, never persistence or DOM. */
export { createSettingsForm } from "../../sidepanel/ui/settings-form.js";
export type SettingsFormHost = Pick<UiExtensionAPI, "signal" | "settings">;
