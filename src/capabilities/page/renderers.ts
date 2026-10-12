import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createPageProfiles } from "./browser-operations.js";
import { pagePresentations } from "./presentation.js";

export default profileCapability(helpers => {
  const page = createPageProfiles(helpers);
  return {
    "element": resultProfile((parent, tool, result, originalResult) => page.renderElement(parent, tool.name, tool.args, result)),
    "article": resultProfile((parent, tool, result, originalResult) => page.renderArticle(parent, tool.args, result)),
    "domRaw": resultProfile((parent, tool, result, originalResult) => page.renderDomRaw(parent, tool.args, result)),
    "css": resultProfile((parent, tool, result, originalResult) => page.renderCss(parent, tool.args, result)),
    "domMutation": resultProfile((parent, tool, result, originalResult) => page.renderDomMutation(parent, tool.args, result)),
  };
}, pagePresentations);
