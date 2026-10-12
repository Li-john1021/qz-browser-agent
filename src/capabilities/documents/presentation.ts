import { t } from "./i18n.js";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
import { getToolTimelineFamilyInfo } from "#sdk/sidepanel/presentation";
export const presentations: readonly ToolPresentationDefinition[] = [{
  id: "document", timelineGroupTitle: ({ tool }) => getToolTimelineFamilyInfo(tool).id === "artifact"
    ? { label: t("createADocumentFromWebSources"), order: 20 } : { label: t("readDocuments"), order: 30 },
}, {
  id: "save_file", compactParams: ({ args }) => { const { content: _, ...rest } = args; return rest; },
}];
