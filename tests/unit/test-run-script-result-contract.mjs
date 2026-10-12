import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileInnerWorker } from "../../scripts/build-extension.mjs";
import { runInnerWorker } from "../support/inner-runner-fixture.mjs";
import { wrapRunScriptSource } from "../../src/shared/run-script-source.js";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const source = [
  readSource("src/background/tools/runtime.js"),
  readSource("src/capabilities/script/tools.js"),
].join("\n");
const manifest = readSource("src/manifest.json");
const offscreen = transformSync(readSource("src/offscreen.ts"), { loader: "ts" }).code;
const sandbox = transformSync(readSource("src/runner-sandbox.ts"), { loader: "ts" }).code;
const sidepanel = readSource("src/sidepanel/sidepanel.js");
const dataStore = readSource("src/shared/data-store.ts");
const serviceWorker = readSource("src/background/service-worker.js");
const runScriptBridge = readSource("src/background/tools/run-script-bridge.js");
const manifestJson = JSON.parse(manifest);
const innerWorkerSource = readFileSync(join(root, "src/workers/inner-runner.ts"), "utf8");
const compiledWorker = await compileInnerWorker();
const scriptRuntimeSource = readSource("src/shared/script-runtime.ts");
const innerWorkerWrapperLine = innerWorkerSource.split("\n").find(line => line.includes('new Function("input"')) || "";

assert.doesNotMatch(source, /MAX_SCRIPT_RESULT_CHARS/, "run_script should not enforce a result-size truncation threshold");
assert.doesNotMatch(source, /json\.length\s*<=\s*MAX_CHARS\s*\?\s*JSON\.parse\(json\)/, "run_script should not stringify large results into truncated text");
assert.doesNotMatch(source, /runScriptWithScriptingBridge/, "run_script should not keep a chrome.scripting fallback helper");
assert.doesNotMatch(source, /cdp_fallback|scripting fallback failed/, "run_script should not expose scripting fallback behavior");
assert.match(source, /function makePageContextUnavailableResult\(/, "run_script should use an explicit page-context unavailable result");
assert.match(source, /error:\s*"page_context_unavailable"/, "page-context failure should have a stable agent-readable error");
assert.match(source, /execution_world:\s*"page"/, "run_script results should state the page execution world");
assert.match(source, /execution_world:\s*"inner"/, "inner run_script results should state the inner execution world");
assert.deepEqual(manifestJson.sandbox?.pages, ["runner-sandbox.html"], "manifest should register the inner runner sandbox page");
assert.match(manifestJson.content_security_policy?.sandbox || "", /unsafe-eval[\s\S]*worker-src blob:/, "manifest should provide a sandboxed eval-capable worker host for inner run_script");
assert.match(offscreen, /run_script_inner_ping/, "offscreen should expose an inner runner ready ping");
assert.match(offscreen, /runner-sandbox\.html/, "offscreen should host the sandbox runner page");
assert.match(offscreen, /run_script_inner_execute[\s\S]*run_script_tool_call/s, "offscreen should execute inner scripts and relay tool calls through the existing bridge");
assert.match(offscreen, /run_script_inner_fetch[\s\S]*fetch_response/s, "offscreen should relay standard Skill fetch calls through the background boundary");
assert.match(offscreen, /event\.source !== sandboxFrame\.contentWindow/, "offscreen should accept sandbox messages only from its owned iframe window");
assert.match(sandbox, /event\.source !== parent/, "sandbox should accept host messages only from its parent window");
assert.match(offscreen, /run_script_inner_fetch_cancel/, "offscreen should relay per-request fetch cancellation to Background");
assert.match(offscreen, /sendResponse\(\{\s*ok:\s*true,\s*accepted:\s*true[\s\S]*publishInnerRunResult/s, "offscreen should ack inner execute immediately and publish results separately");
assert.match(source, /handleRunScriptInnerRuntimeMessage[\s\S]*run_script_inner_result[\s\S]*pending\.resolve\(msg\.result\)/s, "background should resolve the real inner envelope, not wrap it in a transport ack");
assert.doesNotMatch(source, /pending\.resolve\(\{\s*ok:\s*true,\s*result:\s*msg\.result\s*\}\)/, "inner transport ack must not leak into the run_script result protocol");
assert.match(source, /const envelope = record\(response\);[\s\S]*compactRunScriptEnvelope\(envelope,\s*"offscreen_inner"\)/, "inner runner should consume the resolved response as the final run_script envelope");
assert.match(source, /runScriptInnerPendingByRequestId/, "background should own inner runner pending requests instead of waiting on offscreen sendResponse");
assert.match(source, /const runScriptInnerPendingByRequestId = .*new Map\(\)/, "background should isolate concurrent inner runs by request id");
assert.match(offscreen, /const pendingRuns = .*new Map\(\)/, "offscreen should isolate concurrent inner runs by request id");
assert.match(sandbox, /const workers = .*new Map\(\)/, "sandbox should isolate concurrent inner workers by request id");
assert.match(sandbox, /workers\.set\(requestId,\s*worker\)/, "sandbox should track each inner worker independently");
assert.match(sandbox, /workers\.delete\(requestId\)[\s\S]*worker\.terminate\(\)/, "sandbox should clean up the completed worker for the matching request id");
assert.match(offscreen, /scriptSource:\s*String\(msg\.source \|\| ""\)/, "offscreen should not send script code through the message routing source field");
assert.match(sandbox, /source:\s*String\(data\.scriptSource \|\| ""\)/, "sandbox should read script code from scriptSource so routing source remains stable");
assert.match(sandbox, /URL\.createObjectURL\(new Blob\(\[INNER_WORKER_SOURCE\][\s\S]*new Worker\(workerUrl\)/, "sandbox should execute inner scripts in a terminable worker");
assert.match(innerWorkerSource, /new Function\("input", "args", "\$plugin", "tools", "tool", "trace", "log", "tabId"/, "inner worker should expose Skill config as a first-class script binding");
assert.match(innerWorkerSource, /if \(payload\.fetchBridge === true\) self\.fetch = createBridgedFetch/, "plugin inner scripts should keep the standard fetch call surface");
assert.match(innerWorkerSource, /signal\?\.addEventListener\?\.\("abort", abort/, "the bridged fetch surface should preserve per-request AbortSignal cancellation");
assert.match(innerWorkerSource, /type: "fetch_cancel"/, "the inner worker should cancel only its matching Background fetch call");
assert.match(innerWorkerSource, /import \{ safeValueForMessage, installSecurityGuards \} from "\.\.\/shared\/script-runtime\.js"/, "inner worker should share the serializer and security implementation");
assert.match(scriptRuntimeSource, /function safeValueForMessage\(/, "shared script runtime should own dynamic value serialization");
assert.match(innerWorkerSource, /const safeToolArgs = safeValueForMessage\(toolArgs\)/, "inner worker should sanitize tool args before crossing postMessage");
assert.match(innerWorkerSource, /const safeResult = ok && result !== undefined \? safeValueForMessage\(result\) : null/, "inner worker should sanitize returned script results before crossing postMessage");
assert.match(source, /const __qzSafeValueForMessage = value => QZ_SCRIPT_RUNTIME\.safeValueForMessage\(value, "page"\)/, "page runtime should select page serialization semantics from the compiled shared runtime");
assert.match(source, /QZ_SCRIPT_RUNTIME\.installSecurityGuards\(__qzSecurityGuardrails, "page"\)/, "page runtime should install the shared guard with page semantics");
assert.match(source, /const safeInput = __qzSafeValueForMessage\(input \|\| \{\}\)/, "page runtime should sanitize tool args before window.postMessage");
assert.match(source, /const __qzSafeResult = ok && result !== undefined \? __qzSafeValueForMessage\(result\) : null/, "page runtime should sanitize returned script results before CDP serialization");
assert.match(runScriptBridge, /function failureResponse\(/, "run_script tool bridge should have one failure response contract");
assert.match(runScriptBridge, /const respondFailure[\s\S]*withLanguage\(language, \(\) => failureResponse\(payload, options\)\)/, "run language scopes must retain the shared failure response contract");
assert.match(runScriptBridge, /const isError = output.ok === false \|\| output.isError === true \|\| output.error != null[\s\S]*await applyNestedToolResult\([\s\S]*if \(isError\)[\s\S]*respondFailure\(result/, "run_script tool bridge should record and reject tool failure payloads instead of resolving error objects");
assert.match(runScriptBridge, /catch \(error\)[\s\S]*return respondFailure\(/, "run_script tool bridge should reject thrown tool errors");
assert.doesNotMatch(serviceWorker, /ok:\s*true,\s*[\r\n\s]*result:\s*localizeToolFailurePayload\(\{[\s\S]*RUN_SCRIPT_TOOL_CALL_FAILED/, "run_script tool bridge must not wrap failed tool calls as successful responses");
assert.match(source, /if \(!response\.ok\)[\s\S]*reject\(bridgeError\)/, "page run_script tools should reject failed bridge responses");
assert.match(innerWorkerSource, /if \(!response\.ok\)[\s\S]*call\.reject\(error\)/, "inner run_script tools should reject failed bridge responses");
for (const [name, text] of Object.entries({ tools: source, offscreen, sandbox, sidepanel, dataStore })) {
  assert.doesNotMatch(text, /console\.info/, `${name} should not keep console.info debug logs`);
}
assert.doesNotMatch(source, /\[run_script:inner\]/, "inner runner should not write normal lifecycle events into the global LLM console trace");
assert.doesNotThrow(() => new Function(compiledWorker), "inner worker source embedded in the sandbox must be syntactically valid");
assert.ok(innerWorkerWrapperLine.includes('{\\n" + source + "\\n})();'), "inner worker wrapper should use one newline escape layer, not literal backslash-n code");
assert.doesNotMatch(innerWorkerWrapperLine, /\{\\\\n" \+ source \+ "\\\\n/, "inner worker wrapper must not double-escape newline separators");
assert.doesNotThrow(() => {
  const innerSmokeSource = wrapRunScriptSource(`async () => {
 return { ok: true, message: "Hello World!轻舟 inner环境正常运行 ✅", timestamp: new Date().toISOString() };
}`);
  const body = `"use strict"; return (async () => {\n${innerSmokeSource}\n})();`;
  new Function("input", "args", "$plugin", "tools", "tool", "trace", "log", "tabId", body);
}, "inner worker wrapper should accept a normal async arrow script with Chinese text and emoji inside strings");
{
  const { result: envelope } = await runInnerWorker(compiledWorker, `
    const cycle = { name: 'cycle' }; cycle.self = cycle;
    return { fn: function namedUnsafe() {}, symbol: Symbol('unsafe'), bigint: 9007199254740993n,
      date: new Date('2026-07-09T00:00:00.000Z'), regexp: /qingzhou/gi,
      map: new Map([['fn', () => 'map']]), set: new Set([Symbol('set')]),
      proxy: new Proxy({}, { ownKeys() { throw new Error('bad ownKeys'); } }), cycle };
  `);
  assert.equal(envelope.ok, true);
  const safe = envelope.result;
  assert.equal(safe.fn.__qz_uncloneable, 'function');
  assert.equal(safe.symbol.__qz_uncloneable, 'symbol');
  assert.equal(safe.bigint, '9007199254740993');
  assert.equal(safe.proxy.__qz_uncloneable, 'object');
  assert.equal(safe.cycle.self.__qz_circular, true);
  assertCloneSafe(envelope, 'inner sanitized envelope');
}

assert.ok(
  (source.match(/world:\s*"ISOLATED"/g) || []).length >= 2,
  "internal chrome.scripting bridges should execute in the isolated world so page CSP cannot block bridge code",
);

console.log("run_script result contract tests passed");

function readSource(path) {
  const sourcePath = existsSync(join(root, path)) ? path : path.replace(/\.js$/, ".ts");
  const source = readFileSync(join(root, sourcePath), "utf8");
  return sourcePath.endsWith(".ts") ? transformSync(source, { loader: "ts", charset: "utf8" }).code : source;
}

function assertCloneSafe(value, label) {
  if (typeof structuredClone === "function") {
    assert.doesNotThrow(() => structuredClone(value), `${label} should be structured-clone safe`);
  }
  assert.doesNotThrow(() => JSON.stringify(value), `${label} should be JSON safe for extension messaging`);
}
