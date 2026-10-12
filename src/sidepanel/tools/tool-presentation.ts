import { getToolProfileFamily, getToolResultFamily, getToolLabelerId, getToolMediaPresentation, toolKey } from "./tool-model.js";
import { record, type ToolEvent } from "./renderer-input.js";

import type { ToolPresentationView, ToolPresentationLabel, ToolPresentationDefinition } from "../../sdk/sidepanel/renderers.js";
export type { ToolPresentationView, ToolPresentationLabel, ToolPresentationDefinition } from "../../sdk/sidepanel/renderers.js";

type Projection = "timelineTarget" | "resultIsError" | "argsSummary" | "describeRun" | "compactParams" | "timelineBadge" | "timelineGroupTitle";

export class ToolPresentationRegistry {
  private definitions = new Map<string, ToolPresentationDefinition>();
  register(definition: ToolPresentationDefinition): () => void {
    if (!definition.id.trim() || this.definitions.has(definition.id)) throw new Error(`Duplicate or empty tool presentation: ${definition.id}`);
    const snapshot = Object.freeze({ ...definition });
    const id = snapshot.id;
    this.definitions.set(id, snapshot);
    return () => { if (this.definitions.get(id) === snapshot) this.definitions.delete(id); };
  }
  private candidates(tool: ToolEvent | string): ToolPresentationDefinition[] {
    const event = typeof tool === "string" ? { name: tool } : tool;
    return [...new Set([toolKey(event), event.rendererId, getToolProfileFamily(event), getToolResultFamily(event),
      `labeler:${getToolLabelerId(event)}`, `media:${getToolMediaPresentation(event)}`])]
      .map(id => id ? this.definitions.get(id) : undefined).filter((value): value is ToolPresentationDefinition => Boolean(value));
  }
  has(projection: Projection, tool: ToolEvent | string): boolean {
    return this.candidates(tool).some(definition => Boolean(definition[projection]));
  }
  timelineVisibility(tool: ToolEvent | string): ToolPresentationDefinition["timelineVisibility"] {
    return this.definitions.get(toolKey(tool))?.timelineVisibility;
  }
  project<K extends Projection>(projection: K, tool: ToolEvent | string, args: unknown, result?: unknown, rawArgsText = "", surface: ToolPresentationView["surface"] = "details"): ReturnType<NonNullable<ToolPresentationDefinition[K]>> | undefined {
    const frozenArgs = Object.freeze({ ...record(args) });
    const event = Object.freeze({ ...(typeof tool === "string" ? { name: tool } : tool), args: frozenArgs });
    const view = Object.freeze({ name: toolKey(tool), tool: event, args: frozenArgs, result, rawArgsText, surface });
    for (const definition of this.candidates(tool)) {
      const callback = definition[projection];
      if (!callback) continue;
      try {
        const value = callback(view);
        // Only synchronous, plain parameter records can enter the shared fallback renderer.
        if (value instanceof Promise) { void value.catch(() => {}); continue; }
        const plainParams = value && typeof value === "object"
          && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && typeof (value as { then?: unknown }).then !== "function";
        if (projection === "timelineBadge" || projection === "timelineGroupTitle") {
          if (!plainParams) continue;
          const { label, order, key } = record(value);
          if (typeof label !== "string" || typeof order !== "number" || !Number.isFinite(order)
            || (key !== undefined && typeof key !== "string")) continue;
          // Snapshot once so getters or later mutation cannot escape callback isolation.
          return Object.freeze({ label, order, ...(key === undefined ? {} : { key }) }) as ReturnType<NonNullable<ToolPresentationDefinition[K]>>;
        }
        const valid = projection === "resultIsError" ? typeof value === "boolean"
          : projection === "compactParams" ? plainParams : typeof value === "string";
        if (valid) {
          return value as ReturnType<NonNullable<ToolPresentationDefinition[K]>>;
        }
      } catch { /* A capability cannot break the shared tool card or its fallback. */ }
    }
    return undefined;
  }
}

export const toolPresentationRegistry = new ToolPresentationRegistry();
