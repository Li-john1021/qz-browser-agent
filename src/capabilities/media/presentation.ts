import { t } from "./i18n.js";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
import { summarizeValue } from "#sdk/sidepanel/presentation";
export const presentations: readonly ToolPresentationDefinition[] = [
  { id: "media:capture", timelineGroupTitle: () => ({ label: t("pageInspection"), order: 50 }) },
  { id: "image_assets", timelineVisibility: "hidden" },
  { id: "screenshot", describeRun: ({ surface }) => surface === "details" ? t("screenshot") : undefined },
  { id: "read_image", describeRun: ({ surface }) => surface === "details" ? t("image") : undefined, compactParams: ({ args }) =>
    Object.fromEntries(Object.entries(args).filter(([key]) => ["url", "selector", "src", "method"].includes(key))) },
  { id: "collect_images", compactParams: ({ args }) => typeof args.urls === "string" ? { ...args, urls: summarizeValue(args.urls, 80) } : undefined },
];
