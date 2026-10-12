import type { LifecycleObserver } from "#sdk/background/observers";
import { completionObserver } from "./context-and-observer.js";

// Replace this local diagnostic sink with your own metrics adapter; no message text is exposed.
export default [completionObserver(async (sessionId, runId) => {
  console.debug("Example task completed", { sessionId, runId });
})] satisfies readonly LifecycleObserver[];
