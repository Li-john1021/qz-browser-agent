import { t } from "./i18n.js";
import type { RendererExtension } from "#sdk/sidepanel";
import { resultProfile } from "#sdk/sidepanel/components";
import * as presentation from "#sdk/sidepanel/presentation";
import { isToolResultErrorLike } from "#sdk/sidepanel/presentation";
import { createScriptProfile } from "./profile.js";
import { presentations } from "./presentation.js";

export default (host => {
  const script = createScriptProfile(host.generic);
  const contribution = {
    presentations: presentations(host),
    renderers: [
      host.project("plugin-script", (parent, tool) => script.render(parent, tool.args, tool.result, tool.originalResult)),
      host.project("script", resultProfile((parent, tool, result, originalResult) => script.render(parent, tool.args, result, originalResult)), {
        detailsClass: () => "tool-details-stream-unbounded",
        renderPrelude(parent, tool) {
          if (typeof tool.args.code === "string") presentation.appendCodeDetail(parent, t("runCode"), tool.args.code);
        },
        renderErrorResult(parent, tool) {
          // Execution errors belong to the outer envelope; a returned payload may itself contain error-like data.
          const values = [tool.originalResult, tool.result];
          presentation.appendErrorSection(parent, values.find(isToolResultErrorLike) ?? values.find(value => value != null && value !== "") ?? null);
          const envelope = presentation.getResultEnvelope(tool.originalResult) || presentation.getResultEnvelope(tool.result);
          if (Array.isArray(envelope?.trace) && envelope.trace.length) presentation.appendScriptTrace(parent, envelope.trace);
          return true;
        },
      }),
    ],
  };
  for (const definition of contribution.presentations) host.registerPresentation(definition);
  for (const renderer of contribution.renderers) host.registerRenderer(renderer);
}) satisfies RendererExtension;
