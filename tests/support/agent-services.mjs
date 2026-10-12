/** Pure host services for Agent tests; no storage, browser, provider, or Skill globals. */
export function createTestAgentServices(overrides = {}) {
  return {
    getRuntimeConfig: async () => ({ provider: 'test', model: 'test-model', contextWindow: 262000, vision: true }),
    getRuntimeConfigVersion: () => 0,
    getPlatformInfo: async () => ({}),
    buildSkillPromptSection: async () => '',
    matchSiteSkillsForUrls: async () => [],
    getSkillToolRegistrySnapshot: () => ({ version: 0, tools: [] }),
    getSecurityGuardrails: async () => ({ blockedDomains: [], blockedPatterns: [] }),
    trace() {},
    ...overrides,
  };
}

export function createTestAgentOptions(overrides = {}) {
  let stored = null;
  return {
    services: createTestAgentServices(),
    conversationRepository: {
      readActiveConversation: async () => stored,
      writeActiveConversation: async (_id, value) => { stored = structuredClone(value); return true; },
      clearActiveConversation: async () => { stored = null; return true; },
    },
    llm: { chat: async () => { throw new Error('Unexpected fake LLM chat'); }, chatStream: async function* () { throw new Error('Unexpected fake LLM stream'); } },
    tools: { execute: async () => { throw new Error('Unexpected fake tool'); }, getIdentity: () => ({}), getSchemas: () => [] },
    ...overrides,
  };
}
