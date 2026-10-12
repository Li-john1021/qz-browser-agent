import { createTestAgentServices } from './agent-services.mjs';
import { attachProviderRecovery, providerRecoveryHint } from '../../src/background/llm/provider-recovery.js';
import { normalizeLlmFailure } from '../../src/background/llm/provider-errors.js';
import { trace } from '../../src/background/trace.js';

globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

const { Agent } = await import("../../src/background/agent/agent.js?provider-error-recovery");

export function createAgent(llm, { provider = "", retry = null } = {}) {
  const agent = new Agent("provider-recovery-session", {
    conversationRepository: {
      readActiveConversation: async () => null,
      writeActiveConversation: async () => true,
      clearActiveConversation: async () => true,
    },
    conversationLease: { sessionId: "provider-recovery-session", isActive: () => true },
    services: createTestAgentServices({ trace, getRuntimeConfig: async () => ({ provider, model: "test", contextWindow: 262000 }) }),
    llm: {
      ...llm,
      async *chatStream(...args) {
        try { yield* llm.chatStream(...args); }
        catch (error) { const failure = normalizeLlmFailure(error); throw attachProviderRecovery(failure, providerRecoveryHint(failure, { provider })); }
      },
    },
    tools: { execute: async () => ({}), getIdentity: () => ({}), getSchemas: () => [] },
    browserContext: { readSelectedText: async () => "", getTab: async () => null },
    sessionPolicy: { canManageSessions: async () => true },
  });
  agent._currentRunId = "provider-recovery-run";
  if (retry) {
    const getLlmOptions = agent._llmOptions.bind(agent);
    agent._llmOptions = () => ({ ...getLlmOptions(), retry });
  }
  agent._persistIfToolLedgerRepaired = async () => false;
  agent._ensureDynamicContextSnapshot = async () => ({});
  agent._appendGoalSnapshotIfDue = async () => false;
  agent._prepareSendWindowOrBlock = async () => ({
    ok: true,
    status: "ok",
    sendBoundaryId: "boundary-test",
    sendMessages: [],
    contextEstimate: { tokens: 0, messageCount: 0 },
  });
  agent._emitSendWindowContextUsage = () => {};
  agent._traceSendWindow = () => {};
  agent._stampAssistantUsageContext = () => {};
  agent._emitProviderContextUsage = () => {};
  return agent;
}

export function createLoopAgent(responses) {
  const agent = createAgent({ chat: async () => ({}), chatStream: async function* () {} });
  const queue = [...responses];
  agent.messages = [
    { role: "system", content: "system" },
    { role: "user", content: "需要澄清后继续" },
  ];
  agent._callLLM = async () => queue.shift();
  agent._persistConversation = async () => true;
  agent._flushPendingContextEvents = async () => {};
  return agent;
}
