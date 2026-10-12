import type { SkillExtensionAPI } from "#sdk/shared/skill-definition";
import { modelT } from "./model-messages.js";

/** Content-only Skills need no background host or privileged tool binding. */
export default function (qz: SkillExtensionAPI) {
  qz.registerSkill({
    name: "example-reading-guide",
    aliases: ["示例阅读指南", "Example reading guide"],
    get displayName() { return modelT("skillName"); },
    get description() { return modelT("skillDescription"); },
    get content() { return modelT("skillContent"); },
    get resources() { return [{
      path: "references/outline.md",
      type: "reference",
      content: modelT("skillOutline"),
    }]; },
  });
}
