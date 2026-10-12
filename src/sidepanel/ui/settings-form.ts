import type { SettingsForm, SettingsFormHost, SettingsFormOptions, SettingsFormPhase } from "../../sdk/sidepanel/settings-form.js";

interface ActiveForm { readonly controller: AbortController; readonly signal: AbortSignal }

/** Tab switches retain drafts; reopening starts a fresh read. Only the active operation may publish. */
export function createSettingsForm<Value>(host: SettingsFormHost, options: SettingsFormOptions<Value>): SettingsForm {
  const equals = options.equals || Object.is;
  let saved = structuredClone(options.initialValue);
  let baselineKnown = false;
  let generation = -1;
  let revision = 0;
  let operation = 0;
  let active: ActiveForm | null = null;
  let phase: SettingsFormPhase = "idle";
  let error: unknown;
  if (!host.signal.aborted) options.setDraft(structuredClone(saved));

  const owns = (owner: ActiveForm, ticket: number) => active === owner && operation === ticket
    && !owner.signal.aborted && !host.signal.aborted;
  // A placeholder (or a value before an uncertain write) is not proof of persisted equality.
  const isDirty = () => (!baselineKnown && generation === host.settings.getOpenGeneration()) || !equals(options.getDraft(), saved);
  function render() {
    if (active && !active.signal.aborted && !host.signal.aborted) options.renderState({ phase, dirty: isDirty(), error });
  }
  function deactivate() {
    operation += 1;
    active?.controller.abort();
    active = null;
    if (phase === "loading" || phase === "saving") phase = "idle";
  }

  return {
    async activate({ signal }) {
      deactivate();
      if (host.signal.aborted || signal.aborted) return;
      const controller = new AbortController();
      const owner = { controller, signal: AbortSignal.any([host.signal, signal, controller.signal]) };
      active = owner;
      const lifetime = owner.signal;
      const openGeneration = host.settings.getOpenGeneration();
      if (generation === openGeneration) { render(); return; }
      const ticket = ++operation;
      const readRevision = revision;
      options.setDraft(structuredClone(saved));
      baselineKnown = false;
      phase = "loading";
      error = undefined;
      render();
      try {
        const value = await options.load(lifetime);
        if (lifetime.aborted || !owns(owner, ticket)) return;
        saved = structuredClone(value);
        baselineKnown = true;
        if (revision === readRevision) options.setDraft(structuredClone(saved));
        generation = openGeneration;
        phase = "idle";
      } catch (cause) {
        if (lifetime.aborted || !owns(owner, ticket)) return;
        phase = "load-error";
        error = cause;
      } finally {
        if (!lifetime.aborted && owns(owner, ticket)) render();
      }
    },
    deactivate,
    async save({ signal }) {
      const owner = active;
      if (!owner || owner.signal.aborted || host.signal.aborted || signal.aborted || phase === "loading" || phase === "saving") return false;
      if (!isDirty()) return true;
      const lifetime = AbortSignal.any([host.signal, signal, owner.signal]);
      const ticket = ++operation;
      const savedRevision = revision;
      const value = structuredClone(options.getDraft());
      baselineKnown = false;
      phase = "saving";
      error = undefined;
      render();
      try {
        const result = await options.save(structuredClone(value), lifetime);
        if (lifetime.aborted || !owns(owner, ticket)) return false;
        if (result === false) {
          phase = "save-error";
          return false;
        }
        saved = value;
        baselineKnown = true;
        generation = host.settings.getOpenGeneration();
        phase = revision === savedRevision ? "saved" : "idle";
        return true;
      } catch (cause) {
        if (lifetime.aborted || !owns(owner, ticket)) return false;
        phase = "save-error";
        error = cause;
        return false;
      } finally {
        if (owns(owner, ticket)) {
          if (lifetime.aborted) phase = "idle";
          render();
        }
      }
    },
    changed() {
      if (!active || active.signal.aborted || host.signal.aborted) return;
      revision += 1;
      generation = host.settings.getOpenGeneration();
      if (phase !== "loading" && phase !== "saving") phase = "idle";
      error = undefined;
      render();
    },
  };
}
