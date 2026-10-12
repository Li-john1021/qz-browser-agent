import { deterministicProvider } from "../fixtures/capabilities/example/deterministic-provider.js";
import assert from 'node:assert/strict';
import test from 'node:test';
import { BUILTIN_PROVIDER_ADAPTERS, createLlmGateway, createProviderRegistry } from '../../src/background/llm/index.js';

const data = value => `data: ${JSON.stringify(value)}\n\n`;
const sse = events => new Response(events.map(data).join(''), { headers: { 'content-type': 'text/event-stream' } });
const cfg = protocol => ({ provider: 'custom', customProtocol: protocol, customEndpoint: 'https://provider.test/api', endpoint: 'https://provider.test/api', apiKey: 'fixture', model: 'fixture-model' });
const options = { rateLimit: false, retry: { maxRetries: 0 } };

for (const protocol of ['openai', 'anthropic', 'openai-codex']) {
  test(`registered ${protocol} adapter satisfies the chat and stream result contract`, async () => {
    const originalFetch = globalThis.fetch;
    const originalChrome = globalThis.chrome;
    globalThis.chrome = { storage: { local: { get: async () => ({ openaiCodexAuth: { access: 'fixture-access', expires: Date.now() + 3600000, accountId: 'fixture-account' } }) } } };
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      if (protocol === 'openai') return body.stream
        ? sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }])
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
      if (protocol === 'anthropic') return body.stream ? sse([
        { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]) : Response.json({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } });
      return sse([
        { type: 'response.output_text.delta', output_index: 0, delta: 'ok' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }], status: 'completed' } },
        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 1 } } },
      ]);
    };
    try {
      const gateway = createLlmGateway({ rateGovernor: null, protocolRegistry: createProviderRegistry(BUILTIN_PROVIDER_ADAPTERS), resolveConfig: async () => cfg(protocol) });
      const signal = new AbortController().signal;
      const messages = [{ role: 'user', content: 'hello' }];
      const result = await gateway.chat(messages, [], signal, options);
      assert.equal(result.message.role, 'assistant');
      assert.equal(result.message.content, 'ok');
      assert.ok(result.usage);
      const events = await Array.fromAsync(gateway.chatStream(messages, [], signal, options));
      assert.equal(events.filter(event => event.type === 'done').length, 1);
      assert.equal(events.at(-1).message.content, 'ok');
      assert.ok(events.some(event => event.type === 'text_delta' && event.delta === 'ok'));
      assert.equal(requests.length, 2);
      assert.ok(requests.every(request => request.body.model === 'fixture-model'));
      assert.deepEqual(messages, [{ role: 'user', content: 'hello' }]);
    } finally { globalThis.fetch = originalFetch; if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome; }
  });
}

test('a native protocol is registered without changing gateway dispatch or endpoint shaping', async () => {
  const calls = [];
  const adapter = {
    async chat(...args) { calls.push(args); return { message: { role: 'assistant', content: 'native' } }; },
    async *chatStream(...args) { calls.push(args); yield { type: 'done', message: { role: 'assistant', content: 'native' } }; },
  };
  const registry = createProviderRegistry({ 'vendor-native': adapter });
  const gateway = createLlmGateway({ protocolRegistry: registry, rateGovernor: null });
  const messages = [{ role: 'user', content: 'hello' }];
  const signal = new AbortController().signal;
  const requestOptions = { config: cfg('vendor-native') };
  assert.equal((await gateway.chat(messages, [], signal, requestOptions)).message.content, 'native');
  await Array.fromAsync(gateway.chatStream(messages, [], signal, requestOptions));
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.equal(args[0], messages);
    assert.equal(args[2], signal);
    assert.equal(args[4].endpoint, 'https://provider.test/api');
    assert.equal(args[4].customProtocol, 'vendor-native');
  }
});

for (const mode of ['chat', 'chatStream']) {
  test(`${mode} preserves typed request policy, tracing and cancellation across a custom adapter`, async () => {
    const controller = new AbortController();
    const abortReason = new DOMException('cancelled request', 'AbortError');
    const dispatched = Promise.withResolvers();
    const onRetry = () => {};
    const request = {
      config: cfg('request-contract'), sessionId: 'session-a', runId: 'run-a', spanId: 'span-a',
      rateLimit: false, inputTokensEstimate: 42, maxTokens: 128,
      traceparent: '00-trace-span-01', baggage: 'task=example',
      retry: { maxRetries: 2, baseDelayMs: 1 }, onRetry,
    };
    const receive = (_messages, _tools, signal, forwarded, config) => {
      dispatched.resolve({ signal, forwarded, config });
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const gateway = createLlmGateway({
      protocolRegistry: createProviderRegistry({ 'request-contract': {
        chat: receive,
        async *chatStream(...args) { await receive(...args); },
      } }),
      rateLearning: { beginRequest() { assert.fail('explicit rateLimit=false bypasses admission'); } },
    });
    const task = mode === 'chat'
      ? gateway.chat([], [], controller.signal, request)
      : Array.fromAsync(gateway.chatStream([], [], controller.signal, request));
    const received = await Promise.race([
      dispatched.promise,
      task.then(() => assert.fail('request must reach the adapter before settling')),
    ]);
    assert.equal(received.signal, controller.signal);
    for (const key of ['sessionId', 'runId', 'spanId', 'rateLimit', 'inputTokensEstimate', 'maxTokens',
      'traceparent', 'baggage', 'retry', 'onRetry']) {
      assert.equal(received.forwarded[key], request[key], key);
    }
    assert.equal(received.config.customProtocol, 'request-contract');
    assert.equal(received.forwarded.providerDefinition.protocol, 'request-contract');
    controller.abort(abortReason);
    await assert.rejects(task, error => error.name === 'AbortError');
    assert.equal(request.config.customEndpoint, 'https://provider.test/api');
    assert.equal(request.providerDefinition, undefined, 'gateway injection does not mutate caller options');
  });
}

test('unknown protocols fail before rate admission and never fall back to OpenAI', async () => {
  let admissions = 0;
  const gateway = createLlmGateway({ rateLearning: { beginRequest: async () => { admissions++; } } });
  const run = () => gateway.chat([], [], undefined, { config: cfg('missing-native') });
  await assert.rejects(run(), error => error.code === 'LLM_UNSUPPORTED_PROTOCOL' && error.kind === 'invalid_request');
  await assert.rejects(Array.fromAsync(gateway.chatStream([], [], undefined, { config: cfg('missing-native') })), { code: 'LLM_UNSUPPORTED_PROTOCOL' });
  assert.equal(admissions, 0);
});

test('protocol registries reject duplicates and incomplete adapters, then freeze their snapshot', async () => {
  const adapter = { chat: async () => ({ message: { role: 'assistant', content: 'original' } }), async *chatStream() {} };
  assert.throws(() => createProviderRegistry({ openai: adapter, ' OpenAI ': adapter }), /Duplicate/);
  assert.throws(() => createProviderRegistry({ broken: { chat: adapter.chat } }), /chatStream/);
  const registry = createProviderRegistry({ native: adapter });
  adapter.chat = async () => ({ message: { role: 'assistant', content: 'mutated' } });
  assert.equal((await registry.get('native').chat()).message.content, 'original');
  assert.throws(() => registry.protocols.push('other'), TypeError);
});

test('custom protocol choices come from the actual gateway registry and exclude login-only adapters', () => {
  const gateway = createLlmGateway({ rateGovernor: null, protocolRegistry: createProviderRegistry({
    ...BUILTIN_PROVIDER_ADAPTERS,
    'vendor-native': deterministicProvider,
    'labelled-native': { ...deterministicProvider, label: 'Native service' },
  }) });
  assert.deepEqual(gateway.listCustomProtocols(), [
    { id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' },
    { id: 'vendor-native', label: 'vendor-native' }, { id: 'labelled-native', label: 'Native service' },
  ]);
  assert.throws(() => { gateway.listCustomProtocols()[0].id = 'changed'; }, TypeError);
});

test('the TypeScript example adapter runs through the gateway and propagates cancellation', async () => {
  const gateway = createLlmGateway({ rateGovernor: null, protocolRegistry: createProviderRegistry({ example: deterministicProvider }) });
  const messages = [{ role: 'user', content: 'hello' }];
  const options = { config: cfg('example') };
  assert.equal((await gateway.chat(messages, [], undefined, options)).message.content, 'Example: hello');
  const events = await Array.fromAsync(gateway.chatStream(messages, [], undefined, options));
  assert.deepEqual(events.map(event => event.type), ['text_delta', 'done']);
  assert.equal(events.at(-1).message.content, 'Example: hello');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gateway.chat(messages, [], controller.signal, options), { name: 'AbortError' });
  await assert.rejects(Array.fromAsync(gateway.chatStream(messages, [], controller.signal, options)), { name: 'AbortError' });
});
