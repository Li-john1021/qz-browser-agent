import assert from 'node:assert/strict';
import test from 'node:test';
import { createPortClient } from '../../src/sidepanel/features/app/port-client.js';
import { encodeMessage, MESSAGE_FRAME_BYTES, MESSAGE_TRANSFER_BYTES } from '../../src/shared/transport/message-codec.js';
import { createFakePortController } from '../sidepanel-rendering/fake-port.js';

const large = () => ({ type: 'send_message', sessionId: 's1', text: 'x'.repeat(MESSAGE_FRAME_BYTES + 1024) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}, portOptions = {}) {
  const controller = createFakePortController(portOptions);
  const timers = new Set();
  const client = createPortClient({
    connect: controller.connect,
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    ...options,
  });
  t.after(() => client.stop());
  return { client, controller, expire(delay) {
    const timer = [...timers].find(item => item.delay === delay);
    assert.ok(timer, `expected ${delay}ms timer`);
    timers.delete(timer); timer.callback();
  } };
}

function receive(controller, response) { controller.current.emit(response); }

test('retired local replies stay isolated without swallowing Background request identities', async t => {
  const { client, controller, expire } = fixture(t, { createRequestId: () => 'same diagnostic suffix' });
  const events = []; client.onMessage(event => events.push(event));
  const first = client.request('get_state', { sessionId: 's1' });
  const firstId = controller.current.sent.at(-1).requestId;
  receive(controller, { type: 'state', requestId: firstId, sessionId: 's1' });
  await first;
  for (let index = 0; index < 300; index++) {
    const request = client.request('get_state', { sessionId: 's1' });
    const requestId = controller.current.sent.at(-1).requestId;
    assert.notEqual(requestId, firstId);
    receive(controller, { type: 'state', requestId, sessionId: 's1' });
    await request;
  }
  const expired = client.request('get_messages', { sessionId: 's1' }, 47);
  await tick();
  const expiredId = controller.current.sent.at(-1).requestId;
  expire(47); await assert.rejects(expired, { code: 'PORT_REQUEST_TIMEOUT' });
  for (const requestId of [firstId, expiredId]) {
    receive(controller, { type: 'messages', requestId, sessionId: 's1', transcript: [] });
    receive(controller, { type: 'request_failed', requestId, code: 'UNAVAILABLE' });
  }
  const dynamic = { type: 'dynamic_context_request', requestId: 'ctx_42', fields: ['location'] };
  receive(controller, dynamic);
  assert.deepEqual(events, [dynamic]);
  assert.equal(client.getSnapshot().pendingRequests, 0);
});

test('connected queue bounds all message types and resumes FIFO after a failed transfer', async t => {
  const { client, controller } = fixture(t, { maxQueuedMessages: 2 });
  const sending = client.send(large());
  const failed = assert.rejects(sending, { code: 'TRANSPORT_BUSY' });
  const waiting = client.send({ type: 'sync_composer_draft', sessionId: 's1', text: 'waiting' });
  await assert.rejects(client.send({ type: 'overflow' }), { code: 'TRANSPORT_BUSY' });
  assert.equal(client.getSnapshot().queued, 2);
  for (const type of ['get_state', 'stop_session', 'ping']) {
    await assert.rejects(client.request(type, { sessionId: 's1' }), { code: 'TRANSPORT_BUSY' });
  }
  assert.deepEqual(controller.current.sent.map(frame => frame.type || frame.op), ['hello']);
  receive(controller, { __qz_transport__: 1, op: 'ready' });
  await tick();
  const begin = controller.current.sent.find(frame => frame.op === 'begin');
  assert.ok(begin);
  receive(controller, { __qz_transport__: 1, op: 'cancel', id: begin.id, code: 'TRANSPORT_BUSY' });
  await failed; await waiting;
  assert.equal(controller.current.sent.at(-1).type, 'sync_composer_draft');
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
  assert.equal(controller.connectCount, 1);
});

test('waiting messages and active transfer share one byte budget', async t => {
  const payload = large();
  const bytes = encodeMessage(payload, MESSAGE_TRANSFER_BYTES).bytes;
  const waiting = { type: 'sync_composer_draft', text: 'reserved queue payload' };
  const waitingBytes = encodeMessage(waiting).bytes;
  const { client, controller } = fixture(t, { maxBufferedBytes: bytes + waitingBytes });
  const sending = client.send(payload); const stopped = assert.rejects(sending, { code: 'PORT_STOPPED' });
  const queued = client.send(waiting); const queuedStopped = assert.rejects(queued, { code: 'PORT_STOPPED' });
  assert.equal(client.getSnapshot().bufferedBytes, bytes + waitingBytes);
  await assert.rejects(client.send({ type: 'one_byte_too_many' }), { code: 'TRANSPORT_BUSY' });
  await assert.rejects(client.send({ type: 'get_state', sessionId: 's1' }), { code: 'TRANSPORT_BUSY' });
  assert.equal(controller.current.sent.at(-1).op, 'hello');
  assert.equal(client.getSnapshot().bufferedBytes, bytes + waitingBytes);
  client.stop(); await Promise.all([stopped, queuedStopped]); await tick();
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
});

test('offline queue enforces bytes and stop releases every reservation', async t => {
  const message = { type: 'sync_composer_draft', text: 'x'.repeat(200) };
  const bytes = encodeMessage(message).bytes;
  const { client } = fixture(t, { maxBufferedBytes: bytes * 2 }, { failConnect: () => true });
  const first = client.send(message), second = client.send(message);
  const stopped = [first, second].map(pending => assert.rejects(pending, { code: 'PORT_STOPPED' }));
  assert.equal(client.getSnapshot().bufferedBytes, bytes * 2);
  await assert.rejects(client.send(message), { code: 'TRANSPORT_BUSY' });
  client.stop(); await Promise.all(stopped);
  assert.equal(client.getSnapshot().bufferedBytes, 0);
});

test('timeout of a queued request releases its bytes before the active transfer finishes', async t => {
  const payload = large(), bytes = encodeMessage(payload, MESSAGE_TRANSFER_BYTES).bytes;
  const { client, expire } = fixture(t);
  const sending = client.send(payload); const stopped = assert.rejects(sending, { code: 'PORT_STOPPED' });
  const waiting = client.request('save_config', { value: 'x'.repeat(1000) }, 49);
  assert.ok(client.getSnapshot().bufferedBytes > bytes);
  expire(49); await assert.rejects(waiting, { code: 'PORT_REQUEST_TIMEOUT' });
  assert.equal(client.getSnapshot().bufferedBytes, bytes);
  assert.equal(client.getSnapshot().queued, 1);
  client.stop(); await stopped; await tick();
  assert.equal(client.getSnapshot().bufferedBytes, 0);
});

test('active request timeout cancels transfer and releases capacity for a fresh send', async t => {
  const { client, controller, expire } = fixture(t);
  const request = client.request('send_message', { text: large().text }, 51);
  assert.ok(client.getSnapshot().bufferedBytes > MESSAGE_FRAME_BYTES);
  expire(51); await assert.rejects(request, { code: 'PORT_REQUEST_TIMEOUT' }); await tick();
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
  await client.send({ type: 'fresh' });
  assert.equal(controller.current.sent.at(-1).type, 'fresh');
  assert.equal(controller.connectCount, 1);
});

test('disconnect releases active and unsent work; reconnect sends only new work', async t => {
  const { client, controller } = fixture(t);
  const active = client.send(large()); const activeFailed = assert.rejects(active, { code: 'PORT_SEND_FAILED' });
  const queued = client.request('save_config', { value: 'queued' });
  const queuedFailed = assert.rejects(queued, { code: 'PORT_DISCONNECTED' });
  controller.current.disconnect();
  await Promise.all([activeFailed, queuedFailed]); await tick();
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
  assert.equal(client.getSnapshot().pendingRequests, 0);
  await client.send({ type: 'fresh_after_reconnect' });
  assert.equal(controller.connectCount, 2);
  assert.deepEqual(controller.current.sent.map(message => message.type), ['fresh_after_reconnect']);
});

test('deterministic enqueue failures leave no request, buffer or broken connection', async t => {
  const { client, controller } = fixture(t);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(client.request('invalid', { cycle }), { code: 'MESSAGE_SERIALIZATION_FAILED' });
  assert.equal(client.getSnapshot().pendingRequests, 0);
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  await client.send({ type: 'recovered' });
  assert.deepEqual(controller.current.sent.map(message => message.type), ['recovered']);
});


test('reconnection listeners cannot overtake work already waiting offline', async t => {
  let online = false, fromListener;
  const { client, controller, expire } = fixture(t, {}, { failConnect: () => !online });
  client.onStateChange(snapshot => {
    if (snapshot.connected) fromListener = client.send({ type: 'connected_listener' });
  });
  const first = client.send({ type: 'queued_offline' });
  assert.equal(client.getSnapshot().queued, 1);
  online = true;
  expire(600);
  await Promise.all([first, fromListener]);
  assert.deepEqual(controller.current.sent.map(message => message.type), ['queued_offline', 'connected_listener']);
  assert.equal(client.getSnapshot().bufferedBytes, 0);
});

test('a synchronous native send failure preserves unattempted offline messages for reconnect', async t => {
  let online = false, failPost = true;
  const secondMessage = { type: 'queued_second', value: 'retain this snapshot' };
  const { client, controller, expire } = fixture(t, {}, {
    failConnect: () => !online,
    failPostMessage: () => failPost,
  });
  const first = client.send({ type: 'failed_first' }).catch(error => error);
  const second = client.send(secondMessage).catch(error => error);
  assert.equal(client.getSnapshot().queued, 2);
  online = true;
  expire(1200);
  assert.equal(client.getSnapshot().state, 'disconnected', 'the native failure must retire the connection synchronously');
  assert.equal(client.getSnapshot().queued, 1, 'the offline message was never handed to the failed connection');
  assert.equal(client.getSnapshot().bufferedBytes, encodeMessage(secondMessage).bytes);
  assert.equal((await first).code, 'PORT_SEND_FAILED');
  assert.deepEqual(controller.current.sent, []);
  failPost = false;
  expire(300);
  assert.equal((await second).generation, 2);
  assert.deepEqual(controller.current.sent, [secondMessage]);
  assert.deepEqual(controller.connections[0].sent, [], 'the failed first message must not be replayed');
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
});

test('a new small send uses a new connection immediately after a synchronous native failure', async t => {
  const { client, controller } = fixture(t, {}, { failPostMessage: (_message, meta) => meta.postCount === 1 });
  const failed = client.send({ type: 'failed_first' }).catch(error => error);
  const fresh = client.send({ type: 'fresh' });
  assert.equal(controller.connectCount, 2);
  assert.deepEqual(controller.connections[0].sent, []);
  assert.deepEqual(controller.current.sent, [{ type: 'fresh' }]);
  assert.equal((await failed).code, 'PORT_SEND_FAILED');
  assert.equal((await fresh).generation, 2);
  assert.equal(client.getSnapshot().connected, true, 'the retired send continuation must not close the new connection');
});

test('a native chunk failure disposes work already assigned to that connection without replay', async t => {
  let failChunks = true;
  const { client, controller } = fixture(t, {}, { failPostMessage: message => failChunks && message.op === 'chunk' });
  const active = client.send(large()).catch(error => error);
  const waiting = client.request('waiting_on_connection', {}, null).catch(error => error);
  receive(controller, { __qz_transport__: 1, op: 'ready' });
  await tick();
  const begin = controller.current.sent.find(message => message.op === 'begin');
  assert.ok(begin);
  receive(controller, { __qz_transport__: 1, op: 'ack', id: begin.id, seq: -1 });
  await tick();
  assert.equal((await active).code, 'PORT_SEND_FAILED');
  assert.equal((await waiting).code, 'PORT_DISCONNECTED');
  assert.equal(client.getSnapshot().pendingRequests, 0);
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  assert.equal(client.getSnapshot().queued, 0);
  failChunks = false;
  await client.send({ type: 'fresh_after_chunk_failure' });
  assert.deepEqual(controller.current.sent, [{ type: 'fresh_after_chunk_failure' }]);
});

test('an offline request retained after send failure keeps its original timeout and frees its snapshot', async t => {
  let online = false, failPost = true;
  const { client, controller, expire } = fixture(t, {}, {
    failConnect: () => !online,
    failPostMessage: () => failPost,
  });
  const first = client.send({ type: 'failed_first' }).catch(error => error);
  const waiting = client.request('still_offline', { value: 'not attempted' }, 57).catch(error => error);
  online = true;
  expire(1200);
  assert.equal((await first).code, 'PORT_SEND_FAILED');
  assert.equal(client.getSnapshot().pendingRequests, 1);
  assert.equal(client.getSnapshot().queued, 1);
  assert.ok(client.getSnapshot().bufferedBytes > 0);
  expire(57);
  assert.equal((await waiting).code, 'PORT_REQUEST_TIMEOUT');
  assert.equal(client.getSnapshot().pendingRequests, 0);
  assert.equal(client.getSnapshot().queued, 0);
  assert.equal(client.getSnapshot().bufferedBytes, 0);
  failPost = false;
  await client.send({ type: 'fresh_after_timeout' });
  assert.deepEqual(controller.current.sent, [{ type: 'fresh_after_timeout' }]);
});
