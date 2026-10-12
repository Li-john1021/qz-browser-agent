import { createTestAgentServices } from "../support/agent-services.mjs";
import assert from "node:assert/strict";
import { serializeConversation } from "../../src/shared/session/session-codec.js";

globalThis.chrome = {
  debugger: {
    onDetach: { addListener() {} },
    onEvent: { addListener() {} },
  },
  runtime: { getURL: path => path },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};

const { Agent } = await import("../../src/background/agent/agent.js?interrupted-turn-recovery");
const {
  clearTraceLog,
  getTraceLog,
  setTraceDebugMode,
  trace,
} = await import("../../src/background/trace.js");

await danglingUserTurnIsSettledBeforeTheNextPrompt();
await completedTurnIsNotModified();
await transientInitialPersistenceRetriesBeforeAccepting();
await failedInitialPersistenceRejectsTheMessageAtomically();
await acceptedSideEffectDoesNotDelayRun();
await anonymousFollowUpRollbackIsExact();
await directSteeringRollsBackOnPersistenceFailure();
await activeRunWaitsForSteeringPersistence();

console.log("agent interrupted turn recovery tests passed");

async function danglingUserTurnIsSettledBeforeTheNextPrompt() {
  const repository = createConversationRepository(serializeConversation([
    { role: "user", content: "old long-running request", _origin: "user" },
  ]));
  const agent = createAgent("interrupted-user", repository);
  await agent.hydrateFromStore();

  let atRunStart = null;
  agent._runWithLifecycle = async () => {
    atRunStart = agent.messages.map(message => ({ ...message }));
  };
  await agent.prompt("new request", null, [], "new-message");

  const visible = atRunStart.filter(message => message.role !== "system");
  assert.deepEqual(visible.map(message => message.role), ["user", "assistant", "user"]);
  assert.equal(visible[1]._kind, "interrupted");
  assert.match(visible[1].content, /上一轮运行中断/);
  assert.equal(visible[2].content, "new request");

  const persisted = repository.lastWrite();
  assert.ok(persisted, "the repaired turn must be durable before the new run starts");
}

async function completedTurnIsNotModified() {
  const repository = createConversationRepository(serializeConversation([
    { role: "user", content: "old request", _origin: "user" },
    { role: "assistant", content: "old response" },
  ]));
  const agent = createAgent("completed-turn", repository);
  await agent.hydrateFromStore();

  let atRunStart = null;
  agent._runWithLifecycle = async () => {
    atRunStart = agent.messages.map(message => ({ ...message }));
  };
  await agent.prompt("next request");

  const visible = atRunStart.filter(message => message.role !== "system");
  assert.deepEqual(visible.map(message => message.role), ["user", "assistant", "user"]);
  assert.equal(visible.filter(message => message._kind === "interrupted").length, 0);
  assert.equal(visible.at(-1).content, "next request");
}

async function failedInitialPersistenceRejectsTheMessageAtomically() {
  const repository = createConversationRepository(null);
  let attempts = 0;
  repository.writeActiveConversation = async () => {
    attempts += 1;
    throw new Error("storage unavailable");
  };
  const agent = createAgent("failed-persist", repository);
  let accepted = false;
  let started = false;
  agent._runWithLifecycle = async () => { started = true; };

  await assert.rejects(
    agent.prompt("retry me", null, [], "retry-message", [], () => { accepted = true; }),
    error => error.code === "SESSION_PERSIST_FAILED",
  );
  assert.equal(accepted, false);
  assert.equal(started, false);
  assert.equal(attempts, 2, "initial acceptance should retry the same conversation snapshot exactly once");
  assert.deepEqual(
    agent.messages.filter(message => message.role !== "system"),
    [],
    "failed acceptance must roll back the entire new-message projection",
  );
}

async function transientInitialPersistenceRetriesBeforeAccepting() {
  await clearTraceLog();
  setTraceDebugMode(true);
  const repository = createConversationRepository(null);
  const write = repository.writeActiveConversation;
  let attempts = 0;
  const snapshots = [];
  repository.writeActiveConversation = async (...args) => {
    attempts += 1;
    snapshots.push(structuredClone(args[1]));
    if (attempts === 1) throw new Error("temporary storage failure");
    return write(...args);
  };
  const agent = createAgent("transient-persist", repository);
  let accepted = 0;
  let started = 0;
  agent._runWithLifecycle = async () => { started += 1; };

  await agent.prompt("persist once", null, [], "stable-message-id", [], () => { accepted += 1; });

  assert.equal(attempts, 2);
  assert.deepEqual(snapshots[1], snapshots[0], "the retry must write the exact same conversation snapshot");
  assert.equal(accepted, 1);
  assert.equal(started, 1);
  assert.equal(
    agent.messages.filter(message => message.role === "user" && message.clientMessageId === "stable-message-id").length,
    1,
  );
  assert.ok(repository.lastWrite(), "the accepted message must be durable before its run starts");
  const deliveryTrace = (await getTraceLog()).filter(line => line.includes("message_delivery_trace"));
  assert.deepEqual(
    deliveryTrace.map(line => line.match(/ phase=([^ ]+)/)?.[1]).filter(Boolean),
    [
      "agent.received",
      "conversation.persist_started",
      "conversation.persist_failed",
      "conversation.persist_started",
      "conversation.persisted",
      "agent.accepted",
    ],
  );
  assert.equal(deliveryTrace.every(line => line.includes("message=stable-message-id")), true);
  assert.equal(deliveryTrace.some(line => line.includes("persist_once")), false);
  setTraceDebugMode(false);
  await clearTraceLog();
}

async function acceptedSideEffectDoesNotDelayRun() {
  const agent = createAgent("accepted-boundary", createConversationRepository(null));
  let accepted = false;
  let started = false;
  agent._runWithLifecycle = async () => { started = true; };
  await agent.prompt(
    "durable side effect",
    null,
    [],
    "accepted-message",
    [],
    () => {
      accepted = true;
      return new Promise(() => {});
    },
  );
  assert.equal(accepted, true);
  assert.equal(started, true);
}

async function anonymousFollowUpRollbackIsExact() {
  const agent = createAgent("anonymous-follow-up", createConversationRepository(null));
  agent._scheduleNextFollowUpRun = () => {};
  let rejectFirst;
  const first = agent.followUp("first", [], "", [], () => new Promise((_, reject) => {
    rejectFirst = reject;
  }));
  await waitFor(() => typeof rejectFirst === "function");
  await agent.followUp("second", [], "", [], async () => {});
  rejectFirst(new Error("runtime write failed"));
  await assert.rejects(first, /runtime write failed/);
  assert.deepEqual(
    agent.getPendingFollowUps().map(message => message.text),
    ["second"],
    "an anonymous failure must remove its own message rather than a concurrent follow-up",
  );
}

async function directSteeringRollsBackOnPersistenceFailure() {
  const agent = createAgent("direct-steer", createConversationRepository(null));
  agent._scheduleNextFollowUpRun = () => {};
  await agent.followUp("next run", [], "follow", [], async () => {});
  await agent.followUp("correct course", [], "steer", [], async () => {}, "steer");
  assert.deepEqual(agent.getPendingSteerings().map(message => message.text), ["correct course"]);
  await assert.rejects(agent.followUp("failed", [], "failed-steer", [], async () => {
    throw new Error("write failed");
  }, "steer"), /write failed/);
  assert.deepEqual(agent.getPendingSteerings().map(message => message.text), ["correct course"]);
  assert.deepEqual(agent.getPendingFollowUps().map(message => message.text), ["next run"]);
  assert.equal(agent._pendingQueueWrites.size, 0);
}

async function activeRunWaitsForSteeringPersistence() {
  const agent = createAgent("steering-write-boundary", createConversationRepository(null));
  let finishFirst;
  let rejectWrite;
  let requests = 0;
  agent._callLLM = async () => {
    requests++;
    if (requests === 1) await new Promise(resolve => { finishFirst = resolve; });
    return { role: "assistant", content: "done" };
  };
  const running = agent.prompt("initial", null, [], "initial");
  await waitFor(() => Boolean(finishFirst));
  const write = agent.followUp("uncommitted steer", [], "steer-fail", [], () => new Promise((_, reject) => {
    rejectWrite = reject;
  }), "steer");
  await waitFor(() => Boolean(rejectWrite));
  finishFirst();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requests, 1);
  rejectWrite(new Error("storage failed"));
  await assert.rejects(write, /storage failed/);
  await running;
  assert.equal(requests, 1);
  assert.equal(agent.messages.some(message => message.clientMessageId === "steer-fail"), false);
}

function createAgent(sessionId, repository) {
  const agent = new Agent(sessionId, {
    services: createTestAgentServices({ trace }),
    conversationRepository: repository,
    conversationLease: { sessionId, isActive: () => true },
    llm: { chat: async () => ({}), chatStream: async function* () {} },
    tools: { execute: async () => ({}), getIdentity: () => ({}), getSchemas: () => [] },
    browserContext: { readSelectedText: async () => "", getTab: async () => null },
    sessionPolicy: { canManageSessions: async () => true },
  });
  agent._refreshDynamicContextSnapshot = async () => null;
  return agent;
}

function createConversationRepository(initial) {
  let stored = initial;
  let lastWrite = null;
  return {
    readActiveConversation: async () => stored,
    async writeActiveConversation(_sessionId, conversation) {
      stored = structuredClone(conversation);
      lastWrite = stored;
    },
    async clearActiveConversation() {
      stored = null;
    },
    lastWrite: () => lastWrite,
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for accepted boundary");
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
