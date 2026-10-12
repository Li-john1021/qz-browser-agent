import assert from "node:assert/strict";
import { registerMcpTools } from "../../src/capabilities/mcp/tools.js";
import { QINGZHOU_MCP_TOOL_SPECS } from "../../src/capabilities/mcp/skill-contract.js";

class ToolExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const definitions = new Map();
const calls = [];
registerMcpTools({
  registerTool({ name, description, parameters, execute }) {
    definitions.set(name, { name, description, parameters, execute });
  },
  ToolExecutionError,
  inspectServer: async (server, options) => {
    calls.push(["inspect", server, options]);
    return {
      server: server.id,
      tools: [{ name: "known" }, { name: "other" }],
    };
  },
  callServerTool: async (server, tool, args, options) => {
    calls.push(["call", server, tool, args, options]);
    return { ok: true, server: server.id, tool, args };
  },
  listSkillMcpServers: async (context, options) => {
    calls.push(["servers", context, options]);
    return [{ id: "docs" }];
  },
  listSkillMcpTools: async (context, options) => {
    calls.push(["tools", context, options]);
    return { tools: [{ name: "search" }], count: 1, errors: [] };
  },
});

assert.deepEqual(
  [...definitions.keys()],
  ["mcp_inspect_server", "mcp_call_tool", "mcp_list_tools", "mcp_search_tools"],
  "MCP family registration order is part of the stable tool catalog",
);
for (const [name, definition] of definitions) {
  assert.equal(definition.description, QINGZHOU_MCP_TOOL_SPECS[name].description);
  assert.equal(definition.parameters, QINGZHOU_MCP_TOOL_SPECS[name].parameters);
}

const signal = new AbortController().signal;
const inspected = await definitions.get("mcp_inspect_server").execute({
  name: "  docs  ",
  url: "https://mcp.test/rpc",
  headers: { Authorization: "secret" },
  refresh: true,
  includeResources: true,
  includePrompts: true,
  limit: 4,
}, signal);
assert.equal(inspected.server, "docs");
assert.deepEqual(calls.at(-1), [
  "inspect",
  {
    id: "docs",
    name: "docs",
    url: "https://mcp.test/rpc",
    headers: { Authorization: "secret" },
    enabled: true,
  },
  {
    refresh: true,
    signal,
    includeResources: true,
    includePrompts: true,
    limit: 4,
  },
]);

const direct = await definitions.get("mcp_call_tool").execute({
  name: "docs",
  tool: "known",
  args: { q: "abc" },
}, signal);
assert.deepEqual(direct, { ok: true, server: "docs", tool: "known", args: { q: "abc" } });

const beforeValidated = calls.length;
await definitions.get("mcp_call_tool").execute({
  name: "docs",
  tool: "known",
  validate: true,
}, signal);
assert.deepEqual(calls.slice(beforeValidated).map(item => item[0]), ["inspect", "call"]);

await assert.rejects(
  () => definitions.get("mcp_call_tool").execute({
    name: "docs",
    tool: "missing",
    validate: true,
  }, signal),
  error => error?.code === "MCP_TOOL_NOT_FOUND"
    && error?.details?.tool === "missing"
    && error?.details?.availableTools?.join(",") === "known,other",
);

const context = { sessionId: "s1" };
const listed = await definitions.get("mcp_list_tools").execute({
  server: "docs",
  activeOnly: true,
  refresh: true,
  limit: 8,
}, signal, context);
assert.deepEqual(listed, {
  ok: true,
  registry: "virtual_skill_mcp_registry",
  servers: [{ id: "docs" }],
  tools: [{ name: "search" }],
  count: 1,
  errors: [],
});
assert.deepEqual(calls.at(-2), ["servers", context, { includeInactive: false }]);
assert.deepEqual(calls.at(-1), ["tools", context, {
  server: "docs",
  refresh: true,
  includeInactive: false,
  limit: 8,
  signal,
}]);

const searched = await definitions.get("mcp_search_tools").execute({
  query: "  library  ",
  activeOnly: false,
}, signal, context);
assert.equal(searched.query, "  library  ");
assert.deepEqual(calls.at(-1), ["tools", context, {
  query: "  library  ",
  server: "",
  refresh: false,
  includeInactive: true,
  limit: undefined,
  signal,
}]);

console.log("MCP tool family tests passed");
