import type { LifecycleObserver } from "../../sdk/background/observers.js";
import type { RuntimeConfig } from "../../sdk/background/providers.js";

export interface ProductActionContext {
  sourceWindowId: number | null;
  progress(event: unknown): void;
}
export interface ProductRuntimeHost {
  browser: Pick<typeof chrome, "storage" | "scripting" | "tabs" | "alarms" | "runtime">;
  llm: Pick<typeof import("../llm/index.js"), "chat" | "chatStream">;
  windowTarget: ReturnType<typeof import("../services/chrome-window-target.js").createChromeWindowTarget>;
  getTranscript(sessionId: string): unknown[] | Promise<unknown[]>;
  trace(event: string, details?: unknown): void;
  refreshConfig(): Promise<RuntimeConfig>;
}
export interface ProductRuntime {
  llm: ProductRuntimeHost["llm"];
  observers: readonly LifecycleObserver[];
  onModelChange(previous: Pick<RuntimeConfig, "provider" | "model">, next: Pick<RuntimeConfig, "provider" | "model">): unknown;
  removeSession(sessionId: string): unknown;
  dispatch(message: Readonly<Record<string, unknown>>, context: ProductActionContext): Promise<{ type: string; payload: unknown } | null>;
  start(): Promise<unknown>;
}
