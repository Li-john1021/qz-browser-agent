import { appendSaveFileContentPreview } from "./preview.js";
import type { RendererExtension } from "#sdk/sidepanel";
import { createProfileHelpers, resultProfile } from "#sdk/sidepanel/components";
import { createDocumentProfiles } from "./browser-content.js";
import { presentations } from "./presentation.js";

const contribute: RendererExtension = host => {
  const helpers = createProfileHelpers(host);
  const documents = createDocumentProfiles(helpers);
  const contribution = {
    presentations: presentations,
    renderers: [
      host.project("download", resultProfile((parent, tool, result, originalResult) => documents.renderDownload(parent, tool.name, tool.args, result)), {
        renderRunningInputs: (parent, tool) => tool.name === "save_file" && appendSaveFileContentPreview(parent, tool.args, { streaming: true }),
      }),
      host.project("document", resultProfile((parent, tool, result, originalResult) => documents.renderDocument(parent, tool.name, tool.args, result))),
    ],
  };
  for (const definition of contribution.presentations) host.registerPresentation(definition);
  for (const renderer of contribution.renderers) host.registerRenderer(renderer);
};
export default contribute;
