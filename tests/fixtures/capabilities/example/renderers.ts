import type { RendererExtension } from "#sdk/sidepanel";
import { valueCardRenderer } from "./value-card.js";
import { t } from "./i18n.js";

export default (qz => {
  qz.registerRenderer(valueCardRenderer);
  qz.registerPresentation({
    id: "example.value-card",
    argsSummary: ({ args }) => t("rowSummary", { count: Array.isArray(args.rows) ? args.rows.length : 0 }),
  });
}) satisfies RendererExtension;
