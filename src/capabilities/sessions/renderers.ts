import { profileCapability, resultProfile } from "#sdk/sidepanel/components";
import { createSessionProfiles } from "./browser-operations.js";
import { createSessionDetails } from "./session-details.js";
import { presentations } from "./presentation.js";

export default profileCapability((helpers, host) => {
  const sessions = createSessionProfiles(helpers);
  const details = createSessionDetails({ ...host.generic, formatDuration: helpers.formatDurationMsForUi });
  return {
    "sessions": resultProfile((parent, tool, result, originalResult) => sessions.renderSessions(parent, tool.args, result), details.preparing),
  };
}, presentations);
