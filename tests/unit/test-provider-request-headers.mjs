import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmGateway } from '../../src/background/llm/index.js';

const modes = ['chat', 'chatStream'];
const config = provider => Object.freeze({
  provider, apiKey: 'fixture-key', model: 'fixture-model',
  ...(provider === 'custom' ? { customProtocol: 'openai', customEndpoint: 'https://custom.test/v1' } : {}),
});
const noRetry = Object.freeze({ maxRetries: 0 });
const messages = text => [{ role: 'user', content: text }];
const gateway = () => createLlmGateway({ rateGovernor: null });

function success(body) {
  const usage = { prompt_tokens: 2, completion_tokens: 1 };
  return body.stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })
    : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage });
}

function captureFetch(t, respond = request => success(request.body)) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body), signal: init.signal };
    requests.push(request);
    return respond(request, requests.length);
  });
  return requests;
}

async function invoke(client, mode, text, options, signal) {
  if (mode === 'chat') {
    const result = await client.chat(messages(text), [], signal, options);
    assert.equal(result.message.content, 'ok');
    return result;
  }
  const events = await Array.fromAsync(client.chatStream(messages(text), [], signal, options));
  assert.equal(events.filter(event => event.type === 'done').length, 1);
  assert.equal(events.at(-1).message.content, 'ok');
  return events;
}

for (const mode of modes) {
  test(`OpenCode Go ${mode} keeps session routing across runs and request purposes without mutating callers`, async t => {
    const requests = captureFetch(t);
    const client = gateway();
    const requestConfig = Object.freeze({ ...config('opencodego'), modelParameters: Object.freeze({ temperature: 0.3 }) });
    const purposes = ['agent', 'followup', 'compact', 'ask_llm'];
    for (const [index, purpose] of purposes.entries()) {
      const options = Object.freeze({
        config: requestConfig, sessionId: ' session-root ', runId: `run-${index}`,
        rateLimit: false, retry: noRetry,
      });
      const before = structuredClone(options);
      await invoke(client, mode, purpose, options);
      assert.deepEqual(options, before, 'gateway and adapter leave caller-owned values intact');
    }
    assert.equal(requests.length, purposes.length);
    for (const request of requests) {
      assert.equal(request.url, 'https://opencode.ai/zen/go/v1/chat/completions');
      assert.equal(request.headers.get('x-opencode-session'), 'session-root');
      assert.equal(request.headers.get('user-agent'), 'qz-agent/1.0.0');
      assert.equal(request.headers.get('x-session-affinity'), null);
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
      assert.equal(request.body.model, 'fixture-model');
      assert.equal(request.body.temperature, 0.3);
    }
    const productConfig = Object.freeze({
      ...requestConfig, endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
      providerHeaders: Object.freeze({ 'X-OpenCode-Session': 'stale-session', 'x-fixture': 'product-header' }),
    });
    const resolvedClient = createLlmGateway({ rateGovernor: null, resolveConfig: async () => productConfig });
    await invoke(resolvedClient, mode, 'product-resolved request', {
      sessionId: 'session-root', rateLimit: false, retry: noRetry,
    });
    assert.equal(requests.at(-1).headers.get('x-opencode-session'), 'session-root', 'product headers cannot replace session routing');
    assert.equal(requests.at(-1).headers.get('x-fixture'), 'product-header', 'unrelated product headers remain available');
    assert.equal(productConfig.providerHeaders['X-OpenCode-Session'], 'stale-session');
  });

  test(`OpenCode Go ${mode} isolates concurrent parent and child sessions`, async t => {
    const allStarted = Promise.withResolvers();
    const identities = ['parent', 'child-a', 'child-b'];
    const requests = captureFetch(t, async (request, count) => {
      if (count === identities.length) allStarted.resolve();
      await allStarted.promise;
      return success(request.body);
    });
    const client = gateway();
    await Promise.all(identities.map(sessionId => invoke(client, mode, sessionId, {
      config: config('opencodego'), sessionId, runId: 'same-run-label', rateLimit: false, retry: noRetry,
    })));
    assert.equal(requests.length, identities.length);
    for (const request of requests) {
      assert.equal(request.headers.get('x-opencode-session'), request.body.messages[0].content);
    }
    assert.equal(new Set(requests.map(request => request.headers.get('x-opencode-session'))).size, identities.length);
  });

  test(`OpenCode Go ${mode} gives anonymous calls separate routing identities but preserves each through retries`, async t => {
    const attempts = new Map();
    const requests = captureFetch(t, request => {
      const text = request.body.messages[0].content;
      const count = (attempts.get(text) || 0) + 1;
      attempts.set(text, count);
      return count === 1
        ? Response.json({ error: { code: 'service_unavailable', message: 'Try again' } }, { status: 503 })
        : success(request.body);
    });
    const client = gateway();
    const retryEvents = [];
    for (const [index, sessionId] of [undefined, ' \r\n '].entries()) {
      await invoke(client, mode, `anonymous-${index}`, {
        config: config('opencodego'), sessionId, rateLimit: false,
        retry: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
        onRetry: event => retryEvents.push(event),
      });
    }
    assert.equal(requests.length, 4);
    assert.equal(retryEvents.length, 2);
    const ids = requests.map(request => request.headers.get('x-opencode-session'));
    assert.ok(ids.every(id => typeof id === 'string' && id.length > 0));
    assert.equal(ids[0], ids[1], 'first logical call keeps its routing identity on retry');
    assert.equal(ids[2], ids[3], 'second logical call keeps its routing identity on retry');
    assert.notEqual(ids[0], ids[2], 'anonymous calls do not share a process-wide fallback');
  });

  test(`OpenCode Go ${mode} safely encodes Unicode and embedded header delimiters`, async t => {
    const requests = captureFetch(t);
    const sessionId = ' 会话/子任务\r\nx-forged: injected ';
    await invoke(gateway(), mode, 'hello', {
      config: config('opencodego'), sessionId, rateLimit: false, retry: noRetry,
    });
    assert.equal(requests[0].headers.get('x-opencode-session'), encodeURIComponent(sessionId.trim()));
    assert.equal(requests[0].headers.get('x-forged'), null);
  });

  test(`OpenCode Go ${mode} preserves cancellation and can continue the same session afterwards`, async t => {
    const started = Promise.withResolvers();
    const requests = captureFetch(t, (request, count) => {
      if (count > 1) return success(request.body);
      started.resolve(request);
      return new Promise((resolve, reject) => {
        const abort = () => reject(request.signal.reason);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    });
    const client = gateway();
    const controller = new AbortController();
    const options = { config: config('opencodego'), sessionId: 'cancel-and-followup', rateLimit: false, retry: noRetry };
    const pending = invoke(client, mode, 'cancel me', options, controller.signal);
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise;
    controller.abort(new DOMException('Cancelled by test', 'AbortError'));
    await rejected;
    assert.equal(requests.length, 1, 'cancellation does not replay the request');
    await invoke(client, mode, 'continue', { ...options, runId: 'next-run' });
    assert.deepEqual(requests.map(request => request.headers.get('x-opencode-session')), ['cancel-and-followup', 'cancel-and-followup']);
  });

  test(`${mode} does not leak Go headers when switching to Zen, DeepSeek or a custom endpoint`, async t => {
    const requests = captureFetch(t);
    const client = gateway();
    for (const provider of ['opencodego', 'opencodezen', 'deepseek', 'custom']) {
      await invoke(client, mode, provider, {
        config: config(provider), sessionId: 'same-session', rateLimit: false, retry: noRetry,
      });
    }
    assert.equal(requests[0].headers.get('x-opencode-session'), 'same-session');
    assert.equal(requests[1].url, 'https://opencode.ai/zen/v1/chat/completions');
    for (const request of requests.slice(1)) {
      assert.equal(request.headers.get('x-opencode-session'), null);
      assert.equal(request.headers.get('user-agent'), null);
      assert.equal(request.headers.get('x-session-affinity'), null);
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
    }
  });

  test(`Fireworks ${mode} retains its existing affinity contract`, async t => {
    const requests = captureFetch(t);
    const client = gateway();
    for (const sessionId of ['fireworks-session', undefined, undefined]) {
      await invoke(client, mode, 'hello', {
        config: config('fireworks'), sessionId, rateLimit: false, retry: noRetry,
      });
    }
    assert.equal(requests[0].headers.get('x-session-affinity'), 'qz-fireworks-session');
    assert.match(requests[1].headers.get('x-session-affinity'), /^qz-/);
    assert.equal(requests[1].headers.get('x-session-affinity'), requests[2].headers.get('x-session-affinity'));
    for (const request of requests) {
      assert.equal(request.headers.get('x-opencode-session'), null);
      assert.equal(request.headers.get('user-agent'), null);
    }
  });
}
