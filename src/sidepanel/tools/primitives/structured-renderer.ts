import type { RendererServices } from "../../../sdk/sidepanel/renderers.js";
import { createTreeRenderer } from "./tree-renderer.js";
import { createImageGridRenderer } from "./image-grid-renderer.js";
import { createProfileHelpers } from "./profile-helpers.js";
import { createDeclarativeRenderer } from "./declarative-renderer.js";

export function createStructuredRenderer(host: RendererServices) {
  const helpers = createProfileHelpers(host);
  const tree = createTreeRenderer();
  return createDeclarativeRenderer({ genericRenderer: host.generic, dataTableRenderer: helpers.dataTableRenderer,
    browserContentProfiles: { renderPageTree: (parent, _name, args, value) => tree.render(parent, args, value, { title: "DOM" }), ...createImageGridRenderer() } });
}
