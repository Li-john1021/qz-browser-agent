import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../../", import.meta.url);

function readProjectFile(relativePath) {
  const path = new URL(relativePath, root);
  const sourcePath = existsSync(path) ? path : new URL(relativePath.replace(/\.js$/, ".ts"), root);
  const source = readFileSync(sourcePath, "utf8");
  return sourcePath.pathname.endsWith(".ts") ? stripTypeScriptTypes(source) : source;
}

function sliceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing block start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing block end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertUsesExplicitSessionId(source, marker, operation) {
  const startIndex = source.indexOf(marker);
  assert.notEqual(startIndex, -1, `Missing operation marker: ${marker}`);
  const window = source.slice(startIndex, startIndex + 700);
  assert.match(
    window,
    new RegExp(`requireExplicitSessionId\\([^\\n]+,\\s*"${operation}"\\)`),
    `${operation} must reject missing sessionId instead of falling back to default`,
  );
}

const sessionCommands = readProjectFile("src/background/session/commands.js");
const sessionIds = readProjectFile("src/background/session/id.js");
const sessionAgentHost = readProjectFile("src/background/session/agent-host.js");
const mcpRuntime = readProjectFile("src/background/mcp/mcp-runtime.js");
const sidepanelTransport = readProjectFile("src/background/transports/sidepanel.js");
const browserContext = readProjectFile("src/background/session/browser-context.js");
const sessionTools = readProjectFile("src/capabilities/sessions/tools.js");

assert.match(
  sessionIds,
  /export function requireExplicitSessionId\(sessionId\s*,\s*operation = "request"\)/,
  "the session boundary should expose a strict sessionId validator for run-producing requests",
);

for (const marker of ['case "prompt":', 'case "resend_prompt":', 'case "follow_up":']) {
  assert.notEqual(sidepanelTransport.indexOf(marker), -1, `Missing Side Panel route: ${marker}`);
}
assert.match(sidepanelTransport, /steer_follow_up:\s*\{ method: "sessions.steerFollowUp"/);
assert.match(
  sessionCommands,
  /async function startSessionAgentTask[\s\S]*requireExplicitSessionId\(sessionId, operationName\)/,
  "all run-producing Background API commands should cross the shared strict sessionId boundary",
);
assert.match(sessionCommands, /function startSessionPromptTask[\s\S]*operationName:\s*"prompt"/);
assertUsesExplicitSessionId(sessionCommands, "async function resendSessionMessageRuntime", "resend_prompt");
assertUsesExplicitSessionId(sessionCommands, "async function followUpSessionRuntime", "follow_up");
assertUsesExplicitSessionId(sessionCommands, "async function steerSessionFollowUpRuntime", "steer_follow_up");
assert.match(
  mcpRuntime,
  /async function sendMessage[\s\S]*sessions\.requireId\(params\.sessionId,\s*"send_message"\)/,
  "MCP send_message must reject missing sessionId through the injected strict validator",
);

const collectDynamicContextBody = sliceBetween(
  sessionAgentHost,
  "async function collectDynamicContext(",
  "return Object.freeze({",
);
assert.doesNotMatch(
  collectDynamicContextBody,
  /collectRecentSessionStatuses|context\.sessions/,
  "agent dynamic context should not inject other sessions by default",
);

const collectBrowserContextBody = sliceBetween(
  browserContext,
  "async function collect(",
  "return Object.freeze({ collect });",
);
assert.doesNotMatch(
  collectBrowserContextBody,
  /collectRecentSessionStatuses|context\.sessions/,
  "browser context snapshots should not inject other sessions by default",
);

assert.match(
  sessionTools,
  /registerTool\(\s*\{\s*name:\s*"manage_sessions"[\s\S]*"list"[\s\S]*"last_messages"/,
  "agents should still have explicit session list/read tools when they need other session context",
);

console.log("session request isolation tests passed");
