import type { getSecurityGuardrails } from "../../shared/security-guardrails.js";

/** Shared host contract; screenshot algorithms and coordinate state belong to media. */
export interface ScreenshotOptions { format?: "jpeg" | "png"; quality?: number; maxWidth?: number; maxHeight?: number }
/** cssWidth/cssHeight describe the image's full CSS extent, including scrollbar space. */
export interface Screenshot { dataUrl: string; method?: string; width?: number; height?: number; sourceWidth?: number; sourceHeight?: number; cssWidth?: number; cssHeight?: number; resized?: boolean }
export interface PageState { url?: string; title?: string }
export interface PageObservationHost {
  getTabPageState(tabId: unknown): Promise<PageState>;
  pageStateDelta(before: PageState, after: PageState): Record<string, unknown>;
  commitObservedPageNavigation?(input: { pageBefore: PageState; pageAfter: PageState; guardrails: Awaited<ReturnType<typeof getSecurityGuardrails>>; toolName: string; tabId: unknown }): unknown;
  getSecurityGuardrails: typeof getSecurityGuardrails;
}
