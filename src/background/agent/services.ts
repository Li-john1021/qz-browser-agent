import type { RuntimeConfig } from "../../sdk/background/providers.js";

/** Host services are resolved at lifecycle boundaries, never at module import. */
export interface AgentServices {
  getRuntimeConfig(): Promise<RuntimeConfig>;
  getRuntimeConfigVersion(): number;
  getPlatformInfo(): Promise<{ os?: string }>;
  buildSkillPromptSection(language?: string): Promise<string>;
  matchSiteSkillsForUrls: typeof import('../skills/runtime.js').matchSiteSkillsForUrls;
  getSkillToolRegistrySnapshot: typeof import('../skills/skill-tool-runtime.js').getSkillToolRegistryExecutionSnapshot;
  getSecurityGuardrails: typeof import('../../shared/security-guardrails.js').getSecurityGuardrails;
  trace(message: string): void;
}

/** Missing dependencies fail on use, so read-only message projection needs no host. */
export function agentService<K extends keyof AgentServices>(services: Partial<AgentServices> | null, name: K): AgentServices[K] {
  const service = services?.[name];
  if (typeof service !== 'function') throw new Error(`Agent host service is missing: ${name}`);
  return service as AgentServices[K];
}
