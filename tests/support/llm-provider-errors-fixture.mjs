import test from 'node:test';
import { chatStreamOpenAi } from '../../src/capabilities/provider-openai/adapter.js';

const originalFetch = globalThis.fetch;

const codexStorage = {
  openaiCodexAuth: {
    access: "codex-test-access",
    refresh: "",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "codex-test-account",
  },
};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: codexStorage[key] };
        return {};
      },
      async set(values) {
        Object.assign(codexStorage, values);
      },
      async remove(key) {
        delete codexStorage[key];
      },
    },
  },
};

test.after(() => {
  globalThis.fetch = originalFetch;
});

export async function collectStream(events) {
  for await (const event of chatStreamOpenAi([], [], null, noRetryOptions(), config())) {
    events.push(event);
  }
}

export async function collect(stream) {
  for await (const _event of stream) {}
}

export function providerErrorEnvelope() {
  return {
    error: {
      code: "PROXY_014",
      message: "SSE data is not a valid LLM response: private tool arguments",
    },
  };
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export function sseResponse(payloads) {
  const body = payloads.map(payload => (
    `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
  )).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function rawSseResponse(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function noRetryOptions() {
  return { retry: { maxRetries: 0 } };
}

export function config() {
  return {
    provider: "custom",
    providerLabel: "Custom",
    customProtocol: "openai",
    customEndpoint: "https://llm.test/v1/chat/completions",
    endpoint: "https://llm.test/v1/chat/completions",
    apiKey: "test-key",
    model: "test-model",
  };
}

export function anthropicConfig() {
  return {
    provider: "custom",
    providerLabel: "Custom Anthropic",
    customProtocol: "anthropic",
    customEndpoint: "https://llm.test/v1/messages",
    endpoint: "https://llm.test/v1/messages",
    apiKey: "test-key",
    model: "test-model",
  };
}

export function codexConfig() {
  return {
    provider: "openaicodex",
    providerLabel: "OpenAI Codex",
    endpoint: "https://llm.test/codex/responses",
    model: "gpt-test",
  };
}
