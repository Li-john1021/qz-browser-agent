import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
type Data = Record<string, unknown>;

import type { RendererServices } from "#sdk/sidepanel";
export function pagePresentations(host: RendererServices): readonly ToolPresentationDefinition[] {
  return [{ id: "article", timelineTarget: ({ args, result }) => host.pageDisplayTarget(args, result, { maxLength: 36, fallbackToTabId: false }) },
    ...["css", "domMutation"].map(id => ({ id, timelineBadge: () => ({ label: t("script"), order: 40 }) })), { id: "read_article", argsSummary: ({ args, result, rawArgsText }) => {
    const target = host.pageDisplayTarget(args, presentation.unwrapResultValue(presentation.normalizeFriendlyValue(result)).value, { maxLength: 42, fallbackToTabId: false });
    return target ? `(${target})` : rawArgsText ? t("argumentCharacters", { count: String(rawArgsText.length) }) : "";
  }, describeRun: ({ surface }) => surface === "details" ? t("article") : undefined }];
}
