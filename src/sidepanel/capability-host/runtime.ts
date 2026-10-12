import type { PortMessage } from "../features/app/port-client.js";
import type { UiExtension, UiExtensionAPI, UiActivation, UiDialogInput, UiOverlay, UiPage, UiSettingsSection } from "../../sdk/sidepanel/ui.js";
import type { CapabilityStorageAdapter, CapabilityStateStore } from "../../shared/capability-state-store.js";
import { createCapabilityStateStore } from "../../shared/capability-state-store.js";
import { mountUiTemplate } from "./mount-template.js";
import { createUiEventSnapshot } from "./event-snapshot.js";

interface UiContribution { pages?: readonly UiPage[]; overlays?: readonly UiOverlay[]; settingsSections?: readonly UiSettingsSection[]; dispose?(): unknown }
interface SidepanelUiHost extends Omit<UiExtensionAPI, "on" | "registerPage" | "registerSettings" | "registerOverlay" | "extensions"> {
  onEvent(listener: (event: PortMessage) => unknown): () => void;
  readonly extensions: UiExtensionAPI["extensions"] & { onEvent(listener: (event: PortMessage) => unknown, signal: AbortSignal): () => void };
}
interface SidepanelUiCapability { readonly id: string; mount(host: SidepanelUiHost): UiContribution | Promise<UiContribution> }
export interface UiExtensionEntry { readonly id: string; readonly setup: UiExtension }

export type UiHostServices = Omit<SidepanelUiHost, "signal" | "onEvent" | "onDispose" | "mountTemplate" | "storage" | "extensions"> & {
  extensions: Omit<SidepanelUiHost["extensions"], "register"> & {
    register(contribution: Parameters<UiExtensionAPI["extensions"]["register"]>[0], signal: AbortSignal): () => void;
  };
};
export type UiRestoreResult = "restored" | "failed" | "cancelled";
interface Owner {
  id: string; controller: AbortController; contribution?: UiContribution;
  cleanups: (() => unknown)[]; listeners: Set<(event: PortMessage) => unknown>;
}
interface Owned<T> { owner: Owner; value: T }
export interface SidepanelUiRuntimeOptions {
  host: UiHostServices;
  storage?: CapabilityStorageAdapter;
  onError?(error: unknown, context: { capabilityId: string; phase: string }): void;
}

/** One registry owns UI lifetimes; packages own business state and their DOM. */
export function createSidepanelUiRuntime({ host, storage = globalThis.chrome?.storage?.local, onError = (error) => console.error(error) }: SidepanelUiRuntimeOptions) {
  const owners = new Map<string, Owner>();
  const pages = new Map<string, Owned<UiPage>>();
  const overlays = new Map<string, Owned<UiOverlay>>();
  const sections = new Map<string, Owned<UiSettingsSection>>();
  const changes = new Set<() => void>();
  let active: { entry: Owned<UiPage>; controller: AbortController } | null = null;

  function report(owner: Pick<Owner, "id">, phase: string, error: unknown) {
    try { onError(error, { capabilityId: owner.id, phase }); } catch { /* Diagnostics cannot block cleanup. */ }
  }
  function invoke<T>(owner: Owner, phase: string, callback: () => T): T | undefined {
    try {
      const value = callback();
      if (value && typeof (value as { then?: unknown }).then === "function") {
        void Promise.resolve(value).catch(error => { if (!owner.controller.signal.aborted || phase === "dispose") report(owner, phase, error); });
      }
      return value;
    } catch (error) { report(owner, phase, error); return undefined; }
  }
  function changed() {
    for (const listener of changes) {
      try { listener(); } catch (error) {
        try { onError(error, { capabilityId: "shell", phase: "change" }); } catch { /* Continue notifying independent hosts. */ }
      }
    }
  }
  function validate<T extends { readonly id: string }>(entries: readonly T[] | undefined, registry: Map<string, Owned<T>>, kind: string) {
    const ids = new Set<string>();
    for (const entry of entries || []) {
      if (!entry.id?.trim() || ids.has(entry.id) || registry.has(entry.id)) throw new Error(`Duplicate or empty UI ${kind} id: ${entry.id}`);
      ids.add(entry.id);
    }
  }
  function install(owner: Owner, contribution: UiContribution) {
    owner.contribution = contribution;
    if (owner.controller.signal.aborted) { disposeContribution(owner); return false; }
    // Validate the whole contribution before publishing any page or settings group.
    validate(contribution.pages, pages, "page");
    validate(contribution.overlays, overlays, "overlay");
    validate(contribution.settingsSections, sections, "settings section");
    for (const page of contribution.pages || []) pages.set(page.id, { owner, value: Object.freeze({ ...page, elements: Object.freeze([...page.elements]) }) });
    for (const overlay of contribution.overlays || []) overlays.set(overlay.id, { owner, value: Object.freeze({ ...overlay }) });
    for (const section of contribution.settingsSections || []) sections.set(section.id, { owner, value: Object.freeze({ ...section }) });
    changed();
    return true;
  }
  function mount(capability: SidepanelUiCapability): boolean | Promise<boolean> {
    if (!capability.id?.trim() || owners.has(capability.id)) throw new Error(`Duplicate or empty UI capability id: ${capability.id}`);
    const owner: Owner = { id: capability.id, controller: new AbortController(), cleanups: [], listeners: new Set() };
    owners.set(owner.id, owner);
    const signal = owner.controller.signal;
    const guarded = <Args extends unknown[], Result>(effect: (...args: Args) => Result, receiver: unknown = host) =>
      (...args: Args) => signal.aborted ? undefined : effect.apply(receiver, args);
    const writable = <Args extends unknown[], Result>(effect: (...args: Args) => Result) =>
      (...args: Args) => { signal.throwIfAborted(); return effect.apply(host.sessions, args); };
    const dialog = async <T>(signals: (AbortSignal | undefined)[], run: (signal: AbortSignal) => Promise<T>, cancelled: T) => {
      const lifetime = AbortSignal.any([signal, ...signals.filter((value): value is AbortSignal => Boolean(value))]);
      if (lifetime.aborted) return cancelled;
      const result = await run(lifetime);
      return lifetime.aborted ? cancelled : result;
    };
    let stateStore: CapabilityStateStore;
    const store = () => {
      if (!storage) throw new Error("Capability storage is unavailable");
      return stateStore ||= createCapabilityStateStore(owner.id, storage, signal);
    };
    const scopedHost: SidepanelUiHost = Object.freeze({ ...host, signal,
      providers: host.providers && { createSettings(input: Parameters<UiExtensionAPI["providers"]["createSettings"]>[0]) {
        signal.throwIfAborted();
        return host.providers.createSettings({ ...input, signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal });
      } },
      storage: {
        get: async (...args: Parameters<CapabilityStateStore["get"]>) => store().get(...args),
        set: async (...args: Parameters<CapabilityStateStore["set"]>) => store().set(...args),
        remove: async (...args: Parameters<CapabilityStateStore["remove"]>) => store().remove(...args),
      },
      mountTemplate(id: string) {
        signal.throwIfAborted();
        return mountUiTemplate(host.root, id, cleanup => owner.cleanups.push(cleanup));
      },
      sessions: host.sessions && { ...host.sessions,
        mergeRecord: writable(host.sessions.mergeRecord), mergeRecords: writable(host.sessions.mergeRecords),
        mergeRuntime: writable(host.sessions.mergeRuntime), updateRuntime: writable(host.sessions.updateRuntime),
        open: (...[id, options]: Parameters<SidepanelUiHost["sessions"]["open"]>) => {
          signal.throwIfAborted();
          return host.sessions.open(id, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
        },
        export: writable(host.sessions.export),
      },
      chat: host.chat && { ...host.chat,
        setInput: guarded(host.chat.setInput, host.chat), showWelcome: guarded(host.chat.showWelcome, host.chat), focus: guarded(host.chat.focus, host.chat),
        refresh: guarded(host.chat.refresh, host.chat), scheduleRender: guarded(host.chat.scheduleRender, host.chat), appendNote: guarded(host.chat.appendNote, host.chat),
        clearInlineActions: guarded(host.chat.clearInlineActions, host.chat), flashAction: guarded(host.chat.flashAction, host.chat),
        refreshReferences: guarded(host.chat.refreshReferences, host.chat), renderGoal: guarded(host.chat.renderGoal, host.chat),
      },
      async request(type: string, payload?: PortMessage, timeoutMs?: number | null) {
        signal.throwIfAborted();
        const result = await host.request(type, payload, timeoutMs);
        signal.throwIfAborted();
        return result;
      },
      send: guarded(host.send), showToast: guarded(host.showToast),
      hideToast: (...args: Parameters<SidepanelUiHost["hideToast"]>) => !signal.aborted && host.hideToast(...args),
      notifyViewChange: guarded(host.notifyViewChange), setDebugMode: guarded(host.setDebugMode), syncKeepAlive: guarded(host.syncKeepAlive),
      navigate: (...args: Parameters<SidepanelUiHost["navigate"]>) => !signal.aborted && host.navigate(...args),
      settings: { ...host.settings, open: guarded(host.settings.open, host.settings), close: guarded(host.settings.close, host.settings),
        refresh: guarded(host.settings.refresh, host.settings), setState: guarded(host.settings.setState, host.settings) },
      extensions: {
        register: (...[contribution, external]: Parameters<SidepanelUiHost["extensions"]["register"]>) =>
          host.extensions.register(contribution, external ? AbortSignal.any([signal, external]) : signal),
        onEvent: (...[listener, external]: Parameters<SidepanelUiHost["extensions"]["onEvent"]>) =>
          host.extensions.onEvent?.(listener, external ? AbortSignal.any([signal, external]) : signal) || (() => {}),
        notify: guarded(host.extensions.notify, host.extensions), invoke: guarded(host.extensions.invoke, host.extensions), hasCommand: (...args: Parameters<SidepanelUiHost["extensions"]["hasCommand"]>) => host.extensions.hasCommand(...args),
      },
      dialogs: host.dialogs && {
        confirm: (input: unknown, options?: UiDialogInput) => dialog([
          options?.signal, input && typeof input === "object" && "signal" in input ? input.signal as AbortSignal : undefined,
        ], signal => host.dialogs.confirm(input, { ...options, signal }), false),
        choose: (input?: UiDialogInput) => dialog([input?.signal], signal => host.dialogs.choose({ ...input, signal }), null),
        requestText: (input?: UiDialogInput) => dialog([input?.signal], signal => host.dialogs.requestText({ ...input, signal }), null),
      },
      onEvent(listener: (event: PortMessage) => unknown) {
        if (!owner.controller.signal.aborted) owner.listeners.add(listener);
        return () => owner.listeners.delete(listener);
      },
      onDispose(cleanup: () => unknown) {
        if (owner.controller.signal.aborted) invoke(owner, "dispose", cleanup);
        else owner.cleanups.push(cleanup);
      },
    });
    const failed = (error: unknown) => { report(owner, "mount", error); void unmount(owner.id, owner); return false; };
    try {
      const contribution = capability.mount(scopedHost);
      return contribution instanceof Promise ? contribution.then(value => install(owner, value)).catch(failed) : install(owner, contribution);
    } catch (error) { return failed(error); }
  }
  function setupExtension(entry: UiExtensionEntry): SidepanelUiCapability {
    return { id: entry.id, mount(host) {
      const owner = owners.get(entry.id)!;
      const pages: UiPage[] = [], sections: UiSettingsSection[] = [], overlays: UiOverlay[] = [];
      let collecting = true;
      const register = <T>(target: T[], value: T) => {
        host.signal.throwIfAborted();
        if (!collecting) throw new Error("UI registration must finish during extension setup");
        target.push(value);
      };
      const { onEvent, extensions, ...ports } = host;
      const qz: UiExtensionAPI = Object.freeze({ ...ports,
        extensions: { register: extensions.register, notify: extensions.notify, hasCommand: extensions.hasCommand, invoke: extensions.invoke },
        registerPage: (page: UiPage) => register(pages, page),
        registerSettings: (section: UiSettingsSection) => register(sections, section),
        registerOverlay: (overlay: UiOverlay) => register(overlays, overlay),
        on(type: string, listener: (event: PortMessage) => unknown) {
          const filtered = (event: PortMessage) => type === "*" || event.type === type ? listener(event) : undefined;
          const accepted = onEvent(filtered);
          const local = extensions.onEvent?.(event => {
            if (host.signal.aborted) return;
            return invoke(owner, "event", () => filtered(event));
          }, host.signal);
          return () => { accepted(); local?.(); };
        },
      });
      const complete = () => { collecting = false; return { pages, settingsSections: sections, overlays }; };
      const result = entry.setup(qz);
      return result instanceof Promise ? result.then(complete) : complete();
    } };
  }
  async function mountAll(capabilities: readonly UiExtensionEntry[]) {
    const ids = new Set(owners.keys());
    for (const capability of capabilities) {
      if (!capability.id?.trim() || ids.has(capability.id)) throw new Error(`Duplicate or empty UI capability id: ${capability.id}`);
      ids.add(capability.id);
    }
    await Promise.all(capabilities.map(entry => mount(setupExtension(entry))));
  }
  function disposeContribution(owner: Owner) {
    const contribution = owner.contribution;
    owner.contribution = undefined;
    return contribution?.dispose ? invoke(owner, "dispose", () => contribution.dispose?.()) : undefined;
  }
  async function unmount(id: string, expected?: Owner) {
    const owner = owners.get(id);
    if (!owner || (expected && owner !== expected)) return;
    owners.delete(id);
    owner.controller.abort();
    if (active?.entry.owner === owner) deactivatePage();
    owner.listeners.clear();
    for (const entry of pages.values()) {
      if (entry.owner === owner) entry.value.elements.forEach(element => element?.classList.add("hidden"));
    }
    for (const registry of [pages, overlays, sections]) {
      for (const [key, entry] of registry) if (entry.owner === owner) registry.delete(key);
    }
    const cleanup = [...owner.cleanups.reverse().map(callback => invoke(owner, "dispose", callback)), disposeContribution(owner)];
    owner.cleanups.length = 0;
    changed();
    await Promise.allSettled(cleanup);
  }
  function deactivatePage() {
    const previous = active;
    active = null;
    if (!previous) return;
    previous.controller.abort();
    invoke(previous.entry.owner, "deactivate", () => previous.entry.value.deactivate?.());
  }
  function activation(entry: Owned<UiPage>, refresh: boolean): UiActivation {
    if (active?.entry !== entry) {
      deactivatePage();
      active = { entry, controller: new AbortController() };
    }
    return { signal: AbortSignal.any([active.controller.signal, entry.owner.controller.signal]), refresh };
  }
  function isPageEnabled(id: string) {
    const entry = pages.get(id);
    return Boolean(entry && (!entry.value.isEnabled || invoke(entry.owner, "enabled", () => entry.value.isEnabled?.()) === true));
  }
  function activatePage(id: string, { refresh = true } = {}) {
    const entry = pages.get(id);
    if (!entry || !isPageEnabled(id)) return false;
    const context = activation(entry, refresh);
    invoke(entry.owner, "activate", () => entry.value.activate?.(context));
    return true;
  }
  async function restorePage(id: string, state: unknown): Promise<UiRestoreResult> {
    const entry = pages.get(id);
    if (!entry || !isPageEnabled(id)) return "failed";
    const context = activation(entry, false);
    try { await entry.value.restore?.(state, context); return context.signal.aborted ? "cancelled" : "restored"; }
    catch (error) {
      if (context.signal.aborted) return "cancelled";
      report(entry.owner, "restore", error);
      return "failed";
    }
  }
  function capturePage(id: string) {
    const entry = pages.get(id);
    const value = entry ? invoke(entry.owner, "capture", () => entry.value.capture?.()) : undefined;
    return value && typeof (value as { then?: unknown }).then === "function" ? null : value ?? null;
  }
  function closeTopmostOverlay() {
    for (const entry of [...overlays.values()].sort((a, b) => (b.value.priority || 0) - (a.value.priority || 0))) {
      if (invoke(entry.owner, "overlay close", () => entry.value.close()) === true) return true;
    }
    return false;
  }
  function hasBlockingOverlay() {
    return [...overlays.values()].some(entry => invoke(entry.owner, "overlay focus", () => entry.value.blocksFocus()) === true);
  }
  function emit(event: PortMessage) {
    let snapshot: PortMessage;
    try { snapshot = createUiEventSnapshot(event); }
    catch (error) { report({ id: "events" }, "event snapshot", error); return; }
    for (const owner of owners.values()) for (const listener of owner.listeners) invoke(owner, "event", () => listener(snapshot));
  }
  const ordered = <T extends { id: string; order?: number }>(registry: Map<string, Owned<T>>) =>
    [...registry.values()].map(entry => entry.value).sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
  return {
    mount, mountAll, unmount: (id: string) => unmount(id), emit, activatePage, deactivatePage, restorePage, capturePage, isPageEnabled,
    getPages: () => ordered(pages), getPage: (id: string) => pages.get(id)?.value,
    getSettingsSections: () => ordered(sections), closeTopmostOverlay, hasBlockingOverlay,
    subscribeChanges(listener: () => void) { changes.add(listener); return () => changes.delete(listener); },
    async dispose() { await Promise.all([...owners.keys()].map(id => unmount(id))); changes.clear(); },
  };
}
export type SidepanelUiRuntime = ReturnType<typeof createSidepanelUiRuntime>;
