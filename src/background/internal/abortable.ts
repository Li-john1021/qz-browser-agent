export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

/** Race a cooperative operation against cancellation and a deadline; always release listeners. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => T | PromiseLike<T>,
  { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number },
): Promise<T> {
  throwIfCancelled(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Operation cancelled", "AbortError"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Operation timed out", "TimeoutError")), timeoutMs);
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
