type WorkKind = "render" | "backfill";
type PendingWork = { dueAt: number; cancel(): void };
type SessionWork = Partial<Record<WorkKind, PendingWork>>;
interface SchedulerOptions {
  workspaceRoot: HTMLElement | null;
  isActive(sessionId: string): boolean;
  render(sessionId: string): void;
  backfill(sessionId: string): void;
  /** null selects idle time; the renderer owns live/scroll deferral policy. */
  backfillDelay(sessionId: string): number | null;
  trace?(event: "ui_render_timer_set" | "ui_render_timer_fire", sessionId: string, meta: Record<string, unknown>): void;
}

const TRANSCRIPT_INPUT_YIELD_MAX_MS = 96;
const TRANSCRIPT_BACKFILL_REVEAL_DELAY_MS = 80;

/** Owns pending transcript work only; projection, DOM and scroll state stay with their features. */
export function createTranscriptScheduler(options: SchedulerOptions) {
  const pending = new Map<string, SessionWork>();
  const host = typeof window !== "undefined" ? window : globalThis;

  function cancel(sessionId?: string, kind?: WorkKind) {
    const entries = sessionId ? [[sessionId, pending.get(sessionId)] as const] : [...pending.entries()];
    for (const [id, work] of entries) {
      if (!work) continue;
      for (const key of kind ? [kind] : ["render", "backfill"] as const) {
        const task = work[key];
        // Revoke ownership before releasing the browser handle: queued callbacks may still arrive.
        delete work[key];
        task?.cancel();
      }
      if (!work.render && !work.backfill) pending.delete(id);
    }
  }

  function enqueue(sessionId: string, kind: WorkKind, dueAt: number,
    start: (run: () => void) => () => void, run: () => void) {
    const work = pending.get(sessionId) || {};
    const task: PendingWork = { dueAt, cancel() {} };
    work[kind] = task;
    pending.set(sessionId, work);
    task.cancel = start(() => {
      if (pending.get(sessionId)?.[kind] !== task) return;
      cancel(sessionId, kind);
      if (options.isActive(sessionId)) run();
    });
  }

  function requestRender(sessionId: string, delay: number) {
    if (!options.isActive(sessionId)) return;
    const dueAt = Date.now() + delay;
    const previous = pending.get(sessionId)?.render;
    if (previous && previous.dueAt <= dueAt) return;
    cancel(sessionId, "render");
    options.trace?.("ui_render_timer_set", sessionId, { delay, hadPending: Boolean(previous) });
    let readyAt = 0;
    let inputYields = 0;
    const requestFrame = () => enqueue(sessionId, "render", dueAt, run => {
      const handle = requestAnimationFrame(run);
      return () => cancelAnimationFrame(handle);
    }, () => {
      if (shouldYieldTranscriptRender(readyAt)) {
        inputYields += 1;
        requestFrame();
        return;
      }
      options.trace?.("ui_render_timer_fire", sessionId, { delay, inputYields });
      options.render(sessionId);
    });
    const ready = () => { readyAt = Date.now(); requestFrame(); };
    if (delay > 0) {
      enqueue(sessionId, "render", dueAt, run => {
        const handle = setTimeout(run, delay);
        return () => clearTimeout(handle);
      }, ready);
    } else ready();
  }

  function requestBackfill(sessionId: string) {
    if (pending.get(sessionId)?.backfill || !options.isActive(sessionId)) return;
    const root = options.workspaceRoot;
    if (root?.hasAttribute("data-workspace-booting") && typeof host.MutationObserver === "function") {
      enqueue(sessionId, "backfill", 0, run => {
        const observer = new host.MutationObserver(() => {
          if (!root.hasAttribute("data-workspace-booting")) run();
        });
        observer.observe(root, { attributes: true, attributeFilter: ["data-workspace-booting"] });
        return () => observer.disconnect();
      }, () => {
        enqueue(sessionId, "backfill", 0, run => {
          const handle = setTimeout(run, TRANSCRIPT_BACKFILL_REVEAL_DELAY_MS);
          return () => clearTimeout(handle);
        }, () => requestBackfill(sessionId));
      });
      return;
    }
    const delay = options.backfillDelay(sessionId);
    enqueue(sessionId, "backfill", 0, run => {
      if (delay === null && typeof host.requestIdleCallback === "function") {
        const handle = host.requestIdleCallback(run, { timeout: 700 });
        return () => host.cancelIdleCallback?.(handle);
      }
      const handle = setTimeout(run, delay ?? TRANSCRIPT_BACKFILL_REVEAL_DELAY_MS);
      return () => clearTimeout(handle);
    }, () => options.backfill(sessionId));
  }

  return { requestRender, requestBackfill, cancel };
}

function shouldYieldTranscriptRender(readyAt: number) {
  if (!readyAt || Date.now() - readyAt >= TRANSCRIPT_INPUT_YIELD_MAX_MS) return false;
  const scheduling = (globalThis.navigator as Navigator & { scheduling?: { isInputPending(options: { includeContinuous: boolean }): boolean } })?.scheduling;
  if (typeof scheduling?.isInputPending !== "function") return false;
  try {
    return scheduling.isInputPending({ includeContinuous: true });
  } catch (_err) {
    return false;
  }
}
