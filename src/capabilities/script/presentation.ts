import { t } from "./i18n.js";
import { getResultEnvelope } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
import type { RendererServices } from "#sdk/sidepanel";
import { isToolResultErrorLike, isPageContextToolName } from "#sdk/sidepanel/presentation";

export const presentations = (host: RendererServices): readonly ToolPresentationDefinition[] => ["run_script", "script"].map(id => ({
  id,
  resultIsError: ({ result }) => {
    const envelope = getResultEnvelope(result);
    return envelope?.ok === true && !isToolResultErrorLike(envelope) ? false : undefined;
  },
  argsSummary: ({ tool, args, result }) => isPageContextToolName(tool)
    ? `(${host.pageDisplayTarget(args, result, { maxLength: 42, fallbackToTabId: false, fallbackLabel: t("currentPage") })})` : undefined,
  timelineBadge: () => ({ label: t("script"), order: 40 }),
  describeRun: ({ args, surface }) => String(args.target || "").trim().toLowerCase() === "inner"
    ? surface === "timeline" ? t("executeInternalCode") : t("executeInternalScript")
    : surface === "timeline" ? t("executeCode") : t("executePageScript"),
  compactParams: ({ args }) => { const { code: _, ...rest } = args; return rest; },
}));
