import { t } from "./i18n.js";
import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createTreeProfiles } from "./browser-content.js";

export default profileCapability(helpers => {
  const tree = createTreeProfiles(helpers);
  return {
    "pageTree": resultProfile((parent, tool, result, originalResult) => tree.renderPageTree(parent, tool.name, tool.args, result)),
  };
}, [{ id: "pageTree", timelineGroupTitle: () => ({ label: t("pageInspection"), order: 50 }),
  timelineBadge: () => ({ label: "DOM", order: 20 }) }]);
