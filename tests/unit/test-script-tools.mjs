import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { compileScriptRuntime } from '../support/script-runtime-fixture.mjs';
import { createScriptTools } from '../../src/capabilities/script/tools.js';
import { ToolExecutionError } from '../../src/background/tools/arguments.js';

const originalChrome = globalThis.chrome;
const originalRuntimeSource = globalThis.SCRIPT_RUNTIME_SOURCE;
before(async () => {
  globalThis.SCRIPT_RUNTIME_SOURCE = await compileScriptRuntime();
  globalThis.chrome = { storage: { local: { async get() { return {}; } } } };
});
after(() => {
  if (originalChrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = originalChrome;
  if (originalRuntimeSource === undefined) delete globalThis.SCRIPT_RUNTIME_SOURCE;
  else globalThis.SCRIPT_RUNTIME_SOURCE = originalRuntimeSource;
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(evaluateCdpScript) {
  const definitions = new Map();
  createScriptTools({ registerTool: definition => definitions.set(definition.name, definition), ToolExecutionError,
    skills: { loadScript: async () => null }, scriptTimeoutProperty: { type: 'number' }, evaluateCdpScript });
  const run = definitions.get('run_script').execute;
  return (tabId = 7, signal, context = {}) => run({ code: '42', timeout: 5, tabId }, signal, { sessionId: 'task', runId: 'run', ...context });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('page results preserve large structured values and diagnostic envelopes', async () => {
  const value = { text: 'large'.repeat(20000), rows: Array.from({ length: 1200 }, (_, id) => ({ id })) };
  assert.equal((await fixture(async () => ({ result: { type: 'object', value } }))()).result, value);
  const run = fixture(async () => ({ result: { type: 'object', value: { __runScriptEnvelope: true, ok: false,
    error: 'querySelector returned null', trace: [{ message: 'selected 0' }], __lastObservation: { _image: 'data:image/png;base64,eA==' } } } }));
  const result = await run();
  assert.equal(result.diagnostic.category, 'selector_or_timing');
  assert.deepEqual(result.diagnostic.lastTrace, ['trace: selected 0']);
  assert.equal(result._image, 'data:image/png;base64,eA==');
  assert.equal(result.__runScriptEnvelope, undefined);
});

test('same tab serializes, other tabs proceed, cancellation releases queued work', async () => {
  const first = deferred(); const calls = [];
  const run = fixture(async tabId => { calls.push(tabId); if (calls.length === 1) await first.promise; return { result: { type: 'number', value: tabId } }; });
  const a = run(); await tick();
  const controller = new AbortController();
  const b = run(7, controller.signal);
  const rejected = assert.rejects(b, { code: 'OPERATION_ABORTED' });
  const c = run(7); const independent = run(9);
  await tick(); assert.deepEqual(calls, [7, 9]);
  controller.abort(); await rejected;
  first.resolve(); await Promise.all([a, c, independent]);
  assert.deepEqual(calls, [7, 9, 7]);
  await run(); assert.deepEqual(calls, [7, 9, 7, 7]);
});

test('nested run bypasses its own page queue and propagates abort failure', async () => {
  const first = deferred(); let calls = 0;
  const run = fixture(async () => { if (++calls === 1) await first.promise; return { result: { type: 'number', value: calls } }; });
  const outer = run(); await tick();
  await run(7, undefined, { runScriptToolDepth: 1 });
  assert.equal(calls, 2); first.resolve(); await outer;
  const fail = fixture(async () => { throw new ToolExecutionError('OPERATION_ABORTED', 'stopped'); });
  await assert.rejects(fail(), { code: 'OPERATION_ABORTED' });
});

test('cancelling the last queued request does not release its still-running predecessor', async () => {
  const first = deferred(); const calls = [];
  const run = fixture(async tabId => { calls.push(tabId); if (calls.length === 1) await first.promise; return { result: { type: 'undefined' } }; });
  const a = run(); await tick();
  const controller = new AbortController(); const b = run(7, controller.signal);
  const rejected = assert.rejects(b, { code: 'OPERATION_ABORTED' });
  await tick(); controller.abort(); await rejected;
  const c = run(); await tick(); assert.deepEqual(calls, [7]);
  first.resolve(); await Promise.all([a, c]); assert.deepEqual(calls, [7, 7]);
});
