import assert from 'node:assert/strict';
import test from 'node:test';
import { build, } from 'esbuild';
import { minify } from 'terser';
import { compileInnerWorker } from '../../scripts/build-extension.mjs';
import { runInnerWorker, sandboxFixture } from '../support/inner-runner-fixture.mjs';

for (const mode of ['development', 'production']) test(`${mode} Worker executes messages, tool results and cancellable fetch after compilation`, async () => {
  const source = await compileInnerWorker({ mode });
  const { result, events } = await runInnerWorker(source, `
    trace('Hello 轻舟 ✅');
    const response = await tools.lookup({ query: input.query, fn() {} });
    const fetched = await fetch('https://fixture.test/data', { headers: { Date: 'Fri, 17 Jul 2026 02:00:00 GMT', Authorization: 'signed' } });
    const controller = new AbortController();
    const cancellation = fetch('https://fixture.test/cancel', { signal: controller.signal }).catch(error => error.name);
    await tools.abortReady();
    controller.abort();
    return { response, body: await fetched.text(), cancelled: await cancellation, typed: new Uint8Array([1,2,3]), config: $plugin.value };
  `, {
    scriptArgs: { query: 'needle', $plugin: { value: 7 } }, fetchBridge: true,
    onMessage(message, respond) {
      if (message.type === 'tool_call') {
        if (message.toolName === 'lookup') {
          assert.equal(message.args.fn.__qz_uncloneable, 'function');
          assert.equal(message.args.query, 'needle');
        }
        respond({ type: 'tool_response', callId: message.callId, response: { ok: true, result: 'found', artifacts: [{ id: 'artifact' }] } });
      } else if (message.type === 'fetch_call' && message.request.url.endsWith('/data')) {
        assert.ok(message.request.headers.some(([name, value]) => name === 'date' && value.startsWith('Fri,')));
        respond({ type: 'fetch_response', callId: message.callId, response: { ok: true, result: { status: 200, bodyBase64: Buffer.from('数据').toString('base64') } } });
      }
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, { response: 'found', body: '数据', cancelled: 'AbortError', typed: { __qz_type: 'Uint8Array', length: 3, sample: [1,2,3] }, config: 7 });
  assert.equal(result.artifacts[0].id, 'artifact');
  assert.ok(result.trace.some(row => row.message === 'Hello 轻舟 ✅'));
  const cancelled = events.find(message => message.type === 'fetch_call' && message.request.url.endsWith('/cancel'));
  assert.equal(events.find(message => message.type === 'fetch_cancel').callId, cancelled.callId);
});

test('compiled Worker preserves errors, guards, syntax diagnostics and undefined results', async () => {
  const source = await compileInnerWorker({ mode: 'production' });
  const failed = await runInnerWorker(source, 'await tools.fail();', { onMessage(message, respond) {
    respond({ type: 'tool_response', callId: message.callId, response: { ok: false, code: 'TOOL_TEST_FAILURE', error: 'failed', details: { retry: false } } });
  } });
  assert.equal(failed.result.code, 'TOOL_TEST_FAILURE');
  assert.deepEqual(failed.result.details, { retry: false });
  const blocked = await runInnerWorker(source, 'await fetch("https://blocked.test/path");', { fetchBridge: true, securityGuardrails: { rules: [{ action: 'block', type: 'domain', value: 'blocked.test' }] } });
  assert.equal(blocked.result.code, 'SECURITY_GUARDRAIL_BLOCKED');
  assert.equal(blocked.events.some(message => message.type === 'fetch_call'), false);
  const syntax = await runInnerWorker(source, 'return "raw\nnewline";');
  assert.equal(syntax.result.code, 'SCRIPT_SYNTAX_ERROR');
  assert.ok(syntax.result.details.suspiciousTokens.some(hint => hint.name === 'raw_newline_in_string'));
  assert.equal(syntax.result.details.sourcePreview.includes('\n'), false);
  const empty = await runInnerWorker(source, 'await Promise.resolve();');
  assert.equal(empty.result.ok, true);
  assert.equal(empty.result.hasResult, false);
});

test('minified sandbox ignores foreign, cancelled and replaced Worker events', async () => {
  const workerSource = await compileInnerWorker({ mode: 'production' });
  const host = await build({ entryPoints: ['src/runner-sandbox.ts'], bundle: true, write: false, format: 'iife', define: { INNER_WORKER_SOURCE: JSON.stringify(workerSource) } });
  const minified = await minify(host.outputFiles[0].text, { ecma: 2020, compress: { passes: 2 }, mangle: true, format: { comments: false } });
  const fixture = sandboxFixture(minified.code);
  fixture.send({ type: 'execute', requestId: 'foreign' }, {});
  assert.equal(fixture.workers.length, 0);
  fixture.send({ type: 'execute', requestId: 'same', scriptSource: 'return 42;' });
  const old = fixture.workers[0];
  fixture.send({ type: 'execute', requestId: 'same', scriptSource: 'return 43;' });
  const active = fixture.workers[1];
  assert.equal(old.terminated, true);
  const before = fixture.messages.length;
  old.onmessage({ data: { type: 'result', result: { ok: true } } });
  old.onerror({ message: 'late' });
  assert.equal(fixture.messages.length, before);
  fixture.send({ type: 'tool_response', requestId: 'same', callId: 'call', response: { ok: true } });
  assert.equal(active.sent.at(-1).callId, 'call');
  const { result } = await runInnerWorker(active.source, active.sent[0].source);
  assert.equal(result.result, 43);
  fixture.send({ type: 'cancel', requestId: 'same' });
  active.onmessage({ data: { type: 'result', result } });
  assert.equal(fixture.messages.some(message => message.type === 'result'), false);
  assert.equal(active.terminated, true);
});
