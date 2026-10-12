import assert from 'node:assert/strict';
import test from 'node:test';
import { providers as modelsDevProviders } from '@opencode-ai/models/snapshot';
import { createProviderAuthRuntime } from '../../src/background/llm/provider-auth.js';
import { listProviderModels } from '../../src/background/llm/model-directory.js';
import { getProviderDef, getProviderEndpoint, listProviderSummaries } from '../../src/background/llm/provider-catalog.js';
import { normalizeConfig, getConfig, saveConfig } from '../../src/background/llm/config.js';
import { clearCodexAuth, getCodexAuthStatus, startCodexDeviceLogin, pollCodexDeviceLogin } from '../../src/capabilities/provider-codex/auth.js';
import { withLanguage } from '../../src/shared/i18n/index.js';

const definition = { label: 'Independent', api: 'local', protocol: 'local', requiresApiKey: false };

test('SDK provider names remain stable while interface labels and auth hints resolve in the requested language', () => {
  const provider = getProviderDef('alibabacoding');
  const auth = getProviderDef('openaicodex').auth;
  const chinese = withLanguage('zh-CN', () => listProviderSummaries());
  const english = withLanguage('en', () => listProviderSummaries());
  const summary = (items, id) => items.find(item => item.id === id);
  assert.equal(summary(chinese, 'custom').label, '自定义接口');
  assert.equal(summary(english, 'custom').label, 'Custom endpoint');
  assert.equal(summary(chinese, 'alibabacoding').label, modelsDevProviders['alibaba-token-plan-cn'].name);
  assert.equal(summary(english, 'alibabacoding').label, modelsDevProviders['alibaba-token-plan-cn'].name);
  assert.equal(summary(chinese, 'custom').group.label, '自定义');
  assert.equal(summary(english, 'custom').group.label, 'Custom');
  assert.equal(summary(chinese, 'alibabacoding').group.label, '所有服务商');
  assert.equal(summary(english, 'alibabacoding').group.label, 'All providers');
  assert.equal(summary(english, 'openaicodex').auth.hint, 'Sign in with your ChatGPT account to use Codex models.');
  assert.match(summary(chinese, 'openaicodex').auth.hint, /使用 ChatGPT/);
  assert.equal(summary(chinese, 'openaicodex').group.label, '所有服务商');
  assert.equal(summary(english, 'openaicodex').group.label, 'All providers');
  const policy = items => items.map(({ label, auth: metadata, group, ...facts }) => ({
    ...facts, group: group && { id: group.id, priority: group.priority },
  }));
  assert.deepEqual(policy(chinese), policy(english), 'language selection cannot change provider endpoints, model options or auth requirements');
  assert.equal(getProviderDef('alibabacoding'), provider);
  assert.equal(getProviderDef('openaicodex').auth, auth, 'auth executors retain stable identity');
  assert.equal(summary(chinese, 'custom').label, '自定义接口', 'already returned UI summaries remain ordinary language snapshots');
});

test('any trusted preset supplies authentication, model discovery and endpoint policy without provider-name branches', async () => {
  const calls = [];
  const runtime = createProviderAuthRuntime({ independent: { ...definition,
    auth: {
      label: 'Independent', legacyStatusKey: 'independentAuthStatus',
      async status() { return { loggedIn: false }; },
      async start(signal) { calls.push(['start', signal]); return { loginId: 'independent-login' }; },
      async poll(loginId, signal) { calls.push(['poll', loginId, signal]); return { status: 'complete', authStatus: { loggedIn: true } }; },
      async clear() { calls.push(['clear']); return { loggedIn: false }; },
    },
  } });
  const controller = new AbortController();
  assert.equal((await runtime.startProviderLogin('independent', controller.signal)).loginId, 'independent-login');
  assert.equal((await runtime.pollProviderLogin('independent', 'independent-login', controller.signal)).status, 'complete');
  assert.equal((await runtime.clearProviderAuth('independent')).loggedIn, false);
  assert.deepEqual(calls, [['start', controller.signal], ['poll', 'independent-login', controller.signal], ['clear']]);
  assert.deepEqual(JSON.parse(JSON.stringify(await runtime.getProviderAuthState())), { providerAuth: { independent: { loggedIn: false } }, independentAuthStatus: { loggedIn: false } });
  await assert.rejects(runtime.startProviderLogin('unknown'), /does not support/);
  controller.abort();
  await assert.rejects(runtime.startProviderLogin('independent', controller.signal), { name: 'AbortError' });
  assert.equal(calls.length, 3);

  const discovered = await listProviderModels('independent', { ...definition, listModels: async context => {
    assert.equal(context.provider, 'independent'); assert.equal(context.apiKey, 'synthetic');
    return { data: [{ id: 'second', label: 'Second' }, { id: 'first' }, { id: 'first' }] };
  } }, 'synthetic');
  assert.deepEqual(discovered.models.map(model => model.id), ['first', 'second']);
  assert.equal(getProviderEndpoint({ ...definition, endpoint: 'https://example.invalid', resolveEndpoint: preset => `${preset.endpoint}/local` }), 'https://example.invalid/local');
  await assert.rejects(listProviderModels('independent', { ...definition, listModels: async () => { throw new Error('discovery failed'); } }, ''), /discovery failed/);
  await assert.rejects(listProviderModels('independent', { ...definition, listModels: async () => [] }, '', controller.signal), { name: 'AbortError' });
});

test('authentication status failures remain scoped to one provider', async () => {
  const auth = { label: 'Independent', async start() {}, async poll() {}, async clear() {} };
  const runtime = createProviderAuthRuntime({
    good: { ...definition, auth: { ...auth, async status() { return { loggedIn: true }; } } },
    broken: { ...definition, auth: { ...auth, status() { throw new Error('offline'); } } },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await runtime.getProviderAuthState())), { providerAuth: {
    good: { loggedIn: true }, broken: { loggedIn: false, refreshError: 'offline' },
  } });
});

test('Codex device login preserves pending/slow-down, clears failures/cancel/logout and prevents stale token writes', async t => {
  const storage = {};
  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = { storage: { local: {
    get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value), remove: async key => { delete storage[key]; },
  } } };
  t.after(() => { globalThis.chrome = priorChrome; globalThis.fetch = priorFetch; });
  let mode = 'pending';
  let releaseExchange;
  const token = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.x`;
  globalThis.fetch = async (url, options) => {
    options.signal?.throwIfAborted();
    if (url.endsWith('/usercode')) return Response.json({ device_auth_id: 'device', user_code: 'TEST-CODE', interval: 1 });
    if (url.endsWith('/oauth/token')) return await new Promise(resolve => { releaseExchange = () => resolve(Response.json({ access_token: token, refresh_token: 'synthetic-refresh', expires_in: 3600 })); });
    if (mode === 'pending') return Response.json({ error: 'deviceauth_authorization_pending' }, { status: 403 });
    if (mode === 'slow') return Response.json({ error: 'slow_down' }, { status: 429 });
    if (mode === 'broken') return new Response('invalid JSON');
    if (mode === 'network') throw new Error('offline');
    return Response.json({ authorization_code: 'synthetic-code', code_verifier: 'synthetic-verifier' });
  };
  await clearCodexAuth();
  let login = await startCodexDeviceLogin();
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'pending');
  mode = 'slow';
  assert.deepEqual(await pollCodexDeviceLogin(login.loginId), { status: 'slow_down', intervalSeconds: 6 });
  mode = 'broken';
  await assert.rejects(pollCodexDeviceLogin(login.loginId), /non-JSON/);
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'expired');
  login = await startCodexDeviceLogin();
  mode = 'network';
  await assert.rejects(pollCodexDeviceLogin(login.loginId), /offline/);
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'expired');
  login = await startCodexDeviceLogin();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pollCodexDeviceLogin(login.loginId, controller.signal), { name: 'AbortError' });
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'expired');
  login = await startCodexDeviceLogin();
  mode = 'complete';
  const pending = pollCodexDeviceLogin(login.loginId);
  while (!releaseExchange) await new Promise(resolve => setImmediate(resolve));
  await clearCodexAuth(); releaseExchange();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(storage.openaiCodexAuth, undefined);
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'expired');
  login = await startCodexDeviceLogin();
  releaseExchange = null;
  const successful = pollCodexDeviceLogin(login.loginId);
  while (!releaseExchange) await new Promise(resolve => setImmediate(resolve));
  releaseExchange();
  assert.equal((await successful).status, 'complete');
  assert.equal(storage.openaiCodexAuth.access, token);
  assert.equal((await pollCodexDeviceLogin(login.loginId)).status, 'expired');
  storage.openaiCodexAuth.expires = Date.now() - 1000;
  releaseExchange = null;
  const refresh = getCodexAuthStatus();
  while (!releaseExchange) await new Promise(resolve => setImmediate(resolve));
  await clearCodexAuth(); releaseExchange();
  assert.equal((await refresh).loggedIn, false);
  assert.equal(storage.openaiCodexAuth, undefined, 'a late refresh cannot restore logged-out credentials');
});

test('legacy Codex saved options and auth status stay wire-compatible through declarative metadata', async t => {
  const storage = { llmConfig: { provider: 'openaicodex', model: 'gpt-5.6-sol', codexReasoningEffort: 'HIGH', contextWindow: 272000 } };
  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = { storage: { local: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } } };
  globalThis.fetch = async () => { throw new Error('unexpected network'); };
  t.after(() => { globalThis.chrome = priorChrome; globalThis.fetch = priorFetch; });
  const config = await getConfig();
  assert.equal(config.codexReasoningEffort, 'high');
  assert.deepEqual(config.codexAuthStatus, config.providerAuth.openaicodex);
  assert.equal(normalizeConfig({ ...config, codexReasoningEffort: 'unsupported' }).codexReasoningEffort, 'medium');
  for (const removed of ['none', 'minimal']) {
    storage.llmConfig.codexReasoningEffort = removed;
    assert.equal((await getConfig()).codexReasoningEffort, 'medium');
  }
  assert.equal(normalizeConfig({ provider: 'deepseek', codexReasoningEffort: 'high' }).codexReasoningEffort, '');
  const saved = await saveConfig({ ...config, codexReasoningEffort: 'max' });
  assert.equal(storage.llmConfig.codexReasoningEffort, 'max');
  assert.equal(saved.presets[0].codexReasoningEffort, 'max');
  const provider = listProviderSummaries().find(item => item.id === 'openaicodex');
  assert.equal(provider.requiresApiKey, false);
  assert.equal(typeof provider.auth.start, 'undefined', 'settings receives metadata, never executable authentication hooks');
});


test('Codex model discovery falls back on HTTP, malformed or filtered-empty results and propagates cancellation', async t => {
  const priorChrome = globalThis.chrome;
  const priorFetch = globalThis.fetch;
  globalThis.chrome = { storage: { local: { get: async () => ({ openaiCodexAuth: { access: 'synthetic', refresh: '', expires: Date.now() + 3600000, accountId: 'fixture' } }) } } };
  t.after(() => { globalThis.chrome = priorChrome; globalThis.fetch = priorFetch; });
  const definition = getProviderDef('openaicodex');
  for (const response of [new Response('unavailable', { status: 503 }), new Response('invalid'), Response.json({ models: [{ id: 'codex-auto-review' }] })]) {
    globalThis.fetch = async () => response;
    const result = await listProviderModels('openaicodex', definition, '');
    assert.equal(result.models[0].id, 'gpt-6-astra');
    assert.equal(result.models.length, 8);
  }
  const controller = new AbortController();
  globalThis.fetch = async (_url, { signal }) => { controller.abort(); signal.throwIfAborted(); };
  await assert.rejects(listProviderModels('openaicodex', definition, '', controller.signal), { name: 'AbortError' });
});


test('a hanging authentication status has a finite budget and cannot block other providers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let receivedSignal;
  const auth = { label: 'Fixture', async start() {}, async poll() {}, async clear() {} };
  const runtime = createProviderAuthRuntime(Object.fromEntries([
    ['healthy', { ...definition, auth: { ...auth, async status() { return { loggedIn: true }; } } }],
    ['__proto__', { ...definition, auth: { ...auth, legacyStatusKey: '__proto__', status(signal) { receivedSignal = signal; return new Promise(() => {}); } } }],
  ]));
  const pending = runtime.getProviderAuthState();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(receivedSignal.aborted, false);
  t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(receivedSignal.aborted, true);
  assert.equal(Object.getPrototypeOf(result.providerAuth), null);
  assert.equal(result.providerAuth.healthy.loggedIn, true);
  assert.equal(result.providerAuth.__proto__.loggedIn, false);
  assert.match(result.providerAuth.__proto__.refreshError, /timed out/);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
});

test('login operations reject late success when an adapter ignores cancellation', async () => {
  for (const operation of ['startProviderLogin', 'pollProviderLogin']) {
    let complete;
    const ignoredCancellation = () => new Promise(resolve => { complete = resolve; });
    const runtime = createProviderAuthRuntime({ independent: { ...definition, auth: {
      label: 'Fixture', async status() { return { loggedIn: false }; }, start: ignoredCancellation, poll: ignoredCancellation, async clear() {},
    } } });
    const controller = new AbortController();
    const pending = operation === 'startProviderLogin'
      ? runtime.startProviderLogin('independent', controller.signal)
      : runtime.pollProviderLogin('independent', 'login', controller.signal);
    controller.abort(); complete({ status: 'complete' });
    await assert.rejects(pending, { name: 'AbortError' });
  }
});
