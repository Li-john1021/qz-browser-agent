import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createSettingsProfiles } from "./data-settings.js";
import { presentations } from "./presentation.js";

export default profileCapability(helpers => {
  const settings = createSettingsProfiles(helpers.appendDataRowsTable);
  return {
    "settings": resultProfile((parent, tool, result, originalResult) => settings.renderSettings(parent, tool, result), settings.renderPreparingSettings),
  };
}, presentations);
