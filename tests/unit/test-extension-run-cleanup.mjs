import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("one failing extension cleanup cannot skip later cleanups or retain the run's debugger lease", async t => {
  const previous = new Map(["chrome", "__qzCleanupCalls", "__qzDebug"].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const debuggerCalls = [], cleanupCalls = [], events = [];
  globalThis.__qzCleanupCalls = { push(event) { cleanupCalls.push(event); events.push(event); } };
  globalThis.chrome = {
    storage: { local: { get: async () => ({}) } },
    tabs: { get: async id => ({ id, url: "https://example.test/", title: "Example" }) },
    debugger: {
      onDetach: { addListener() {} },
      async attach(target) { debuggerCalls.push(["attach", target.tabId]); events.push(["attach", target.tabId]); },
      async detach(target) { debuggerCalls.push(["detach", target.tabId]); events.push(["detach", target.tabId]); },
      async sendCommand(_target, method) { return { method }; },
    },
  };
  // Use the real host assembly and CDP runtime; only the discovered extension list is replaced.
  const result = await build({
    absWorkingDir: ROOT, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022",
    stdin: { resolveDir: ROOT, contents: `export { createToolRuntime, releaseRunCdp } from './src/background/tools/runtime.ts';
      export { getTraceLog } from './src/background/trace.ts';` },
    plugins: [{ name: "cleanup-extension-fixture", setup(builder) {
      builder.onResolve({ filter: /^#capabilities\/tools$/ }, () => ({ path: "tools", namespace: "cleanup-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "cleanup-fixture" }, () => ({ contents: `export default [
        { id: "first", setup: qz => {
          qz.registerTool({ name: 'cleanup_probe', description: 'Acquire one run-owned debugger lease',
            parameters: { type: 'object', properties: {} },
            execute: (_args, _signal, context) => qz.withDebugger(7, (_target, send) => send('Page.enable'), context) });
          return { releaseRun(sessionId, runId) { globalThis.__qzCleanupCalls.push(['first', sessionId, runId]); throw new Error('extension cleanup failed'); } };
        } },
        { id: "second", setup: () => ({ releaseRun(sessionId, runId) { globalThis.__qzCleanupCalls.push(['second', sessionId, runId]); } }) },
      ];`, loader: "js" }));
    } }],
  });
  const directory = await mkdtemp(join(tmpdir(), "qz-cleanup-host-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bundle = join(directory, "host.mjs");
  await writeFile(bundle, result.outputFiles[0].text);
  const module = await import(pathToFileURL(bundle).href);
  const runtime = module.createToolRuntime({ sessions: {
    isRunCurrent: () => true,
    resolveTargetTab: async () => ({ ok: true, ownedByCurrentTask: true }),
  } });
  await runtime.execute("cleanup_probe", {}, undefined, { sessionId: "session-a", runId: "run-a" });
  assert.deepEqual(debuggerCalls, [["attach", 7]], "the extension acquired a real run-owned lease");
  assert.deepEqual(await module.releaseRunCdp("session-a", "run-a"), { released: 1, tabIds: [7] });
  assert.deepEqual(cleanupCalls, [["first", "session-a", "run-a"], ["second", "session-a", "run-a"]]);
  assert.deepEqual(debuggerCalls, [["attach", 7], ["detach", 7]]);
  assert.deepEqual(events, [["attach", 7], ["first", "session-a", "run-a"], ["second", "session-a", "run-a"], ["detach", 7]],
    "the host releases CDP only after every extension cleanup has been attempted");
  assert.ok((await module.getTraceLog()).some(line => line.includes("run cleanup failed") && line.includes("error=extension_cleanup_failed")));
});
