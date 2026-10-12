type TraceMetadata = Record<string, unknown>;
export interface PerfTraceEntry { at: string; name: string; ms: number; meta: TraceMetadata }
declare global { var __qingzhouPerf: PerfTraceEntry[] | undefined }
interface PerfTraceOptions { thresholdMs?: number; bufferLimit?: number; isBenchmark?(): boolean; isEnabled?(): boolean }

export function createPerfTrace(options: PerfTraceOptions = {}) {
  const thresholdMs = Math.max(0, Number(options.thresholdMs) || 8);
  const bufferLimit = options.isBenchmark?.() ? 50_000 : Math.max(1, Number(options.bufferLimit) || 200);

  function now() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function start(name: string, meta: TraceMetadata = {}) {
    if (options.isEnabled?.() !== true) return null;
    const startedAt = now();
    return (extra: TraceMetadata = {}) => record(name, now() - startedAt, { ...meta, ...extra });
  }

  function startData(name: string, meta: TraceMetadata = {}) {
    const startedAt = now();
    return (extra: TraceMetadata = {}) => record(`data.${name}`, now() - startedAt, { ...meta, ...extra });
  }

  function measure<T>(name: string, meta: TraceMetadata, action: () => T) {
    const end = start(name, meta);
    if (!end) return action();
    try {
      const result = action();
      end();
      return result;
    } catch (error) {
      end({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async function measureAsync<T>(name: string, meta: TraceMetadata, action: () => T | Promise<T>) {
    const end = start(name, meta);
    if (!end) return action();
    try {
      const result = await action();
      end();
      return result;
    } catch (error) {
      end({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  function record(name: string, ms: number, meta: TraceMetadata = {}) {
    const entry = {
      at: new Date().toISOString(),
      name,
      ms: Math.round(ms * 10) / 10,
      meta,
    };
    const target = buffer();
    target.push(entry);
    if (target.length > bufferLimit) target.splice(0, target.length - bufferLimit);
    const isDataTrace = String(name || "").startsWith("data.");
    if (options.isEnabled?.() === true && (isDataTrace || entry.ms >= thresholdMs || meta.error)) {
      console.debug("[轻舟 perf]", name, `${entry.ms.toFixed(1)}ms`, meta);
    }
  }

  function dataGrid(stage: string, payload: TraceMetadata = {}) {
    if (options.isEnabled?.() !== true) return;
    try {
      console.debug("[轻舟 data-grid]", stage, payload);
    } catch (_error) {}
  }

  function buffer() {
    const host = typeof window !== "undefined" ? window : globalThis;
    if (!Array.isArray(host.__qingzhouPerf)) host.__qingzhouPerf = [];
    return host.__qingzhouPerf;
  }

  return {
    now,
    start,
    startData,
    measure,
    measureAsync,
    record,
    dataGrid,
    buffer,
  };
}
