import type { RendererDefinition, RendererInstance, ToolView } from "../../src/sidepanel/tools/renderer-host.js";
import type { ToolPresentationDefinition, ToolPresentationView } from "../../src/sidepanel/tools/tool-presentation.js";

declare const view: ToolView;
// @ts-expect-error Renderers consume a projection; they cannot mutate task state.
view.state = "running";
// @ts-expect-error Argument fields are read-only at the renderer boundary.
view.args.changed = true;
// @ts-expect-error Tool result fields require narrowing rather than implicit any.
view.result.rows;

const asynchronousInstance: RendererInstance = {
  // @ts-expect-error Updates are synchronous; asynchronous work belongs to signal-scoped effects.
  async update() {},
  dispose() {},
};
const incompleteRenderer: RendererDefinition = {
  id: "invalid",
  // @ts-expect-error Mount must provide both update and disposal.
  mount() { return { update() {} }; },
  // @ts-expect-error Static export must produce offline DOM synchronously.
  async renderStatic(_view, { document }) { return document.createElement("div"); },
};
void [asynchronousInstance, incompleteRenderer];

declare const presentation: ToolPresentationView;
// @ts-expect-error Summaries receive read-only arguments, never mutable task state.
presentation.args.changed = true;
const asynchronousPresentation: ToolPresentationDefinition = {
  id: "invalid-summary",
  // @ts-expect-error Header projection is synchronous and cannot introduce async rendering races.
  async argsSummary() { return "later"; },
  // @ts-expect-error Parameter projection must be a record, not serialized JSON.
  compactParams() { return "{}"; },
};
void asynchronousPresentation;

const invalidTimeline: ToolPresentationDefinition = {
  id: "invalid-timeline",
  // @ts-expect-error Ordered timeline labels must be synchronous and serializable.
  async timelineBadge() { return { label: "later", order: 1 }; },
  // @ts-expect-error Priority is an explicit finite number, not display text.
  timelineGroupTitle() { return { label: "wrong order", order: "first" }; },
};
// @ts-expect-error Capability policies receive an immutable historical identity snapshot.
presentation.tool.name = "mutated";
void invalidTimeline;
