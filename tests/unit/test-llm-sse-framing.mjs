import test from 'node:test';
import assert from 'node:assert/strict';
import { readSseFrames, waitForAbortableDelay } from '../../src/background/llm/transport.js';

const bytes = text => new TextEncoder().encode(text);
const signal = () => new AbortController().signal;
function reader(text) {
  const chunks = bytes(text);
  return new ReadableStream({ start(controller) {
    // Single-byte fragments force UTF-8 characters, CRLF and field names across reads.
    for (const byte of chunks) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }).getReader();
}

test('SSE framing preserves UTF-8, event identity, multiline data, empty records and unfinished tails', async () => {
  const frames = await Array.fromAsync(readSseFrames(reader(
    ': comment\r\nevent: discarded\r\n\r\nevent: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: {"final":true}',
  ), 1000, signal()));
  assert.deepEqual(frames, [
    { event: 'message', data: '{"text":\n"你好"}' },
    { event: '', data: '{"final":true}' },
  ]);
});

test('bare terminal marker support stays an explicit adapter policy; reader timing closes once', async () => {
  const events = [];
  const frames = await Array.fromAsync(readSseFrames(reader('event: completed\ndata: {}\n\n[DONE]'), 1000, signal(), {
    acceptDoneMarker: true, trace: (stage, fields) => events.push({ stage, fields }),
  }));
  assert.deepEqual(frames, [{ event: 'completed', data: '{}' }, { event: '', data: '[DONE]' }]);
  assert.deepEqual(await Array.fromAsync(readSseFrames(reader('[DONE]'), 1000, signal())), []);
  assert.equal(events.filter(event => event.stage === 'llm_reader_done').length, 1);
  assert.equal(events.at(-1).fields.bytes, bytes('event: completed\ndata: {}\n\n[DONE]').length);
});

test('an aborted stalled SSE reader is cancelled without emitting an incomplete frame', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({ start(output) { output.enqueue(bytes('data: {')); }, cancel() { cancelled = true; } });
  const pending = Array.fromAsync(readSseFrames(stream.getReader(), 1000, controller.signal));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('shared retry delay rejects cancellation before zero delay and during a wait', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(waitForAbortableDelay(0, aborted.signal), { name: 'AbortError' });
  const controller = new AbortController();
  const pending = waitForAbortableDelay(10000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await waitForAbortableDelay(-1);
});
