import { createTestAgentServices } from "../support/agent-services.mjs";
import assert from "node:assert/strict";
import test from "node:test";

globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

const { Agent } = await import("../../src/background/agent/agent.js?tool-argument-parsing");

test("Agent preserves a bare array so the tool boundary can report its real type", async () => {
  const input = [{ type: "heading", text: "Report", level: 1 }];
  const result = await executeInvalidToolCall({
    name: "document_create",
    arguments: JSON.stringify(input),
  });

  assert.deepEqual(result.executions[0].args, input);
  assert.deepEqual(result.end.args, input);
  assert.equal(result.end.result.code, "INVALID_ARGUMENTS");
  assert.equal(result.end.result.details.receivedType, "array");
});

test("Agent preserves malformed JSON instead of silently replacing it with an empty object", async () => {
  const malformed = '{"selector":"main"';
  const result = await executeInvalidToolCall({
    name: "read_dom",
    arguments: malformed,
  });

  assert.equal(result.executions[0].args, malformed);
  assert.equal(result.end.args, malformed);
  assert.equal(result.end.result.code, "INVALID_ARGUMENTS");
  assert.equal(result.end.result.details.receivedType, "string");
});

async function executeInvalidToolCall({ name, arguments: argsText }) {
  const executions = [];
  const events = [];
  const agent = new Agent("argument-session", {
    services: createTestAgentServices(),
    conversationRepository: {
      readActiveConversation: async () => null,
      writeActiveConversation: async () => true,
      clearActiveConversation: async () => true,
    },
    conversationLease: { sessionId: "argument-session", isActive: () => true },
    llm: { chat: async () => ({}), chatStream: async function* () {} },
    tools: {
      async execute(toolName, args) {
        executions.push({ name: toolName, args });
        const error = new Error("tool arguments must be an object");
        error.code = "INVALID_ARGUMENTS";
        error.details = {
          receivedType: Array.isArray(args) ? "array" : typeof args,
        };
        throw error;
      },
      getIdentity: () => ({}),
      getSchemas: () => [],
    },
    browserContext: { readSelectedText: async () => "", getTab: async () => null },
    sessionPolicy: { canManageSessions: async () => true },
  });
  agent._currentRunId = "argument-run";
  agent.subscribe(event => events.push(event));

  await agent._executeToolCalls([{
    id: `call-${name}`,
    type: "function",
    function: { name, arguments: argsText },
  }], new AbortController().signal);

  return {
    executions,
    end: events.find(event => event.type === "tool_execution_end"),
  };
}
