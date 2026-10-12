import { MESSAGE_TRANSFER_BYTES, TransportError } from "./message-codec.js";

export interface TransferBudget { reserve(bytes: number): void; release(bytes: number): void }

/** Explicitly share this owner among transports in one JavaScript context. */
export function createTransferBudget(limitBytes = MESSAGE_TRANSFER_BYTES) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new TypeError("Invalid transfer budget");
  let reservedBytes = 0;
  return {
    reserve(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError("Invalid transfer reservation");
      if (reservedBytes + bytes > limitBytes) throw new TransportError("TRANSPORT_BUSY", { limitBytes, reservedBytes });
      reservedBytes += bytes;
    },
    release(bytes: number) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > reservedBytes) throw new TypeError("Invalid transfer release");
      reservedBytes -= bytes;
    },
    snapshot: () => ({ reservedBytes, limitBytes }),
  };
}

export interface ReceiveBudget {
  acquire(bytes: number, options?: { signal?: AbortSignal }): Promise<() => void>;
}

/** Only allocated receive buffers consume bytes; waiters hold bounded metadata and preserve FIFO. */
export function createReceiveBudget(limitBytes = MESSAGE_TRANSFER_BYTES, maxWaiters = 256) {
  const budget = createTransferBudget(limitBytes);
  if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1) throw new TypeError("Invalid receive waiter limit");
  interface Waiter { bytes: number; signal?: AbortSignal; abort(): void; resolve(release: () => void): void; reject(error: TransportError): void }
  const queue: Waiter[] = [];

  function drain() {
    while (queue.length && budget.snapshot().reservedBytes + queue[0].bytes <= limitBytes) {
      const waiter = queue.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      budget.reserve(waiter.bytes);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        budget.release(waiter.bytes);
        drain();
      });
    }
  }

  return {
    acquire(bytes: number, { signal }: { signal?: AbortSignal } = {}): Promise<() => void> {
      if (!Number.isSafeInteger(bytes) || bytes < 1) return Promise.reject(new TypeError("Invalid receive reservation"));
      if (bytes > limitBytes) return Promise.reject(new TransportError("MESSAGE_TOO_LARGE", { actualBytes: bytes, limitBytes }));
      if (signal?.aborted) return Promise.reject(new TransportError("TRANSPORT_CANCELLED"));
      if (queue.length >= maxWaiters) return Promise.reject(new TransportError("TRANSPORT_BUSY", { queuedMessages: queue.length, limitMessages: maxWaiters }));
      return new Promise((resolve, reject) => {
        const waiter: Waiter = { bytes, signal, resolve, reject, abort() {
          const index = queue.indexOf(waiter);
          if (index < 0) return;
          queue.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          reject(new TransportError("TRANSPORT_CANCELLED"));
          drain();
        } };
        queue.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
        drain();
      });
    },
    snapshot: () => ({ ...budget.snapshot(), waiting: queue.length }),
  };
}
