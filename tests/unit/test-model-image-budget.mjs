import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareModelImages, assertModelRequestSize } from '../../src/background/llm/image-budget.js';
import { MODEL_IMAGE_MAX_BYTES, MODEL_REQUEST_MAX_BYTES } from '../../src/shared/images/policy.js';
import { normalizeLlmFailure } from '../../src/background/llm/provider-errors.js';

const image = url => ({ type: 'image_url', image_url: { url, detail: 'high' } });
const user = (...parts) => ({ role: 'user', content: parts });
const normalizer = async url => ({ dataUrl: `${url}-normalized`, bytes: 2 * 1024 * 1024 });

test('normalization preserves every image and never changes stored messages', async () => {
  const messages = Array.from({ length: 12 }, (_, i) => user(image(`data:image/png;base64,${i}`)));
  const before = structuredClone(messages);
  const result = await prepareModelImages(messages, undefined, normalizer);
  assert.deepEqual(messages, before);
  assert.equal(result.flatMap(m => m.content).filter(p => p.type === 'image_url').length, 12);
  assert.match(result.at(-1).content[0].image_url.url, /11-normalized$/);
  assert.equal(result.at(-1).content[0].image_url.detail, 'high');
  const text = [{ role: 'user', content: 'hello' }];
  assert.equal(await prepareModelImages(text), text, 'text-only traffic retains its fast path');
});

test('aggregate overflow fails once as invalid_request without dropping images or reaching an adapter', async () => {
  const count = MODEL_IMAGE_MAX_BYTES / (2 * 1024 * 1024) + 1;
  for (const messages of [[user(...Array.from({ length: count }, (_, i) => image(`data:${i}`)))],
    Array.from({ length: count }, (_, i) => user(image(`data:${i}`)))]) {
    await assert.rejects(prepareModelImages(messages, undefined, normalizer), error => {
      assert.equal(error.code, 'MODEL_IMAGES_TOO_LARGE');
      assert.equal(normalizeLlmFailure(error).kind, 'invalid_request');
      assert.equal(error.retryable, false);
      return true;
    });
  }
});

test('remote images cannot bypass the image policy or trigger an unchecked fetch', async () => {
  await assert.rejects(prepareModelImages([user(image('https://example.test/huge.png'))]), { code: 'MODEL_IMAGE_NOT_LOADED' });
});

test('duplicates reuse normalization and aborted preparation never invokes a decoder', async () => {
  let calls = 0;
  const normalize = async url => { calls++; return normalizer(url); };
  await prepareModelImages([user(image('data:same'), image('data:same'))], undefined, normalize);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareModelImages([user(image('data:same'))], controller.signal, normalize), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('final model body uses UTF-8 bytes and rejects before networking/retry', () => {
  assert.doesNotThrow(() => assertModelRequestSize('x'.repeat(MODEL_REQUEST_MAX_BYTES)));
  assert.throws(() => assertModelRequestSize('中'.repeat(Math.ceil(MODEL_REQUEST_MAX_BYTES / 3))), { code: 'MODEL_REQUEST_TOO_LARGE', kind: 'invalid_request' });
  assert.throws(() => assertModelRequestSize(new Blob([new Uint8Array(MODEL_REQUEST_MAX_BYTES + 1)])), { code: 'MODEL_REQUEST_TOO_LARGE' });
});
