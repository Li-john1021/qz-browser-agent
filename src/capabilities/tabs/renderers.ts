import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createNavigationProfiles } from "./browser-content.js";
import { createTabProfiles } from "./browser-operations.js";
import { presentations } from "./presentation.js";

export default profileCapability(helpers => {
  const navigation = createNavigationProfiles(helpers);
  const tabs = createTabProfiles(helpers);
  return {
    "navigation": resultProfile((parent, tool, result, originalResult) => navigation.renderNavigation(parent, tool.name, tool.args, result)),
    "tabs": resultProfile((parent, tool, result, originalResult) => tabs.renderTabs(parent, tool.name, tool.args, result)),
  };
}, presentations);
