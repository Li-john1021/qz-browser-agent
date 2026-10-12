import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  mcp_inspect_server: mcpTool(t("probeMcp"), t("probeMcpShort")),
  mcp_list_tools: mcpTool(t("viewMcp"), t("viewMcpShort")),
  mcp_search_tools: mcpTool(t("searchMcp"), t("searchMcpShort")),
  mcp_call_tool: mcpTool(t("callMcp"), t("callMcpShort")),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

function mcpTool(title: string, shortTitle?: string) {
  return toolMeta(title, ["mcp"], {
    shortTitle,
    profileFamily: "mcp",
    resultFamily: "mcp",
    familyId: "mcp",
  });
}
