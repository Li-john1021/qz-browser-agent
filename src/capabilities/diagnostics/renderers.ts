import { t } from "./i18n.js";
import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createDiagnosticProfiles } from "./browser-operations.js";

export default profileCapability(helpers => {
  const diagnostics = createDiagnosticProfiles(helpers);
  return {
    "console": resultProfile((parent, tool, result, originalResult) => diagnostics.renderConsole(parent, tool.args, result)),
    "network": resultProfile((parent, tool, result, originalResult) => diagnostics.renderNetwork(parent, tool.name, tool.args, result)),
  };
}, [
  { id: "console", timelineGroupTitle: () => ({ label: t("networkAndLogDiagnostics"), order: 40 }) },
  { id: "labeler:networkBody", timelineGroupTitle: () => ({ label: t("networkAndLogDiagnostics"), order: 40 }),
    timelineBadge: () => ({ label: t("responseBody"), order: 30 }) },
]);
