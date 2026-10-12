import assert from 'node:assert/strict';
import test from 'node:test';
import { generateLargeImage, collectionToolCall, collectionRequestSummary,
  COLLECTION_IMAGE_COUNT, COLLECTION_IMAGE_WIDTH, COLLECTION_IMAGE_HEIGHT,
} from '../fixtures/large-image-conversation.mjs';

test('collection fixtures use bounded real oversized PNGs with different deterministic pixels', async () => {
  const images = await Promise.all([1, 2].map(seed => generateLargeImage({
    width: COLLECTION_IMAGE_WIDTH, height: COLLECTION_IMAGE_HEIGHT, seed,
  })));
  assert.equal(COLLECTION_IMAGE_COUNT, 40);
  assert.ok(COLLECTION_IMAGE_WIDTH > 2048);
  for (const image of images) {
    const png = Buffer.from(image.dataUrl.split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), COLLECTION_IMAGE_WIDTH);
    assert.equal(png.readUInt32BE(20), COLLECTION_IMAGE_HEIGHT);
    assert.equal(png.length, image.encodedBytes);
    assert.ok(png.length > 2 * 1024 * 1024 && png.length < 4 * 1024 * 1024);
  }
  assert.notEqual(images[0].dataUrl, images[1].dataUrl);
});

test('collection evidence preserves tool order and latest-image placeholders without retaining payloads', async () => {
  const image = await generateLargeImage({ width: 16, height: 8, seed: 42 });
  const messages = Array.from({ length: 40 }, (_, offset) => {
    const index = offset + 1;
    const call = collectionToolCall(index, 'http://127.0.0.1:9999');
    assert.equal(call.function.name, 'read_image');
    const args = JSON.parse(call.function.arguments);
    assert.equal(args.url, `http://127.0.0.1:9999/collect/image/${index}.png`);
    return [{ role: 'tool', tool_call_id: call.id, content: JSON.stringify({
      src: args.url, width: 16, height: 8, bytes: image.encodedBytes,
    }) }, { role: 'user', content: [{ type: 'text', text: 'A collected image' }, index <= 32
      ? { type: 'text', text: '[image omitted for context saving] x1' }
      : { type: 'image_url', image_url: { url: image.dataUrl } }] }];
  }).flat();
  const summary = collectionRequestSummary(messages);
  assert.deepEqual(summary.results.map(result => result.index), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(summary.images.length, 40);
  assert.equal(summary.images.reduce((sum, message) => sum + message.imageCount, 0), 8);
  assert.equal(summary.images.slice(0, 32).every(message => message.placeholders[0] === '[image omitted for context saving] x1'), true);
  assert.equal(summary.images.slice(32).every(message => message.placeholders.length === 0), true);
  assert.equal(summary.images.at(-1).images[0].bytes, image.encodedBytes);
  assert.equal(summary.images.at(-1).images[0].width, 16);
  assert.equal(summary.images.at(-1).images[0].height, 8);
  assert.match(summary.images.at(-1).images[0].sha256, /^[a-f\d]{64}$/);
  assert.equal(JSON.stringify(summary).includes('data:image'), false);
  assert.equal(collectionToolCall(41, 'http://127.0.0.1').id, 'collect_image_41');
  for (const invalid of [0, 42, -1, 1.5]) assert.throws(() => collectionToolCall(invalid, 'http://127.0.0.1'), RangeError);
});
