import type { ToolErrorConstructor } from "../../sdk/background.js";
import type { CdpCommand } from "../../sdk/background/browser.js";

interface Point { x: number; y: number }
interface TouchOptions { end?: Point; durationMs?: number; signal?: AbortSignal }

/** One finger on one guarded CDP connection. Cancellation never ends as a tap. */
export function createCdpTouch({ ToolExecutionError }: { ToolExecutionError: ToolErrorConstructor }) {
  return async function touch(send: CdpCommand, point: Point, { end, durationMs = 0, signal }: TouchOptions = {}) {
    const check = () => {
      if (signal?.aborted) throw new ToolExecutionError("OPERATION_ABORTED", "Touch gesture cancelled");
    };
    const pause = (ms: number) => new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort);
        reject(new ToolExecutionError("OPERATION_ABORTED", "Touch gesture cancelled")); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const dispatch = (type: string, position?: Point) => send("Input.dispatchTouchEvent", {
      type, touchPoints: position ? [{ ...position, id: 0, radiusX: 1, radiusY: 1, force: 1 }] : [],
    });
    check();
    let pressed = true;
    try {
      // Even a rejected response may have delivered touchStart, so cleanup is best-effort.
      await dispatch("touchStart", point);
      check();
      if (end) {
        for (let step = 1; step <= 8; step++) {
          await pause(durationMs / 8);
          check();
          await dispatch("touchMove", { x: point.x + (end.x - point.x) * step / 8,
            y: point.y + (end.y - point.y) * step / 8 });
          check();
        }
      } else if (durationMs) await pause(durationMs);
      check();
      await dispatch("touchEnd");
      pressed = false;
    } finally {
      if (pressed) { try { await dispatch("touchCancel"); } catch { /* The guarded connection may already be gone. */ } }
    }
  };
}
