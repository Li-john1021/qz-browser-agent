import type { RendererExtension, ProfileProjection } from "#sdk/sidepanel";
import { isSkillResourceRenderer, resolveSkillToolRenderContext } from "#sdk/sidepanel/skills";
import { createSkillToolProfile } from "./skill-tool-profile.js";
import { createProfileHelpers, resultProfile } from "#sdk/sidepanel/components";
import { createStructuredRenderer } from "#sdk/sidepanel/components";

/** Declarative Skill IR composes shared primitives and capability-owned profiles. */
const contribute: RendererExtension = host => {
  const helpers = createProfileHelpers(host);
  const structuredRenderer = createStructuredRenderer(host);
  const plugin = createSkillToolProfile({ structuredRenderer, render: host.render,
    formatSkillToolHeaderLabel: host.formatSkillToolHeaderLabel });
  const errorInputs: ProfileProjection = (parent, view) => !view.profileFamily
    && resolveSkillToolRenderContext(view.name, view.args, view.result).plugin
    && plugin.renderInputs(parent, view);
  const contribution = { renderers: [
    host.project("plugin", resultProfile((parent, tool, result, originalResult) => plugin.render(parent, tool, result, originalResult),
      (parent, tool, status) => plugin.render(parent, tool, null, null, { status })), {
        renderErrorInputs: errorInputs,
        detailsClass: view => isSkillResourceRenderer(resolveSkillToolRenderContext(view.name, view.args, view.result).renderer) ? "tool-details-skill-edit" : "",
      }),
    helpers.dataTableRenderer.definition,
  ] };
  for (const renderer of contribution.renderers) host.registerRenderer(renderer);
};
export default contribute;
