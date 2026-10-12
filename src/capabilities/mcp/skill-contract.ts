import { modelT } from "./model-messages.js";
export const QINGZHOU_MCP_SKILL_ID = "qingzhou-mcp";
export const QINGZHOU_MCP_RUNTIME_PREFIX = "qingzhou_mcp";

export const MCP_TOOL_CORE_NAMES = Object.freeze([
  "mcp_inspect_server",
  "mcp_list_tools",
  "mcp_search_tools",
  "mcp_call_tool",
]);

const MCP_TOOL_CORE_NAME_SET = new Set(MCP_TOOL_CORE_NAMES);

export function getMcpSkillToolName(coreName = "") {
  const name = String(coreName || "").trim();
  if (!MCP_TOOL_CORE_NAME_SET.has(name)) return "";
  return `${QINGZHOU_MCP_RUNTIME_PREFIX}__${name}`;
}

export const QINGZHOU_MCP_TOOL_SPECS = Object.freeze({
  mcp_inspect_server: Object.freeze({
    get description() { return modelT("mcpInspectServer"); },
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", get description() { return modelT("mcpUrl"); } },
        name: { type: "string", get description() { return modelT("mcpName"); } },
        headers: { type: "object", get description() { return modelT("mcpHeaders"); }, additionalProperties: { type: "string" } },
        refresh: { type: "boolean", get description() { return modelT("mcpRefreshMetadata"); } },
        includeResources: { type: "boolean", get description() { return modelT("mcpIncludeResources"); } },
        includePrompts: { type: "boolean", get description() { return modelT("mcpIncludePrompts"); } },
        limit: { type: "number", get description() { return modelT("mcpMetadataLimit"); } },
      },
      required: ["url"],
    },
  } as const),
  mcp_list_tools: Object.freeze({
    get description() { return modelT("mcpListTools"); },
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", get description() { return modelT("mcpServerFilter"); } },
        refresh: { type: "boolean", get description() { return modelT("mcpRefreshTools"); } },
        activeOnly: { type: "boolean", get description() { return modelT("mcpListActiveOnly"); } },
        limit: { type: "number", get description() { return modelT("mcpToolLimit"); } },
      },
    },
  } as const),
  mcp_search_tools: Object.freeze({
    get description() { return modelT("mcpSearchTools"); },
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", get description() { return modelT("mcpQuery"); } },
        server: { type: "string", get description() { return modelT("mcpServerReference"); } },
        refresh: { type: "boolean", get description() { return modelT("mcpRefreshSearch"); } },
        activeOnly: { type: "boolean", get description() { return modelT("mcpSearchActiveOnly"); } },
        limit: { type: "number", get description() { return modelT("mcpToolLimit"); } },
      },
      required: ["query"],
    },
  } as const),
  mcp_call_tool: Object.freeze({
    get description() { return modelT("mcpCallTool"); },
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", get description() { return modelT("mcpUrl"); } },
        name: { type: "string", get description() { return modelT("mcpName"); } },
        headers: { type: "object", get description() { return modelT("mcpHeaders"); }, additionalProperties: { type: "string" } },
        tool: { type: "string", get description() { return modelT("mcpToolName"); } },
        args: { type: "object", get description() { return modelT("mcpArguments"); }, additionalProperties: true },
        validate: { type: "boolean", get description() { return modelT("mcpValidate"); } },
        refresh: { type: "boolean", get description() { return modelT("mcpRefreshCall"); } },
      },
      required: ["url", "tool"],
    },
  } as const),
});

