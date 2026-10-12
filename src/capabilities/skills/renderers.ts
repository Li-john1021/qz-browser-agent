import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { record } from "#sdk/sidepanel/presentation";
import { resolveSkillToolRenderContext } from "#sdk/sidepanel/skills";
import { skillResultData } from "#sdk/sidepanel/components";
import { createSkillProfiles } from "./profile.js";
import { presentations } from "./presentation.js";

export default profileCapability(helpers => {
  const skills = createSkillProfiles(helpers);
  return {
    "plugin-skill": (parent, tool) => {
      const context = resolveSkillToolRenderContext(tool.name, tool.args, tool.result, tool.originalResult);
      const renderer = context.renderer || {};
      const names: Record<string, string> = { create: "create_skill", edit_resource: "edit_skill_resource", update: "update_skill", delete: "delete_skill" };
      const name = names[String(renderer.action || "").trim().toLowerCase()];
      if (!name) return false;
      if (tool.isRunning && !tool.hasResult) {
        const state = tool.state === "preparing" ? "preparing" : "running";
        return skills.renderPreparing(parent, { ...tool, name }, tool.status, record(record(renderer.states)[state] || record(renderer.states).preparing));
      }
      return skills.render(parent, name, tool.args, skillResultData(tool.result, tool.originalResult, context.plugin),
        { state: record(record(renderer.states).completed) });
    },
    "skill": resultProfile((parent, tool, result, originalResult) => skills.render(parent, tool.name, tool.args, result), (parent, tool, status) => ["create_skill", "edit_skill_resource", "update_skill"].includes(tool.name) && skills.renderPreparing(parent, tool, status)),
  };
}, presentations);
