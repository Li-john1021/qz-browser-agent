import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createBookmarkProfiles } from "./browser-operations.js";

export default profileCapability(helpers => {
  const bookmarks = createBookmarkProfiles(helpers);
  return {
    "library": resultProfile((parent, tool, result, originalResult) => bookmarks.renderLibrary(parent, tool.name, tool.args, result)),
  };
});
