import { createPortTransport } from "./port-transport.js";
import { MESSAGE_TRANSFER_BYTES, normalizeTransportError, TransportError } from "./message-codec.js";
import type { WireMessage } from "./message-codec.js";
import { createReceiveBudget, createTransferBudget } from "./transfer-budget.js";

export const RUNTIME_REQUEST_PORT = "qz-runtime-v1";
const requestTransferBudget = createTransferBudget(2 * MESSAGE_TRANSFER_BYTES);
const requestReceiveBudget = createReceiveBudget();
interface RuntimePort {
  postMessage(message: WireMessage): void; disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void; removeListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void; removeListener(listener: () => void): void };
}
interface RuntimeRequestOptions {
  signal?: AbortSignal; timeoutMs?: number | null;
  connect?(options: { name: string }): RuntimePort;
}

/** A one-request native Port retains the runtime sender identity while supporting large payloads. */
export function requestRuntimeMessage(message: WireMessage, options: RuntimeRequestOptions = {}): Promise<WireMessage> {
  if (options.signal?.aborted) return Promise.reject(new TransportError("TRANSPORT_CANCELLED"));
  return new Promise((resolve, reject) => {
    let settled = false;
    let port: RuntimePort;
    try { port = (options.connect || (input => chrome.runtime.connect(input)))({ name: RUNTIME_REQUEST_PORT }); }
    catch (cause) { reject(normalizeTransportError(cause)); return; }
    const transport = createPortTransport({
      budget: requestTransferBudget,
      receiveBudget: requestReceiveBudget,
      postMessage: frame => port.postMessage(frame),
      onMessage: response => finish(null, response),
      onError: error => finish(error),
    });
    const onMessage = (value: unknown) => transport.receive(value);
    const onDisconnect = () => finish(new TransportError("TRANSPORT_DISCONNECTED"));
    const onAbort = () => finish(new TransportError("TRANSPORT_CANCELLED"));
    // Only an explicit caller deadline bounds business execution.
    const timeout = options.timeoutMs ?? null;
    if (timeout !== null && (!Number.isSafeInteger(timeout) || timeout <= 0)) { transport.dispose(); port.disconnect(); reject(new TypeError("Invalid runtime request timeout")); return; }
    const timer = timeout === null ? undefined : setTimeout(() => finish(new TransportError("TRANSPORT_TIMEOUT")), timeout);
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void transport.send(message, { signal: options.signal }).catch(cause => finish(normalizeTransportError(cause)));

    function finish(error: TransportError | null, response?: WireMessage) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      options.signal?.removeEventListener("abort", onAbort);
      transport.dispose();
      try { port.disconnect(); } catch { /* Already disconnected. */ }
      if (error) reject(error); else resolve(response || {});
    }
  });
}
