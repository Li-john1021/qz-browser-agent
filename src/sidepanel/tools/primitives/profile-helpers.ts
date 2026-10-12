import type { ToolPresentationDefinition } from "../tool-presentation.js";
import type { RendererExtension, RendererServices, ProfileProjection } from "../../../sdk/sidepanel/renderers.js";
import type { ToolView } from "../renderer-host.js";
import { summarizeValue } from "../generic-result-renderer.js";
import { createDataTableRenderer } from "./data-table-renderer.js";
import { formatDurationMsForUi } from "./text-utils.js";

/** Shared display primitives; capability packages own all tool-specific projections. */
export function createProfileHelpers(host: RendererServices) {
  const table = createDataTableRenderer({ summarizeValue });
  return { ...host.generic, pageDisplayTarget: host.pageDisplayTarget, renderMarkdown: host.renderMarkdown,
    formatDurationMsForUi, renderDataCell: table.renderCell, appendDataRowsTable: table.appendRowsTable, dataTableRenderer: table };
}
export function resultProfile(complete: (parent: HTMLElement, tool: ToolView, result: unknown, originalResult: unknown) => unknown,
  preparing?: (parent: HTMLElement, tool: ToolView, status: ToolView["status"]) => unknown): ProfileProjection {
  return (parent, tool) => tool.isRunning && !tool.hasResult
    ? preparing?.(parent, tool, tool.status)
    : complete(parent, tool, tool.result, tool.originalResult);
}

export type ProfileHelpers = ReturnType<typeof createProfileHelpers>;

/** Assemble capability-owned projections without repeating host registration plumbing. */
export function profileCapability(
  create: (helpers: ProfileHelpers, host: RendererServices) => Readonly<Record<string, ProfileProjection>>,
  presentations?: readonly ToolPresentationDefinition[] | ((host: RendererServices) => readonly ToolPresentationDefinition[]),
): RendererExtension {
  return host => {
    const declared = typeof presentations === "function" ? presentations(host) : presentations;
    for (const presentation of declared || []) host.registerPresentation(presentation);
    for (const [id, projection] of Object.entries(create(createProfileHelpers(host), host))) {
      host.registerRenderer(host.project(id, projection));
    }
  };
}
