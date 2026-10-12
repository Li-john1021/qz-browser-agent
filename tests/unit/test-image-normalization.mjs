import assert from 'node:assert/strict';
import { normalizeImage, readImageInput, readImageResponse } from '../../src/shared/images/normalize.js';
import { IMAGE_MAX_BYTES, IMAGE_INPUT_MAX_BYTES, assertImageDataUrl, inspectImageDataUrl } from '../../src/shared/images/policy.js';

const originalBitmap = globalThis.createImageBitmap;
const originalCanvas = globalThis.OffscreenCanvas;
let dimensions = [4096, 2048];
let closed = 0;
let encodes = 0;
let decoded = 0;
let encodeSize = canvas => canvas.width * canvas.height * 4;
globalThis.createImageBitmap = async () => {
  decoded++;
  return { width: dimensions[0], height: dimensions[1], close() { closed++; } };
};
globalThis.OffscreenCanvas = class {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return { drawImage() {} }; }
  async convertToBlob({ type }) { encodes++; return new Blob([new Uint8Array(encodeSize(this))], { type }); }
};

try {
  const image = await normalizeImage(new Blob(['pixels'], { type: 'image/png' }));
  assert.ok(image.width <= 2048 && image.height <= 2048);
  assert.ok(Math.abs(image.width - image.height * 2) <= 1, 'aspect ratio is preserved to pixel rounding');
  assert.ok(image.bytes <= IMAGE_MAX_BYTES);
  assert.equal(inspectImageDataUrl(image.dataUrl).bytes, image.bytes);
  assert.equal(closed, 1);
  assert.ok(encodes > 1, 'a high entropy image needs more than a dimension cap');

  dimensions = [12, 8];
  const png = 'data:image/png;base64,cGl4ZWxz';
  assert.equal((await normalizeImage(png)).dataUrl, png, 'compliant input keeps its bytes');
  const charsetPng = 'data:image/png;charset=utf-8;base64,cGl4ZWxz';
  assert.equal((await normalizeImage(charsetPng)).dataUrl, png, 'charset plus base64 input becomes canonical without changing its bytes');
  assert.deepEqual(inspectImageDataUrl(charsetPng), { mimeType: 'image/png', bytes: 6, dataUrlBytes: charsetPng.length });
  assert.equal((await normalizeImage('data:image/png;CHARSET=UTF-8;BASE64,cGl4ZWxz')).dataUrl, png);
  assert.equal((await normalizeImage('data:image/png;name=tiny;charset="UTF-8";base64,cGl4ZWxz')).dataUrl, png);
  assert.equal((await normalizeImage('data:image/png;charset=utf-8;name=tiny;base64,cGl4ZWxz')).dataUrl, png);
  const paddedPng = 'data:image/png;base64,cGl4ZWw=';
  for (const payload of ['cGl4ZWw', ' cGl4\tZWw=\r\n\f', '%63Gl4ZWw%3d', '%20cGl4%09ZWw%0a']) {
    const normalized = await normalizeImage(`data:image/png;charset=utf-8;base64,${payload}`);
    assert.equal(normalized.dataUrl, paddedPng, 'native data URL encodings produce canonical output with the same bytes');
    assert.equal(normalized.bytes, 5);
  }
  assert.equal((await normalizeImage('data:image/png;base64,%2f%2B4%3D')).dataUrl, 'data:image/png;base64,/+4=');
  for (const payload of ['a', 'cGl4ZWw===', 'cGl4$Ww=', '%GG', 'cGl4\u00a0ZWw=']) {
    await assert.rejects(normalizeImage(`data:image/png;base64,${payload}`), { code: 'INVALID_IMAGE_DATA' });
  }
  assert.throws(() => inspectImageDataUrl('data:image/png;charset=utf-8;base64,not base64'), { code: 'INVALID_IMAGE_DATA' });
  assert.equal((await normalizeImage('data:image/png,pixels')).dataUrl, png, 'legacy non-base64 data URLs become canonical base64');
  assert.equal((await normalizeImage(png, { format: 'jpeg' })).mimeType, 'image/jpeg', 'explicit encoding is respected');
  const gif = 'data:image/gif;base64,cGl4ZWxz';
  assert.equal((await normalizeImage(gif)).dataUrl, gif, 'small compliant GIF retains animation');
  dimensions = [4096, 2048];
  const flattened = await normalizeImage(gif);
  assert.equal(flattened.mimeType, 'image/png');
  assert.equal(flattened.animationFlattened, true);

  const bomb = new Uint8Array(24);
  bomb.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new DataView(bomb.buffer);
  header.setUint32(16, 65536); header.setUint32(20, 65536);
  const beforeDecode = decoded;
  await assert.rejects(normalizeImage(new Blob([bomb], { type: 'image/png' })), { code: 'IMAGE_DIMENSIONS_TOO_LARGE' });
  assert.equal(decoded, beforeDecode, 'reject hostile dimensions before decode');
  const webpBomb = new Uint8Array(30);
  const webpHeader = new DataView(webpBomb.buffer);
  webpHeader.setUint32(0, 0x52494646); webpHeader.setUint32(8, 0x57454250); webpHeader.setUint32(12, 0x56503858);
  webpBomb.fill(255, 24);
  await assert.rejects(normalizeImage(new Blob([webpBomb], { type: 'image/webp' })), { code: 'IMAGE_DIMENSIONS_TOO_LARGE' });
  assert.equal(decoded, beforeDecode, 'WebP dimensions are checked before allocation too');
  await assert.rejects(normalizeImage(new Blob([new Uint8Array(IMAGE_INPUT_MAX_BYTES + 1)], { type: 'image/png' })), { code: 'IMAGE_INPUT_TOO_LARGE' });
  assert.equal(decoded, beforeDecode, 'reject oversized input before decode');

  const originalFetch = globalThis.fetch;
  let inputFetches = 0;
  globalThis.fetch = async () => { inputFetches++; return new Response(new Blob([new Uint8Array(IMAGE_INPUT_MAX_BYTES + 1)], { type: 'image/png' })); };
  try {
    await assert.rejects(readImageInput('data:image/png;base64,' + 'A'.repeat(Math.ceil((IMAGE_INPUT_MAX_BYTES + 1) / 3) * 4)), { code: 'IMAGE_INPUT_TOO_LARGE' });
    await assert.rejects(readImageInput('data:image/png;base64,' + ' '.repeat(Math.ceil(IMAGE_INPUT_MAX_BYTES / 3) * 12 + 1)), { code: 'IMAGE_INPUT_TOO_LARGE' });
    assert.equal(inputFetches, 0, 'oversized encoded input is rejected before native decoding');
    await assert.rejects(normalizeImage('data:image/png;base64,cGl4ZWw'), { code: 'IMAGE_INPUT_TOO_LARGE' });
    assert.equal(inputFetches, 1);
    assert.equal(decoded, beforeDecode, 'native-decoded byte limit still runs before image decoding');
    const abort = new AbortController();
    globalThis.fetch = async () => { abort.abort(); throw abort.signal.reason; };
    await assert.rejects(normalizeImage('data:image/png;base64,cGl4ZWw', { signal: abort.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }

  globalThis.createImageBitmap = async () => { throw new Error('invalid raster'); };
  await assert.rejects(normalizeImage(png), { code: 'IMAGE_DECODE_FAILED', retryable: false, kind: 'invalid_request' });
  globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() { closed++; } });
  encodeSize = () => 100;
  await assert.rejects(normalizeImage(png, { maxBytes: 1 }), { code: 'IMAGE_ENCODE_FAILED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizeImage(png, { signal: controller.signal }), { name: 'AbortError' });
  assert.throws(() => assertImageDataUrl('data:image/png;base64,not base64'), { code: 'INVALID_IMAGE_DATA' });

  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(stream) { stream.enqueue(new Uint8Array(4)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/png' } });
  await assert.rejects(readImageResponse(response, { maxBytes: 8 }), { code: 'IMAGE_INPUT_TOO_LARGE' });
  assert.equal(cancelled, true, 'a download without Content-Length is cancelled as soon as it exceeds budget');

  let releaseDecode;
  let announceDecode;
  const decodingStarted = new Promise(resolve => { announceDecode = resolve; });
  let decodeCalls = 0;
  globalThis.createImageBitmap = async () => {
    decodeCalls++;
    if (decodeCalls === 1) { announceDecode(); await new Promise(resolve => { releaseDecode = resolve; }); }
    return { width: 2, height: 2, close() {} };
  };
  const first = normalizeImage(png);
  await decodingStarted;
  const queuedAbort = new AbortController();
  const abandoned = normalizeImage(png, { signal: queuedAbort.signal });
  const next = normalizeImage(png);
  queuedAbort.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  assert.equal(decodeCalls, 1, 'only one image may decode in a context at once');
  releaseDecode();
  await Promise.all([first, next]);
  assert.equal(decodeCalls, 2, 'cancelled queued input never decodes and later input still runs');

  // Page producers supply a lazy decoder; its entire bitmap lifetime belongs to this same queue.
  let lazyDecodes = 0;
  let lazyCloses = 0;
  let releaseLazy;
  let startedLazy;
  const lazyStarted = new Promise(resolve => { startedLazy = resolve; });
  const activeAbort = new AbortController();
  const lazyBitmap = () => ({ width: 2, height: 2, close() { lazyCloses++; } });
  const active = normalizeImage(async () => {
    lazyDecodes++;
    startedLazy();
    await new Promise(resolve => { releaseLazy = resolve; });
    return lazyBitmap();
  }, { signal: activeAbort.signal });
  await lazyStarted;
  const queuedController = new AbortController();
  const cancelledLazy = normalizeImage(async () => { lazyDecodes++; return lazyBitmap(); }, { signal: queuedController.signal });
  const survivor = normalizeImage(async () => { lazyDecodes++; return lazyBitmap(); });
  queuedController.abort();
  await assert.rejects(cancelledLazy, { name: 'AbortError' });
  activeAbort.abort();
  assert.equal(lazyDecodes, 1, 'queued page sources must not allocate a bitmap');
  const activeRejected = assert.rejects(active, { name: 'AbortError' });
  releaseLazy();
  await Promise.all([activeRejected, survivor]);
  assert.equal(lazyDecodes, 2, 'cancelled queued source never decodes');
  assert.equal(lazyCloses, 2, 'both cancelled active decode and successful encode close their bitmap');

  const beforeLazyFailure = lazyCloses;
  await assert.rejects(normalizeImage(async () => { throw new Error('page decode failed'); }), { code: 'IMAGE_DECODE_FAILED' });
  await assert.rejects(normalizeImage(async () => lazyBitmap(), { maxBytes: 1 }), { code: 'IMAGE_ENCODE_FAILED' });
  await normalizeImage(async () => lazyBitmap());
  assert.equal(lazyCloses - beforeLazyFailure, 2, 'encoding failure releases the bitmap and the queue accepts later work');
  console.log('image normalization: dimensions, encoded bytes, original preservation, GIF, decode/input limits, abort and streaming download passed');
} finally {
  if (originalBitmap === undefined) delete globalThis.createImageBitmap; else globalThis.createImageBitmap = originalBitmap;
  if (originalCanvas === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = originalCanvas;
}
