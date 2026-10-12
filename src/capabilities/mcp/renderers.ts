import type { RendererExtension } from "#sdk/sidepanel";
import { resultProfile } from "#sdk/sidepanel/components";
import { createStructuredRenderer } from "#sdk/sidepanel/components";
import { normalizeMcpRendererData, stripSkillMeta } from "#sdk/sidepanel/components";
import { createMcpProfile } from "./profile.js";
const contribute: RendererExtension = host => {
  const structured = createStructuredRenderer(host);
  const mcp = createMcpProfile({ appendJsonCodeBlock: host.generic.appendJsonCodeBlock,
    renderStructured: structured.render, normalizeRendererData: normalizeMcpRendererData, stripSkillMetadata: stripSkillMeta });
  const contribution = { renderers: [
    host.project("mcp", resultProfile((parent, tool, result, originalResult) => mcp.render(parent, tool, result, originalResult))),
    host.project("plugin-mcp", (parent, tool) => mcp.renderCall(parent, tool.name, tool.args, tool.result)),
  ] };
  for (const renderer of contribution.renderers) host.registerRenderer(renderer);
};
export default contribute;
