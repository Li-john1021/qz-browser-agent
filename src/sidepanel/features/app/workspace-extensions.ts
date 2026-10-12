import type { TranscriptEntry } from "../../tools/renderer-input.js";
import type { PortMessage } from "./port-client.js";
import { createUiEventSnapshot } from "../../capability-host/event-snapshot.js";

import type { UiReferenceItem, UiReferenceSource, UiTranscriptContribution, UiCommand, WorkspaceContribution } from "../../../sdk/sidepanel/ui.js";
export type { UiReferenceItem, UiReferenceSource, UiTranscriptContribution, UiCommand, WorkspaceContribution } from "../../../sdk/sidepanel/ui.js";

/** Public extension slots contain behavior, never concrete feature instances. A package's
 * scope owns every registration; aborting it removes both callbacks and command authority. */
export function createWorkspaceExtensions(onError: (error: unknown) => void = console.warn) {
  const commands = new Map<string, UiCommand>();
  const references = new Map<string, { source: UiReferenceSource; signal: AbortSignal }>();
  const transcript = new Map<string, UiTranscriptContribution>();
  const listeners = new Set<(event: PortMessage) => unknown>();

  function register(contribution: WorkspaceContribution, signal: AbortSignal) {
    if (signal.aborted) return () => {};
    // Validate the whole contribution before installing any of it.
    for (const [entries, registry] of [
      [contribution.commands || [], commands], [contribution.references || [], references],
      [contribution.transcript || [], transcript],
    ] as const) {
      const ids = new Set<string>();
      for (const entry of entries) {
        if (!entry.id || ids.has(entry.id) || registry.has(entry.id)) throw new Error(`Duplicate or empty UI extension id: ${entry.id}`);
        ids.add(entry.id);
      }
    }
    const ownedCommands = (contribution.commands || []).map(command => Object.freeze({ ...command }));
    const ownedReferences = (contribution.references || []).map(source => ({ source: Object.freeze({ ...source }), signal }));
    const ownedTranscript = (contribution.transcript || []).map(renderer => Object.freeze({ ...renderer }));
    for (const command of ownedCommands) commands.set(command.id, command);
    for (const source of ownedReferences) references.set(source.source.id, source);
    for (const renderer of ownedTranscript) transcript.set(renderer.id, renderer);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", dispose);
      for (const entry of ownedCommands) if (commands.get(entry.id) === entry) commands.delete(entry.id);
      for (const entry of ownedReferences) if (references.get(entry.source.id) === entry) references.delete(entry.source.id);
      for (const entry of ownedTranscript) if (transcript.get(entry.id) === entry) transcript.delete(entry.id);
    };
    signal.addEventListener("abort", dispose, { once: true });
    return dispose;
  }

  function onEvent(listener: (event: PortMessage) => unknown, signal: AbortSignal) {
    if (signal.aborted) return () => {};
    listeners.add(listener);
    const dispose = () => { listeners.delete(listener); signal.removeEventListener("abort", dispose); };
    signal.addEventListener("abort", dispose, { once: true });
    return dispose;
  }
  function report(error: unknown) {
    try { onError(error); } catch { /* Diagnostics cannot interrupt consumers. */ }
  }
  function safely<T>(run: () => T, fallback: T): T {
    try { return run(); } catch (error) { report(error); return fallback; }
  }

  return {
    register, onEvent,
    notify(event: PortMessage) {
      const snapshot = safely(() => createUiEventSnapshot(event), null);
      if (!snapshot) return;
      for (const listener of [...listeners]) {
        const result = safely(() => listener(snapshot), undefined);
        if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(report);
      }
    },
    hasCommand: (id: string) => commands.has(id),
    invoke(id: string, payload?: unknown): unknown {
      const command = commands.get(id);
      if (!command) return undefined;
      return command.run(payload);
    },
    referenceSources() {
      return [...references.values()].map(entry => entry.source)
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
    },
    async listReferences(): Promise<UiReferenceItem[]> {
      const results = await Promise.all([...references.values()].map(async entry => {
        try {
          const items = await entry.source.list(entry.signal);
          return entry.signal.aborted || references.get(entry.source.id) !== entry ? [] : [...items];
        } catch (error) { if (!entry.signal.aborted) onError(error); return []; }
      }));
      return results.flat();
    },
    projectTranscript(entries: TranscriptEntry[], sessionId: string) {
      return [...transcript.values()].reduce((result, extension) =>
        extension.project ? safely(() => extension.project!(result, sessionId), result) : result, entries);
    },
    createTranscriptElement(entry: TranscriptEntry) {
      return safely(() => transcript.get(entry.type || "")?.create?.(entry) || null, null);
    },
    patchTranscriptElement(element: HTMLElement, entry: TranscriptEntry) {
      return safely(() => transcript.get(entry.type || "")?.patch?.(element, entry) === true, false);
    },
    retireTranscriptElement(element: HTMLElement) {
      const retire = transcript.get(element.dataset.transcriptType || "")?.retire;
      return retire ? safely(() => { retire(element); return true; }, false) : false;
    },
    previewTranscript(entry: TranscriptEntry) {
      return safely(() => transcript.get(entry.type || "")?.preview?.(entry) || "", "");
    },
  };
}

export type WorkspaceExtensions = ReturnType<typeof createWorkspaceExtensions>;
