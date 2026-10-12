import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
type Data = Record<string, unknown>;

export function formatGroupTabsArgsPreview(args: Record<string, unknown> = {}, result: unknown = undefined, rawText = "") {
  const data = record(result);
  const tabCount = Number(data.count || (Array.isArray(data.tabIds) ? data.tabIds.length : 0) || (Array.isArray(args.tabIds) ? args.tabIds.length : 0));
  const parts = [
    Number.isFinite(tabCount) && tabCount > 0 ? t("tabCount", { count: String(tabCount) }) : "",
    groupColorLabel(data.color || args.color),
  ].filter(Boolean);
  if (parts.length) return `(${parts.join(" · ")})`;
  return rawText ? t("organizeTabs") : "";
}

export function groupColorLabel(color: unknown = "") {
  const key = String(color || "").trim().toLowerCase();
  const labels: Record<string, string> = {
    grey: t("gray"),
    blue: t("blue"),
    red: t("red"),
    yellow: t("yellow"),
    green: t("green"),
    pink: t("pink"),
    purple: t("purple"),
    cyan: t("cyan"),
    orange: t("orange"),
  };
  return labels[key] ? t("group", { name: String(labels[key]) }) : "";
}

export const presentations: readonly ToolPresentationDefinition[] = [{ id: "group_tabs", argsSummary: ({ args, result, rawArgsText }) => formatGroupTabsArgsPreview(args, result, rawArgsText) }];
