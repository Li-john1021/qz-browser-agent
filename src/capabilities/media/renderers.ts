import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createImageProfiles } from "./browser-content.js";
import { presentations } from "./presentation.js";

export default profileCapability(helpers => {
  const images = createImageProfiles(helpers);
  return {
    "image": resultProfile((parent, tool, result, originalResult) => images.renderImage(parent, tool.name, tool.args, result)),
  };
}, presentations);
