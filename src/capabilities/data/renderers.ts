import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createDataProfiles } from "./data-settings.js";
import { presentations } from "./presentation.js";

export default profileCapability(helpers => {
  const data = createDataProfiles(helpers.appendDataRowsTable);
  return {
    "data": resultProfile((parent, tool, result, originalResult) => data.renderData(parent, tool.args, result), data.renderPreparingData),
  };
}, presentations);
