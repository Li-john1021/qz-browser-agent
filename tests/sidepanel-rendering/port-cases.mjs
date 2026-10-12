import assert from "node:assert/strict";
import { createPortClient, PortClientError } from "../../src/sidepanel/features/app/port-client.js";
import { createFakePortController } from "./fake-port.js";
import { waitFor } from "./helpers.mjs";

export async function testPortClient() {
  const controller = createFakePortController({ failConnect: count => count === 1 });
  const client = createPortClient({
    connect: controller.connect,
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 5,
    shouldKeepAlive: () => false,
  });
  const first = client.send({ type: "first", value: 1 });
  const second = client.send({ type: "second", value: 2 });
  await Promise.all([first, second]);
  assert.equal(controller.connectCount, 2);
  assert.deepEqual(controller.current.sent.map(item => item.type), ["first", "second"]);

  let leakedResponses = 0;
  client.onMessage(() => { leakedResponses += 1; });
  const request = client.request("get_state", { sessionId: "s1" }, 1000);
  await waitFor(() => controller.current.sent.some(item => item.type === "get_state"));
  const message = controller.current.sent.find(item => item.type === "get_state");
  controller.current.emit({ type: "state", requestId: message.requestId, sessionId: "s1" });
  assert.equal((await request).type, "state");
  assert.equal(leakedResponses, 0, "request responses must not enter the event stream");
  client.stop();
}

export async function testPortDisconnect() {
  const controller = createFakePortController();
  const client = createPortClient({ connect: controller.connect, shouldKeepAlive: () => false });
  client.start();
  const request = client.request("slow_request", {}, 1000);
  await waitFor(() => controller.current.sent.some(item => item.type === "slow_request"));
  controller.current.disconnect();
  await assert.rejects(request, error => error instanceof PortClientError && error.code === "PORT_DISCONNECTED");
  client.stop();
}

export async function testPortPostFailure() {
  const controller = createFakePortController({
    failPostMessage(_message, meta) {
      return meta.postCount === 1;
    },
  });
  const client = createPortClient({
    connect: controller.connect,
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 50,
    shouldKeepAlive: () => false,
  });
  await assert.rejects(
    client.send({ type: "ambiguous_send" }),
    error => error instanceof PortClientError && error.code === "PORT_SEND_FAILED",
  );
  assert.deepEqual(controller.connections[0].listenerCounts, { message: 0, disconnect: 0 });
  await client.send({ type: "after_reconnect" });
  assert.equal(controller.connectCount, 2);
  assert.deepEqual(controller.current.sent.map(message => message.type), ["after_reconnect"]);
  client.stop();
}

export async function testPortQueuedTimeout() {
  const controller = createFakePortController({ failConnect: () => true });
  const client = createPortClient({
    connect: controller.connect,
    requestTimeoutMs: 20,
    reconnectDelayMs: 100,
    maxReconnectDelayMs: 100,
    shouldKeepAlive: () => false,
  });
  await assert.rejects(
    client.request("never_sent", {}, 20),
    error => error instanceof PortClientError && error.code === "PORT_REQUEST_TIMEOUT",
  );
  assert.equal(client.getSnapshot().queued, 0);
  assert.equal(client.getSnapshot().pendingRequests, 0);
  client.stop();
}

export async function testPortStaleResponse() {
  const controller = createFakePortController();
  const client = createPortClient({
    connect: controller.connect,
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 5,
    shouldKeepAlive: () => false,
  });
  const first = client.request("get_state", { sessionId: "s1" }, 1000);
  await waitFor(() => controller.current?.sent.some(message => message.type === "get_state"));
  const oldConnection = controller.current;
  const oldRequest = oldConnection.sent.find(message => message.type === "get_state");
  oldConnection.disconnect();
  await assert.rejects(first, error => error instanceof PortClientError && error.code === "PORT_DISCONNECTED");

  const second = client.request("get_state", { sessionId: "s1" }, 1000);
  await waitFor(() => controller.connectCount === 2 && controller.current.sent.some(message => message.type === "get_state"));
  oldConnection.emit({ type: "state", requestId: oldRequest.requestId, sessionId: "stale" });
  const nextRequest = controller.current.sent.find(message => message.type === "get_state");
  controller.current.emit({ type: "state", requestId: nextRequest.requestId, sessionId: "s1" });
  assert.equal((await second).sessionId, "s1");
  client.stop();
}

export async function testPortStopBoundary() {
  const controller = createFakePortController();
  const client = createPortClient({ connect: controller.connect, shouldKeepAlive: () => false });
  const request = client.request("slow", {}, 1000);
  await waitFor(() => controller.current?.sent.some(message => message.type === "slow"));
  client.stop("test boundary");
  await assert.rejects(request, error => error instanceof PortClientError && error.code === "PORT_STOPPED");
  assert.deepEqual(client.getSnapshot(), {
    state: "stopped",
    connected: false,
    stopped: true,
    generation: 2,
    queued: 0,
    bufferedBytes: 0,
    pendingRequests: 0,
    reconnectAttempt: 0,
    keepAlive: false,
  });
  client.stop("duplicate stop");
}
