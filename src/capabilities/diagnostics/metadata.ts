import { t } from "./i18n.js";
import { defineToolMetadata as toolMeta } from "#sdk/shared/metadata";
import type { ToolMetadata } from "#sdk/shared/metadata";
import type { CapabilityMetadata } from "#sdk/shared/metadata";

const tools = () => Object.freeze({
  network_watch: networkTool(t("monitorNetwork")),
  network_recent: networkTool(t("viewNetworkRequests"), { shortTitle: t("viewNetworkRequestsShort") }),
  network_body: networkTool(t("readResponseBody"), { shortTitle: t("readResponseBodyShort"), labelerId: "networkBody", titleRule: { field: "bodyType", defaultTitle: t("readResponseBodyShort"), values: { request: t("readRequestBodyShort") } } }),
  read_console_messages: toolMeta(t("viewConsole"), ["console"], { profileFamily: "console", resultFamily: "network", familyId: "process", pageContext: true }),
});

export default { get tools() { return tools(); } } satisfies CapabilityMetadata;

function networkTool(title: string, options: Partial<ToolMetadata> = {}) {
  return toolMeta(title, [], {
    shortTitle: options.shortTitle,
    profileFamily: "network",
    resultFamily: "network",
    familyId: "process",
    labelerId: options.labelerId, titleRule: options.titleRule,
    pageContext: options.pageContext !== false,
  });
}
