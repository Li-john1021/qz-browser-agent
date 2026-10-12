import assert from "node:assert/strict";
import test from "node:test";
import { createPortTransport } from "../../src/shared/transport/port-transport.js";
import { encodeMessage, prepareMessage, MESSAGE_FRAME_BYTES, transportFailure, utf8ByteLength } from "../../src/shared/transport/message-codec.js";
import { createPortClient } from "../../src/sidepanel/features/app/port-client.js";
import { createFakePortController, createFakeEvent } from "../sidepanel-rendering/fake-port.js";
import { requestRuntimeMessage, RUNTIME_REQUEST_PORT } from "../../src/shared/transport/runtime-request.js";
import { createRuntimeMessageTransport } from "../../src/background/transports/runtime-message.js";
import { createBackgroundApi } from "../../src/background/background-api.js";

const limits = { frameBytes: 4096, chunkBytes: 512, transferBytes: 32_768, bufferedBytes: 32_768, transfers: 2, timeoutMs: 300, handshakeMs: 30 };
const large = () => ({ type: "messages", sessionId: "s1", requestId: "r1", runId: "run-7", eventSeq: 12, transcript: [{ text: "图像🌍\n".repeat(1200) }] });

test("message byte budget counts UTF-8 JSON and handles invalid serialization", () => {
  for (const value of ["hello", "中文", "🌍", "\ud800", '"\\\n']) {
    assert.equal(utf8ByteLength(value), new TextEncoder().encode(value).byteLength);
    assert.equal(encodeMessage({ value }).bytes, new TextEncoder().encode(JSON.stringify({ value })).byteLength);
  }
  assert.throws(() => encodeMessage({ text: "中文" }, 10), { code: "MESSAGE_TOO_LARGE" });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => encodeMessage(cycle), { code: "MESSAGE_SERIALIZATION_FAILED" });
  assert.throws(() => encodeMessage({ value: 1n }), { code: "MESSAGE_SERIALIZATION_FAILED" });
});

test("small direct messages retain their envelope and need no negotiation", async t => {
  const pair = linked(t);
  const message = { type: "state", sessionId: "s1", runtime: { running: false } };
  await pair.left.send(message);
  assert.deepEqual(pair.rightMessages, [message]);
  assert.deepEqual(pair.frames, [message]);
});

test("small and chunked sends capture a producer toJSON exactly once", async t => {
  for (const size of [20, 6000]) {
    const pair = linked(t);
    let reads = 0;
    const message = { type: 'captured', payload: { toJSON() { reads++; return 'x'.repeat(size); } } };
    const sending = pair.left.send(message);
    assert.equal(reads, 1);
    await sending;
    assert.equal(reads, 1);
    assert.deepEqual(pair.rightMessages, [{ type: 'captured', payload: 'x'.repeat(size) }]);
  }
});

test("large messages round trip through bounded acknowledged frames with identity intact", async t => {
  const pair = linked(t);
  const message = large();
  await pair.left.send(message);
  assert.deepEqual(pair.rightMessages, [message]);
  assert.ok(pair.frames.some(frame => frame.op === "chunk"));
  assert.ok(pair.frames.every(frame => encodeMessage(frame).bytes <= limits.frameBytes));
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
  assert.equal(pair.right.snapshot().bufferedBytes, 0);
  assert.deepEqual(pair.errors, []);
});

test("queued large envelopes serialize once and retain their captured payload", async t => {
  const pair = linked(t);
  const message = large();
  const expected = structuredClone(message);
  let serializations = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, "stringify", function(value, ...args) {
    if (value?.type === "messages" && value?.requestId === message.requestId) serializations++;
    return stringify.call(this, value, ...args);
  });
  const sending = pair.left.send(message);
  message.transcript[0].text = "producer changed after enqueue";
  await sending;
  assert.equal(pair.left.snapshot().queued, 0);
  assert.equal(serializations, 1, "a large queued payload must not be reserialized by transport");
  assert.deepEqual(pair.rightMessages, [expected]);
  assert.deepEqual(pair.errors, []);
});

test("prepared envelopes obey destination limits and cancellation without retaining buffers", async t => {
  const pair = linked(t);
  const oversized = prepareMessage({ type: "messages", text: "x".repeat(limits.transferBytes) });
  await assert.rejects(pair.left.sendPrepared(oversized), { code: "MESSAGE_TOO_LARGE" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pair.left.sendPrepared(prepareMessage(large()), { signal: controller.signal }), { code: "TRANSPORT_CANCELLED" });
  assert.deepEqual(pair.frames, []);
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
  await pair.left.sendPrepared(prepareMessage({ type: "state", status: "idle" }));
  assert.deepEqual(pair.rightMessages, [{ type: "state", status: "idle" }]);
});

test("large-transfer negotiation fails deterministically for an old peer without breaking small messages", async t => {
  const posted = [];
  const transport = createPortTransport({ limits, postMessage: frame => posted.push(frame), onMessage() {} });
  t.after(() => transport.dispose());
  await assert.rejects(transport.send(large()), { code: "TRANSPORT_UPGRADE_REQUIRED" });
  await transport.send({ type: "get_state" });
  assert.equal(posted.at(-1).type, "get_state");
  assert.equal(transport.snapshot().bufferedBytes, 0);
});

test("total allocation rejects a second large transfer while preserving the first", async t => {
  const pair = linked(t, { bufferedBytes: 16_384, transferBytes: 16_384 });
  const payload = { type: "messages", text: "a".repeat(10_000) };
  const first = pair.left.send(payload);
  await assert.rejects(pair.left.send(payload), { code: "TRANSPORT_BUSY" });
  await first;
  assert.deepEqual(pair.rightMessages, [payload]);
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
});

test("aborting an in-flight transfer releases both buffers and never dispatches a partial message", async t => {
  const controller = new AbortController();
  const pair = linked(t, {}, frame => { if (frame.op === "chunk") controller.abort(); });
  await assert.rejects(pair.left.send(large(), { signal: controller.signal }), { code: "TRANSPORT_CANCELLED" });
  await tick();
  assert.deepEqual(pair.rightMessages, []);
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
  assert.equal(pair.right.snapshot().bufferedBytes, 0);
  await pair.left.send({ type: "ping" });
  assert.equal(pair.rightMessages.at(-1).type, "ping");
});

test("disconnect revokes transfers and ignores late frames from the retired connection", async t => {
  let pair;
  pair = linked(t, {}, frame => { if (frame.op === "chunk") { pair.left.dispose(); pair.right.dispose(); } });
  await assert.rejects(pair.left.send(large()), { code: "TRANSPORT_DISCONNECTED" });
  await tick();
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
  assert.equal(pair.right.snapshot().bufferedBytes, 0);
  pair.right.receive({ type: "state", sessionId: "late" });
  assert.deepEqual(pair.rightMessages, []);
});

test("missing acknowledgement times out without replaying or retaining a partial transfer", async t => {
  const pair = linked(t, { timeoutMs: 40 }, null, frame => frame.op === "ack");
  await assert.rejects(pair.left.send(large()), { code: "TRANSPORT_TIMEOUT" });
  await tick();
  assert.deepEqual(pair.rightMessages, []);
  assert.equal(pair.left.snapshot().bufferedBytes, 0);
  assert.equal(pair.right.snapshot().bufferedBytes, 0);
});

test("malformed, reordered and excessive transfer frames fail before business dispatch", t => {
  const received = [], errors = [], sent = [];
  const transport = createPortTransport({ limits, postMessage: frame => sent.push(frame), onMessage: message => received.push(message), onError: error => errors.push(error.code) });
  t.after(() => transport.dispose());
  const frame = fields => ({ __qz_transport__: 1, ...fields });
  transport.receive(frame({ op: "hello" }));
  transport.receive(frame({ op: "begin", id: "too-large", bytes: 99_999, identity: {} }));
  assert.equal(errors.at(-1), "MESSAGE_TOO_LARGE");
  transport.receive(frame({ op: "begin", id: "wrong-order", bytes: 5000, identity: { type: "messages" } }));
  transport.receive(frame({ op: "chunk", id: "wrong-order", seq: 1, data: btoa("abc") }));
  assert.equal(errors.at(-1), "TRANSPORT_PROTOCOL_ERROR");
  assert.equal(transport.snapshot().bufferedBytes, 0);
  transport.receive(frame({ op: "begin", id: "incomplete", bytes: 5000, identity: {} }));
  transport.receive(frame({ op: "end", id: "incomplete", seq: 0 }));
  assert.equal(transport.snapshot().bufferedBytes, 0);
  assert.deepEqual(received, []);
});

test("request failure retains correlation, contains no payload and never uses the Agent error event", () => {
  const cause = Object.assign(new Error("Cannot read this task"), { code: "READ_FAILED", details: { retryable: false, body: "private".repeat(5000) } });
  const failure = transportFailure(cause, { type: "get_messages", requestId: "r1", sessionId: "s1", images: ["private"] });
  assert.deepEqual(failure, { type: "request_failed", requestId: "r1", sessionId: "s1", requestType: "get_messages", code: "READ_FAILED", message: "Cannot read this task", details: { retryable: false } });
});

test("PortClient rejects correlated request_failed without leaking it as a run event", async t => {
  const controller = createFakePortController();
  const client = createPortClient({ connect: controller.connect });
  t.after(() => client.stop());
  const events = []; client.onMessage(event => events.push(event));
  const request = client.request("get_messages", { sessionId: "s1" });
  const sent = controller.current.sent.find(item => item.type === "get_messages");
  controller.current.emit({ type: "request_failed", requestId: sent.requestId, sessionId: "s1", code: "MESSAGE_TOO_LARGE", message: "Too large" });
  await assert.rejects(request, { code: "MESSAGE_TOO_LARGE" });
  assert.deepEqual(events, []);
  assert.equal(client.getSnapshot().connected, true);
});

test("a native size error does not reconnect or replay and the next small message succeeds", async t => {
  const controller = createFakePortController();
  const client = createPortClient({ connect: () => {
    const port = controller.connect();
    const native = port.postMessage;
    port.postMessage = message => {
      if (message.type === "oversize") throw new Error("Message exceeded maximum allowed size of 64MiB.");
      native(message);
    };
    return port;
  } });
  t.after(() => client.stop());
  await assert.rejects(client.send({ type: "oversize" }), { code: "MESSAGE_TOO_LARGE" });
  await client.send({ type: "small" });
  assert.equal(controller.connectCount, 1);
  assert.deepEqual(controller.current.sent.map(message => message.type), ["small"]);
});

test("runtime Port transfers a large request and response through the original sender authorization", async t => {
  const requests = [];
  const runtime = runtimeConnector(t, async (message, sender) => {
    requests.push({ bytes: message.payload.length, sender });
    return { content: message.payload };
  });
  const content = "r".repeat(MESSAGE_FRAME_BYTES + 1024);
  const response = await requestRuntimeMessage({ type: "session_export_import_request", payload: content }, { connect: runtime.connect });
  assert.equal(response.ok, true);
  assert.equal(response.content.length, content.length);
  assert.deepEqual(requests, [{ bytes: content.length, sender: runtime.sender }]);
  assert.ok(runtime.frames.some(frame => frame.op === "chunk"));
  assert.ok(runtime.frames.every(frame => encodeMessage(frame).bytes <= MESSAGE_FRAME_BYTES));
  assert.ok(runtime.connections.every(connection => connection.closed));
});

test("runtime Port cannot invoke Side Panel-only API methods", async t => {
  let called = false;
  const runtime = runtimeConnector(t, async () => { called = true; return {}; });
  const response = await requestRuntimeMessage({ type: "save_config", config: {} }, { connect: runtime.connect });
  assert.equal(response.ok, false);
  assert.equal(response.code, "TRANSPORT_PROTOCOL_ERROR");
  assert.equal(called, false);
  assert.ok(runtime.connections.every(connection => connection.closed));
});

test("an unencodable runtime result reports one transport failure and releases the connection", async t => {
  let calls = 0;
  const result = {};
  result.self = result;
  const runtime = runtimeConnector(t, async () => { calls++; return result; });
  const response = await requestRuntimeMessage({ type: "session_export_import_request" }, { connect: runtime.connect });
  assert.equal(response.ok, false);
  assert.equal(response.code, "MESSAGE_SERIALIZATION_FAILED");
  assert.equal(calls, 1);
  assert.ok(runtime.connections.every(connection => connection.closed));
});

test("runtime request cancellation closes the transfer scope and ignores a late business response", async t => {
  let finish;
  const controller = new AbortController();
  const runtime = runtimeConnector(t, () => new Promise(resolve => { finish = resolve; }));
  const request = requestRuntimeMessage({ type: "session_export_import_request", payload: "small" }, { connect: runtime.connect, signal: controller.signal });
  await tick();
  assert.equal(typeof finish, "function");
  controller.abort();
  await assert.rejects(request, { code: "TRANSPORT_CANCELLED" });
  const count = runtime.frames.length;
  finish({ restored: true });
  await tick();
  assert.equal(runtime.frames.length, count);
  assert.ok(runtime.connections.every(connection => connection.closed));
});

test("independent runtime requests preserve concurrent business execution and cancellation", async t => {
  let calls = 0;
  const runtime = runtimeConnector(t, () => { calls++; return new Promise(() => {}); });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const requests = controllers.map(controller => requestRuntimeMessage({ type: "session_export_import_request" }, {
    connect: runtime.connect, signal: controller.signal,
  }).catch(error => error));
  await tick();
  assert.equal(calls, 8, "all independent requests must start before any previous result returns");
  controllers.forEach(controller => controller.abort());
  assert.ok((await Promise.all(requests)).every(error => error.code === "TRANSPORT_CANCELLED"));
  const response = await requestRuntimeMessage({ type: "offscreen_keepalive" }, { connect: runtime.connect });
  assert.equal(response.ok, true);
  assert.ok(runtime.connections.every(connection => connection.closed));
});

test("runtime business execution has no implicit 30 or 60 second transport deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const runtime = runtimeConnector(t, () => new Promise(resolve => { finish = resolve; }));
  const request = requestRuntimeMessage({ type: "session_export_import_request" }, { connect: runtime.connect });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, "function");
  t.mock.timers.tick(61_000);
  assert.equal(runtime.connections[0].closed, false);
  finish({ restored: true });
  assert.equal((await request).restored, true);
  assert.equal(runtime.connections[0].closed, true);
});

test("explicit runtime caller deadlines close the Port and suppress late responses", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const runtime = runtimeConnector(t, () => new Promise(resolve => { finish = resolve; }));
  const request = requestRuntimeMessage({ type: "session_export_import_request" }, { connect: runtime.connect, timeoutMs: 25 });
  const rejected = assert.rejects(request, { code: "TRANSPORT_TIMEOUT" });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(25);
  await rejected;
  assert.equal(runtime.connections[0].closed, true);
  const sent = runtime.frames.length;
  finish({ restored: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.frames.length, sent);
});

test("an idle runtime connection is cleaned up without dispatching business work", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime = runtimeConnector(t, () => assert.fail("idle connection dispatched a request"));
  runtime.connect({ name: RUNTIME_REQUEST_PORT });
  assert.equal(runtime.connections[0].closed, false);
  t.mock.timers.tick(60_001);
  assert.equal(runtime.connections[0].closed, true);
});

test("native runtime messages retain payloads above the Port chunk threshold", async () => {
  const content = "r".repeat(MESSAGE_FRAME_BYTES + 1024);
  const sender = { id: "fixture", url: "https://fixture.test/export.html" };
  const host = createRuntimeMessageTransport(createBackgroundApi({ exchange: {
    importFromPage: (message, actualSender) => {
      assert.equal(message.payload, content);
      assert.equal(actualSender, sender);
      return { content };
    },
  } }));
  const response = await new Promise(resolve => host.listener({ type: "session_export_import_request", payload: content }, sender, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.content, content);
});

function runtimeConnector(t, importFromPage) {
  const runtime = { onMessage: createFakeEvent(), onConnect: createFakeEvent() };
  const host = createRuntimeMessageTransport(createBackgroundApi({ exchange: { importFromPage } }));
  const unregister = host.register(runtime);
  const frames = [], connections = [];
  const sender = { tab: { id: 17, windowId: 2 }, url: "https://fixture.test/export.html", id: "extension-fixture" };
  t.after(() => { unregister(); connections.forEach(connection => connection.disconnect()); });
  function connect({ name }) {
    assert.equal(name, RUNTIME_REQUEST_PORT);
    let closed = false;
    const client = { name, onMessage: createFakeEvent(), onDisconnect: createFakeEvent() };
    const server = { name, sender, onMessage: createFakeEvent(), onDisconnect: createFakeEvent() };
    const disconnect = () => { if (closed) return; closed = true; client.onDisconnect.emit(); server.onDisconnect.emit(); };
    const post = peer => message => {
      if (closed) throw new Error("Port disconnected");
      frames.push(message);
      assert.ok(encodeMessage(message).bytes <= MESSAGE_FRAME_BYTES);
      queueMicrotask(() => { if (!closed) peer.onMessage.emit(structuredClone(message)); });
    };
    Object.assign(client, { postMessage: post(server), disconnect });
    Object.assign(server, { postMessage: post(client), disconnect });
    connections.push({ disconnect, get closed() { return closed; } });
    runtime.onConnect.emit(server);
    return client;
  }
  return { connect, frames, connections, sender };
}

function linked(t, overrides = {}, observe = null, drop = null) {
  const frames = [], errors = [], leftMessages = [], rightMessages = [];
  let left, right;
  const post = destination => frame => {
    frames.push(frame);
    observe?.(frame);
    if (!drop?.(frame)) queueMicrotask(() => destination().receive(frame));
  };
  left = createPortTransport({ limits: { ...limits, ...overrides }, postMessage: post(() => right), onMessage: message => leftMessages.push(message), onError: error => errors.push(error.code) });
  right = createPortTransport({ limits: { ...limits, ...overrides }, postMessage: post(() => left), onMessage: message => rightMessages.push(message), onError: error => errors.push(error.code) });
  t.after(() => { left.dispose(); right.dispose(); });
  return { left, right, frames, errors, leftMessages, rightMessages };
}
function tick() { return new Promise(resolve => setTimeout(resolve, 0)); }
