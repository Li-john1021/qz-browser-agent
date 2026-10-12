import { base64ToBytes, bytesToBase64 } from "../bytes.js";
import { encodeMessage, prepareMessage, messageIdentity, MESSAGE_CHUNK_BYTES, MESSAGE_FRAME_BYTES, MESSAGE_TRANSFER_BYTES, normalizeTransportError, TransportError } from "./message-codec.js";
import type { PreparedMessage, WireMessage } from "./message-codec.js";
import { createReceiveBudget } from "./transfer-budget.js";
import type { ReceiveBudget, TransferBudget } from "./transfer-budget.js";

const MARKER = "__qz_transport__";
const VERSION = 1;
type Timer = ReturnType<typeof setTimeout>;
export interface PortTransportLimits {
  frameBytes: number; chunkBytes: number; transferBytes: number; bufferedBytes: number; transfers: number; messages: number; timeoutMs: number; handshakeMs: number;
}
const DEFAULT_LIMITS: PortTransportLimits = {
  frameBytes: MESSAGE_FRAME_BYTES, chunkBytes: MESSAGE_CHUNK_BYTES, transferBytes: MESSAGE_TRANSFER_BYTES,
  bufferedBytes: 2 * MESSAGE_TRANSFER_BYTES, transfers: 2, messages: 256, timeoutMs: 30_000, handshakeMs: 1500,
};
interface Outgoing {
  bytes: number; identity: WireMessage; fail(error: TransportError): void; waiting?: { seq: number; resolve(): void }; timer: Timer;
}
interface Incoming { data: Uint8Array | null; bytes: number; received: number; seq: number; identity: WireMessage; timer: Timer; controller: AbortController; release?: () => void }
interface Pending {
  prepared: PreparedMessage | null; bytes: number; reserved: boolean; started: boolean;
  signal?: AbortSignal; onAbort(): void; resolve(): void; reject(error: TransportError): void;
}
interface Options {
  postMessage(message: WireMessage): void;
  onMessage(message: WireMessage): void;
  onError?(error: TransportError, identity: WireMessage): void;
  limits?: Partial<PortTransportLimits>;
  budget?: TransferBudget;
  receiveBudget?: ReceiveBudget;
}

/** One native Port owns one bounded transfer scope. Disposing it revokes all pending transfers. */
export function createPortTransport(options: Options) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.chunkBytes < 4 || limits.chunkBytes * 2 + 1024 > limits.frameBytes || limits.transferBytes > limits.bufferedBytes) {
    throw new TypeError("Invalid Port transport limits");
  }
  const receiveBudget = options.receiveBudget || createReceiveBudget(limits.transferBytes);
  const outgoing = new Map<string, Outgoing>();
  const incoming = new Map<string, Incoming>();
  const queue: Pending[] = [];
  const prefix = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let sequence = 0;
  let buffered = 0;
  let receiving = 0;
  let closed = false;
  let draining = false;
  let negotiated = false;
  let handshake: { promise: Promise<void>; resolve(): void; reject(error: TransportError): void; timer: Timer } | null = null;

  function post(frame: WireMessage, checked = false) {
    if (closed) throw new TransportError("TRANSPORT_DISCONNECTED");
    if (!checked) encodeMessage(frame, limits.frameBytes);
    try { options.postMessage(frame); } catch (cause) { throw normalizeTransportError(cause); }
  }
  const control = (op: string, fields: WireMessage = {}) => post({ [MARKER]: VERSION, op, ...fields });

  function negotiate() {
    if (negotiated) return Promise.resolve();
    if (handshake) return handshake.promise;
    let resolve!: () => void;
    let reject!: (error: TransportError) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      handshake = null;
      reject(new TransportError("TRANSPORT_UPGRADE_REQUIRED"));
    }, limits.handshakeMs);
    handshake = { promise, resolve, reject, timer };
    try { control("hello"); } catch (cause) { clearTimeout(timer); handshake = null; reject(normalizeTransportError(cause)); }
    return promise;
  }

  function reserve(bytes: number) {
    if (buffered + bytes > limits.bufferedBytes) {
      throw new TransportError("TRANSPORT_BUSY", { limitBytes: limits.bufferedBytes, bufferedBytes: buffered });
    }
    options.budget?.reserve(bytes);
    buffered += bytes;
  }
  function dropIncoming(id: string) {
    const transfer = incoming.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timer);
    incoming.delete(id);
    transfer.controller.abort();
    if (transfer.data) receiving -= transfer.bytes;
    transfer.release?.();
  }
  function abortPeer(id: string, error: TransportError) {
    try { control("cancel", { id, code: error.code }); } catch { /* The native disconnect owns cleanup. */ }
  }

  function send(message: WireMessage, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (closed) return Promise.reject(new TransportError("TRANSPORT_DISCONNECTED"));
    if (signal?.aborted) return Promise.reject(new TransportError("TRANSPORT_CANCELLED"));
    try {
      const prepared = prepareMessage(message, limits.transferBytes);
      return sendPrepared(prepared, { signal });
    } catch (cause) { return Promise.reject(normalizeTransportError(cause)); }
  }

  function sendPrepared(prepared: PreparedMessage, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (closed) return Promise.reject(new TransportError("TRANSPORT_DISCONNECTED"));
    if (signal?.aborted) return Promise.reject(new TransportError("TRANSPORT_CANCELLED"));
    try {
      if (prepared.bytes > limits.transferBytes) throw new TransportError("MESSAGE_TOO_LARGE", { actualBytes: prepared.bytes, limitBytes: limits.transferBytes });
      if (!queue.length && prepared.bytes <= limits.frameBytes) { post(JSON.parse(prepared.json) as WireMessage, true); return Promise.resolve(); }
      if (queue.length >= limits.messages) throw new TransportError("TRANSPORT_BUSY", { queuedMessages: queue.length, limitMessages: limits.messages });
      reserve(prepared.bytes);
    } catch (cause) { return Promise.reject(normalizeTransportError(cause)); }
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = { prepared, bytes: prepared.bytes, reserved: true, started: false, signal,
        resolve, reject, onAbort: () => finish(pending, new TransportError("TRANSPORT_CANCELLED")) };
      queue.push(pending);
      signal?.addEventListener("abort", pending.onAbort, { once: true });
      drain();
    });
  }

  function releasePending(pending: Pending) {
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.prepared = null;
    if (!pending.reserved) return;
    pending.reserved = false;
    buffered -= pending.bytes;
    options.budget?.release(pending.bytes);
  }

  function finish(pending: Pending, error?: TransportError) {
    const index = queue.indexOf(pending);
    if (index < 0) return;
    queue.splice(index, 1);
    releasePending(pending);
    if (error) pending.reject(error); else pending.resolve();
    drain();
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (!closed && queue.length && !queue[0].started) {
        const pending = queue[0];
        pending.started = true;
        pending.signal?.removeEventListener("abort", pending.onAbort);
        const prepared = pending.prepared!;
        pending.prepared = null;
        if (pending.signal?.aborted) { finish(pending, new TransportError("TRANSPORT_CANCELLED")); continue; }
        if (prepared.bytes <= limits.frameBytes) {
          try { post(JSON.parse(prepared.json) as WireMessage, true); finish(pending); }
          catch (cause) { finish(pending, normalizeTransportError(cause)); }
          continue;
        }
        // Only transport completion gates the next delivery; business handlers stay concurrent.
        void sendLarge(prepared, pending.signal).then(() => finish(pending), cause => finish(pending, normalizeTransportError(cause)));
        return;
      }
    } finally { draining = false; }
  }

  function sendLarge(prepared: PreparedMessage, signal?: AbortSignal): Promise<void> {
    if (outgoing.size + incoming.size >= limits.transfers) {
      return Promise.reject(new TransportError("TRANSPORT_BUSY", { activeTransfers: outgoing.size + incoming.size }));
    }
    let { json } = prepared;
    const { bytes, identity } = prepared;
    const id = `${prefix}_${++sequence}`;
    let rejectFailure!: (error: TransportError) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    const transfer: Outgoing = {
      bytes, identity, fail: rejectFailure,
      timer: setTimeout(() => rejectFailure(new TransportError("TRANSPORT_TIMEOUT")), limits.timeoutMs),
    };
    outgoing.set(id, transfer);
    const onAbort = () => rejectFailure(new TransportError("TRANSPORT_CANCELLED"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const step = (seq: number, op: string, fields: WireMessage) => Promise.race([
      new Promise<void>(resolve => {
        transfer.waiting = { seq, resolve };
        control(op, { id, ...fields });
      }), failure,
    ]);
    return (async () => {
      try {
        await Promise.race([negotiate(), failure]);
        await step(-1, "begin", { bytes, identity });
        const encoder = new TextEncoder();
        const chunk = new Uint8Array(limits.chunkBytes);
        let seq = 0;
        for (let offset = 0; offset < json.length;) {
          let end = Math.min(json.length, offset + limits.chunkBytes);
          const last = json.charCodeAt(end - 1);
          if (end < json.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
          const { read, written } = encoder.encodeInto(json.slice(offset, end), chunk);
          await step(seq, "chunk", { seq, data: bytesToBase64(chunk.subarray(0, written)) });
          offset += read;
          seq += 1;
        }
        json = "";
        await step(seq, "end", { seq });
      } catch (cause) {
        const error = normalizeTransportError(cause);
        abortPeer(id, error);
        throw error;
      } finally {
        clearTimeout(transfer.timer);
        signal?.removeEventListener("abort", onAbort);
        outgoing.delete(id);
      }
    })();
  }

  function receive(value: unknown) {
    if (closed) return;
    if (!isMessage(value)) { options.onError?.(new TransportError("TRANSPORT_PROTOCOL_ERROR"), {}); return; }
    if (!(MARKER in value)) {
      // Chrome already serialized legacy envelopes; framing thresholds apply only to protocol frames.
      options.onMessage(value);
      return;
    }
    const id = typeof value.id === "string" && value.id.length <= 100 ? value.id : "";
    let completeMessage: WireMessage;
    try {
      encodeMessage(value, limits.frameBytes);
      if (value[MARKER] !== VERSION) throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
      const op = value.op;
      if (op === "hello" || op === "ready") {
        negotiated = true;
        if (handshake) { clearTimeout(handshake.timer); handshake.resolve(); handshake = null; }
        if (op === "hello") control("ready");
        return;
      }
      if (!negotiated || !id) throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
      if (op === "ack") {
        const waiting = outgoing.get(id)?.waiting;
        if (waiting && waiting.seq === value.seq) { outgoing.get(id)!.waiting = undefined; waiting.resolve(); }
        return;
      }
      if (op === "cancel") {
        const code = value.code === "TRANSPORT_BUSY" ? "TRANSPORT_BUSY"
          : value.code === "MESSAGE_TOO_LARGE" ? "MESSAGE_TOO_LARGE" : "TRANSPORT_CANCELLED";
        const active = outgoing.get(id);
        if (active) active.fail(new TransportError(code));
        dropIncoming(id);
        return;
      }
      if (op === "begin") {
        const bytes = Number(value.bytes);
        if (!Number.isSafeInteger(bytes) || bytes <= limits.frameBytes || bytes > limits.transferBytes || incoming.has(id)) {
          throw new TransportError(bytes > limits.transferBytes ? "MESSAGE_TOO_LARGE" : "TRANSPORT_PROTOCOL_ERROR");
        }
        if (outgoing.size + incoming.size >= limits.transfers) throw new TransportError("TRANSPORT_BUSY", { activeTransfers: outgoing.size + incoming.size });
        const identity = messageIdentity(isMessage(value.identity) ? value.identity : {});
        const fail = (error: TransportError) => {
          if (incoming.get(id) !== transfer) return;
          dropIncoming(id);
          abortPeer(id, error);
          options.onError?.(error, identity);
        };
        const expire = () => fail(new TransportError("TRANSPORT_TIMEOUT"));
        const transfer: Incoming = {
          data: null, bytes, received: 0, seq: 0, identity, controller: new AbortController(),
          timer: setTimeout(expire, limits.timeoutMs),
        };
        incoming.set(id, transfer);
        void receiveBudget.acquire(bytes, { signal: transfer.controller.signal }).then(release => {
          if (closed || incoming.get(id) !== transfer) { release(); return; }
          transfer.release = release;
          try {
            transfer.data = new Uint8Array(bytes);
            receiving += bytes;
            control("ack", { id, seq: -1 });
          } catch (cause) { fail(cause instanceof TransportError ? cause : new TransportError("TRANSPORT_BUSY")); }
        }, cause => fail(normalizeTransportError(cause)));
        return;
      }
      const transfer = incoming.get(id);
      if (!transfer?.data) throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
      if (op === "chunk") {
        if (value.seq !== transfer.seq || typeof value.data !== "string" || value.data.length > Math.ceil(limits.chunkBytes / 3) * 4) {
          throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
        }
        const bytes = base64ToBytes(value.data);
        if (!bytes.byteLength || bytes.byteLength > limits.chunkBytes || transfer.received + bytes.byteLength > transfer.data.byteLength) {
          throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
        }
        transfer.data.set(bytes, transfer.received);
        transfer.received += bytes.byteLength;
        transfer.seq += 1;
        control("ack", { id, seq: value.seq });
        return;
      }
      if (op !== "end" || value.seq !== transfer.seq || transfer.received !== transfer.data.byteLength) {
        throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
      }
      const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(transfer.data));
      if (!isMessage(message) || MARKER in message || !sameIdentity(messageIdentity(message), transfer.identity)) {
        throw new TransportError("TRANSPORT_PROTOCOL_ERROR");
      }
      dropIncoming(id);
      // Complete the transport before dispatch. A business error is a separate request response.
      control("ack", { id, seq: value.seq });
      completeMessage = message;
    } catch (cause) {
      const identity = incoming.get(id)?.identity || {};
      dropIncoming(id);
      const error = cause instanceof TransportError ? cause : new TransportError("TRANSPORT_PROTOCOL_ERROR");
      if (id) abortPeer(id, error);
      options.onError?.(error, identity);
      return;
    }
    options.onMessage(completeMessage);
  }

  function dispose(reason = new TransportError("TRANSPORT_DISCONNECTED")) {
    if (closed) return;
    closed = true;
    if (handshake) { clearTimeout(handshake.timer); handshake.reject(reason); handshake = null; }
    for (const transfer of outgoing.values()) transfer.fail(reason);
    for (const pending of queue.splice(0)) { releasePending(pending); pending.reject(reason); }
    for (const id of incoming.keys()) dropIncoming(id);
  }
  return { send, sendPrepared, receive, dispose, snapshot: () => ({ bufferedBytes: buffered + receiving, encodedBytes: buffered, receivingBytes: receiving, queued: queue.length, outgoing: outgoing.size, incoming: incoming.size, closed, negotiated }) };
}

function isMessage(value: unknown): value is WireMessage { return !!value && typeof value === "object" && !Array.isArray(value); }
function sameIdentity(left: WireMessage, right: WireMessage) { return ["type", "sessionId", "requestId"].every(key => left[key] === right[key]); }
