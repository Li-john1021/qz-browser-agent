export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  const run = <T>(task: () => T | PromiseLike<T>) => {
    if (typeof task !== "function") throw new TypeError("queue task must be a function");
    pending += 1;
    const result = tail.catch(() => undefined).then(task);
    // Reject the caller's result without poisoning later work on the same queue.
    tail = result
      .catch(() => undefined)
      .finally(() => {
        pending = Math.max(0, pending - 1);
      });
    return result;
  };

  return Object.freeze({
    run,
    onIdle: () => tail,
    get pending() {
      return pending;
    },
  });
}

export function createKeyedSerialQueue() {
  const queues = new Map<string, ReturnType<typeof createSerialQueue>>();

  const getQueue = (key: unknown) => {
    const normalizedKey = String(key ?? "");
    let queue = queues.get(normalizedKey);
    if (!queue) {
      queue = createSerialQueue();
      queues.set(normalizedKey, queue);
    }
    return { key: normalizedKey, queue };
  };

  const run = <T>(key: unknown, task: () => T | PromiseLike<T>) => {
    const entry = getQueue(key);
    const result = entry.queue.run(task);
    result.finally(() => {
      queueMicrotask(() => {
        if (entry.queue.pending === 0 && queues.get(entry.key) === entry.queue) {
          queues.delete(entry.key);
        }
      });
    }).catch(() => undefined);
    return result;
  };

  return Object.freeze({
    run,
    onIdle: async (key?: unknown) => {
      if (key !== undefined) return queues.get(String(key ?? ""))?.onIdle();
      await Promise.all([...queues.values()].map((queue) => queue.onIdle()));
    },
    size: () => queues.size,
  });
}
