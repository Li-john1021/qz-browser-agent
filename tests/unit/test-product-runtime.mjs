import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductRuntime as createPublicRuntime } from '../../src/products/public/background/runtime.js';
import { createSidepanelTransport } from '../../src/background/transports/sidepanel.js';

const llm = { chat: async () => 'answer', chatStream: async function* () { yield { type: 'done' }; } };

test('public runtime preserves the gateway and has no private actions or startup side effects', async () => {
  const runtime = createPublicRuntime({ llm });
  assert.equal(runtime.llm, llm);
  assert.deepEqual(runtime.observers, []);
  await runtime.start();
  assert.equal(await runtime.dispatch({ type: 'unregistered_product_action' }, {}), null);
  assert.equal(runtime.removeSession('session'), undefined);
});

test('product actions preserve request correlation and unknown actions fall through to the shared API', async () => {
  const seen = [];
  const responses = [];
  const transport = createSidepanelTransport({
    system: { ready: async () => seen.push('ready') },
    product: { dispatch: async (message, context) => {
      if (message.type !== 'example_action') return null;
      assert.equal(context.sourceWindowId, 7);
      context.progress({ type: 'example_progress' });
      return { type: 'example_completed', payload: { value: message.value } };
    } },
    config: { get: async () => ({ provider: 'custom' }) },
  }, { getWindowId: () => 7 });
  const port = { postMessage: message => responses.push(message) };
  assert.equal(await transport.dispatch({ type: 'example_action', requestId: 'q1', value: 42 }, port), true);
  assert.deepEqual(responses, [{ type: 'example_progress' }, { type: 'example_completed', requestId: 'q1', value: 42 }]);
  assert.equal(await transport.dispatch({ type: 'get_config', requestId: 'q2' }, port), true);
  assert.equal(responses.at(-1).config.provider, 'custom');
  assert.equal(seen.length, 2);
});

