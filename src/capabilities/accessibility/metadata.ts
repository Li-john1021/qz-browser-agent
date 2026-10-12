import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  get_ax_tree: toolMeta(t("inspectPageTree"), ["pageTree"], { shortTitle: t("inspectPageTreeShort"), profileFamily: "pageTree", resultFamily: "page-raw", familyId: "collect", pageContext: true }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;


