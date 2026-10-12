import type { ToolContext } from "../../sdk/background.js";
import type { SecurityGuardrails } from "../../shared/security-guardrails.js";

/** Navigation evidence is owned by the execution host, shared by page capabilities. */
export interface PageState { url: string; title: string }
export interface PreparedNavigation { url: string; rateLimitMatch?: unknown; rateLimit?: unknown }
export interface PageNavigationHost {
  getTabPageState(tabId: number): Promise<PageState>;
  pageStateDelta(before: PageState, after: PageState): { pageBefore: PageState; pageAfter: PageState; urlChanged: boolean; titleChanged: boolean };
  prepareKnownPageNavigation(input: { url: string; pageBefore: PageState; guardrails: SecurityGuardrails; context: ToolContext;
    signal?: AbortSignal; toolName: string; toolArgs: Record<string, unknown>; tabId: number; source: string }): Promise<PreparedNavigation | null>;
  commitObservedPageNavigation(input: { pageBefore: PageState; pageAfter: PageState; prepared: PreparedNavigation | null;
    guardrails: SecurityGuardrails; toolName: string; tabId: number }): object | null;
}
