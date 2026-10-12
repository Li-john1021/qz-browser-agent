import { modelT } from "./model-messages.js";
import {
  getMcpSkillToolName,
  QINGZHOU_MCP_SKILL_ID,
  QINGZHOU_MCP_TOOL_SPECS,
} from "./skill-contract.js";
import { createSkillHostResources } from "#sdk/shared/skill-definition";

export const BUILTIN_QINGZHOU_MCP_SKILL_NAME = "qingzhou-mcp";
export const getBuiltinQingzhouMcpDisplayName = () => (modelT("mcpDisplayName"));
export const getBuiltinQingzhouMcpDescription = () => (modelT("mcpDescription"));

const INSPECT = getMcpSkillToolName("mcp_inspect_server");
const LIST = getMcpSkillToolName("mcp_list_tools");
const SEARCH = getMcpSkillToolName("mcp_search_tools");
const CALL = getMcpSkillToolName("mcp_call_tool");

export const getBuiltinQingzhouMcpContent = () => (modelT("builtinContent", { SEARCH, LIST, CALL, INSPECT }));

export const getBuiltinQingzhouMcpResources = () => (createSkillHostResources({
  id: QINGZHOU_MCP_SKILL_ID,
  get displayName() { return getBuiltinQingzhouMcpDisplayName(); },
  version: "0.1.0",
  get description() { return getBuiltinQingzhouMcpDescription(); },
  category: { id: "mcp", label: "MCP" },
  tools: QINGZHOU_MCP_TOOL_SPECS,
  get manifestTitle() { return modelT("mcpManifestTitle"); },
  get manifestDescription() { return modelT("mcpManifestDescription"); },
  get scriptDescription() { return modelT("mcpScriptDescription"); },
}));

export default {
  aliases: ["MCP 接入", "MCP integration"],
  name: BUILTIN_QINGZHOU_MCP_SKILL_NAME, get displayName() { return getBuiltinQingzhouMcpDisplayName(); },
  get description() { return getBuiltinQingzhouMcpDescription(); }, get content() { return getBuiltinQingzhouMcpContent(); },
  get resources() { return getBuiltinQingzhouMcpResources(); }, order: 4,
};
