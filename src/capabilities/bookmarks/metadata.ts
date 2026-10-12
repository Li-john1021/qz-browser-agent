import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  manage_bookmarks: toolMeta(t("manageBookmarks"), ["library"], { shortTitle: t("manageBookmarksShort"), profileFamily: "library", resultFamily: "bookmark", familyId: "collect" }),
  browse_history: toolMeta(t("browsingHistory"), ["library"], { shortTitle: t("browsingHistoryShort"), profileFamily: "library", resultFamily: "bookmark", familyId: "collect" }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;


