import { loadModelsDevFixture } from "../support/models-dev-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createLlmGateway } from "../../src/background/llm/index.js";
import { getProviderDef } from "../../src/background/llm/provider-catalog.js";
import { listProviderModels } from "../../src/background/llm/model-directory.js";
import catalog from "../../src/capabilities/models/presets.js";
import policies from "../../src/capabilities/provider-policies/presets.js";

await loadModelsDevFixture();

test("behavior-only capabilities inherit the SDK model directory without a custom discovery implementation", async t => {
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Offline catalog fixture"); });
  for (const id of Object.keys(policies)) {
    const definition = getProviderDef(id);
    assert.equal(definition.listModels, catalog[id].listModels, `${id} keeps the SDK discovery handler`);
    assert.equal(definition.staticModelCount, catalog[id].staticModelCount, `${id} keeps the same offline model data`);
    const result = await listProviderModels(id, definition, "");
    assert.ok(result.models.length > 0, `${id} can list models without credentials or network`);
  }
  assert.equal(network.mock.callCount(), 0);
  assert.ok(getProviderDef("openaicodex").auth, "the complete Codex capability retains its own authentication");
  assert.equal(catalog.openaicodex, undefined, "Codex supplies a complete provider independently of the SDK directory");
});

const messages = [{ role: "system", content: "Follow the task." }, { role: "user", content: "Hello" }];
const tool = { type: "function", function: { name: "echo", description: "Echo text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } };
const sse = events => new Response(events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

function capture(t, respond) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

function openaiResponse({ body }, content = "answer") {
  const result = { content };
  return body.stream
    ? sse([{ choices: [{ delta: result, finish_reason: "stop" }] }, "[DONE]"])
    : Response.json({ choices: [{ message: { role: "assistant", ...result }, finish_reason: "stop" }] });
}

function anthropicResponse({ body }) {
  const blocks = [{ type: "thinking", thinking: "reasoning", signature: "signed-reasoning" }, { type: "text", text: "answer" }];
  return body.stream ? sse([
    { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
    ...blocks.flatMap((block, index) => [
      { type: "content_block_start", index, content_block: block }, { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]) : Response.json({ content: blocks, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
}

async function invoke(mode, provider, modelParameters = {}, conversation = messages) {
  const gateway = createLlmGateway({ rateGovernor: null });
  const options = { config: { provider, apiKey: "fixture-key", model: "fixture-model", modelParameters }, sessionId: "policy-session", rateLimit: false, retry: { maxRetries: 0 } };
  if (mode === "chat") return (await gateway.chat(conversation, [tool], undefined, options)).message;
  const events = await Array.fromAsync(gateway.chatStream(conversation, [tool], undefined, options));
  assert.equal(events.filter(event => event.type === "done").length, 1);
  return events.at(-1).message;
}

for (const mode of ["chat", "chatStream"]) {
  test(`${mode}: OpenCode policies preserve routing headers and split think tags only for opted-in providers`, async t => {
    const content = "<think>reasoning</think>answer";
    const requests = capture(t, request => openaiResponse(request, content));
    for (const provider of ["opencodego", "opencodezen", "deepseek"]) {
      const response = await invoke(mode, provider);
      assert.equal(response.content, provider === "deepseek" ? content : "answer");
      assert.equal(response._thinking, provider === "deepseek" ? undefined : "reasoning");
    }
    assert.equal(requests[0].url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(requests[0].headers.get("x-opencode-session"), "policy-session");
    assert.equal(requests[0].headers.get("user-agent"), "qz-agent/1.0.0");
    assert.equal(requests[0].headers.get("authorization"), "Bearer fixture-key");
    for (const request of requests.slice(1)) {
      assert.equal(request.headers.get("x-opencode-session"), null);
      assert.equal(request.headers.get("user-agent"), null);
    }
  });

  test(`${mode}: Fireworks retains session affinity while DeepSeek defaults yield to explicit model parameters`, async t => {
    const requests = capture(t, openaiResponse);
    await invoke(mode, "fireworks");
    assert.equal(requests[0].headers.get("x-session-affinity"), "qz-policy-session");
    await invoke(mode, "deepseek");
    assert.deepEqual(requests[1].body.thinking, { type: "enabled" });
    assert.equal(requests[1].body.reasoning_effort, "high");
    assert.equal(requests[1].headers.get("x-session-affinity"), null);
    await invoke(mode, "deepseek", { thinking: { type: "disabled" }, reasoning_effort: "low" });
    assert.deepEqual(requests[2].body.thinking, { type: "disabled" });
    assert.equal(requests[2].body.reasoning_effort, "low");
  });

  test(`${mode}: Kimi retains Anthropic authentication, tool schema and signed thinking across follow-ups`, async t => {
    const requests = capture(t, anthropicResponse);
    const response = await invoke(mode, "kimicode");
    assert.equal(response.content, "answer");
    assert.equal(response._thinking, "reasoning");
    const request = requests[0];
    assert.equal(request.url, "https://api.kimi.com/coding/v1/messages");
    assert.equal(request.headers.get("x-api-key"), "fixture-key");
    assert.equal(request.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(request.headers.get("user-agent"), "qz-agent/1.0.0");
    assert.equal(request.headers.get("authorization"), null);
    assert.deepEqual(request.body.thinking, { type: "enabled", budget_tokens: 1024 });
    assert.deepEqual(request.body.system, [{ type: "text", text: "Follow the task." }]);
    assert.deepEqual(request.body.tools[0], { name: "echo", description: "Echo text", input_schema: tool.function.parameters });
    await invoke(mode, "kimicode", { thinking: { type: "disabled" } }, [...messages, response, { role: "user", content: "Continue" }]);
    assert.deepEqual(requests[1].body.thinking, { type: "disabled" });
    const assistant = requests[1].body.messages.find(message => message.role === "assistant");
    assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "reasoning", signature: "signed-reasoning" });
  });
}
