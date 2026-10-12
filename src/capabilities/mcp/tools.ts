import { t } from "./i18n.js";
import type { ToolExtension, ToolExtensionAPI } from "#sdk/background";
import type { ToolArguments } from '#sdk/background';
type McpToolsHost = Pick<ToolExtensionAPI,
  "registerTool" | "ToolExecutionError" | "inspectServer" | "callServerTool"
  | "listSkillMcpServers" | "listSkillMcpTools">;
import { QINGZHOU_MCP_TOOL_SPECS } from "./skill-contract.js";

/** Registers the MCP discovery and invocation family against the core ToolRuntime. */
export function registerMcpTools({
  registerTool,
  ToolExecutionError,
  inspectServer,
  callServerTool,
  listSkillMcpServers,
  listSkillMcpTools,
}: McpToolsHost) {
  registerTool({
  name: "mcp_inspect_server",
  get description() { return QINGZHOU_MCP_TOOL_SPECS.mcp_inspect_server.description; },
  get parameters() { return QINGZHOU_MCP_TOOL_SPECS.mcp_inspect_server.parameters; },
  hidden: true,
  execute: async ({
      url = "",
      name = "adhoc",
      headers = {},
      refresh = false,
      includeResources = false,
      includePrompts = false,
      limit = 100,
    }, signal) => {
      const id = String(name || "adhoc").trim() || "adhoc";
      return inspectServer(
        { id, name: id, url, headers, enabled: true },
        { refresh, signal, includeResources, includePrompts, limit },
      );
    },
});

  async function executeCall({
    url = "",
    name = "adhoc",
    headers = {},
    tool = "",
    args = {},
    validate = false,
    refresh = false,
  }: ToolArguments<typeof QINGZHOU_MCP_TOOL_SPECS.mcp_call_tool.parameters>, signal?: AbortSignal) {
    const id = String(name || "adhoc").trim() || "adhoc";
    const server = { id, name: id, url, headers, enabled: true };
    const toolName = String(tool || "").trim();
    if (validate === true) {
      const metadata = await inspectServer(server, { refresh, signal, limit: 1000 });
      if (!metadata.tools.some(item => item.name === toolName)) {
        throw new ToolExecutionError("MCP_TOOL_NOT_FOUND", t("mcpToolNotFoundOnServer", { name: String(toolName) }), {
          server: metadata.server,
          tool: toolName,
          availableTools: metadata.tools.map(item => item.name),
        });
      }
    }
    return callServerTool(server, toolName, args, { signal });
  }

  registerTool({
  name: "mcp_call_tool",
  get description() { return QINGZHOU_MCP_TOOL_SPECS.mcp_call_tool.description; },
  get parameters() { return QINGZHOU_MCP_TOOL_SPECS.mcp_call_tool.parameters; },
  hidden: true,
  execute: executeCall,
});

  registerTool({
  name: "mcp_list_tools",
  get description() { return QINGZHOU_MCP_TOOL_SPECS.mcp_list_tools.description; },
  get parameters() { return QINGZHOU_MCP_TOOL_SPECS.mcp_list_tools.parameters; },
  hidden: true,
  execute: async ({ server = "", refresh = false, activeOnly = false, limit }, signal, context = {}) => {
      const includeInactive = activeOnly !== true;
      const servers = await listSkillMcpServers(context, { includeInactive });
      const tools = await listSkillMcpTools(context, {
        server,
        refresh,
        includeInactive,
        limit,
        signal,
      });
      return {
        ok: true,
        registry: "virtual_skill_mcp_registry",
        servers,
        tools: tools.tools,
        count: tools.count,
        errors: tools.errors,
      };
    },
});

  registerTool({
  name: "mcp_search_tools",
  get description() { return QINGZHOU_MCP_TOOL_SPECS.mcp_search_tools.description; },
  get parameters() { return QINGZHOU_MCP_TOOL_SPECS.mcp_search_tools.parameters; },
  hidden: true,
  execute: async ({ query, server = "", refresh = false, activeOnly = false, limit }, signal, context = {}) => {
      const includeInactive = activeOnly !== true;
      const tools = await listSkillMcpTools(context, {
        query,
        server,
        refresh,
        includeInactive,
        limit,
        signal,
      });
      return {
        ok: true,
        registry: "virtual_skill_mcp_registry",
        query: String(query || ""),
        tools: tools.tools,
        count: tools.count,
        errors: tools.errors,
      };
    },
});
}


export default registerMcpTools satisfies ToolExtension;
