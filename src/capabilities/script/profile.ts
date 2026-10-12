import { t } from "./i18n.js";
import type { RendererServices } from "#sdk/sidepanel";
import * as presentation from "#sdk/sidepanel/presentation";

export function createScriptProfile(genericRenderer: Pick<RendererServices["generic"], "appendJsonCodeBlock">) {
  if (!genericRenderer) throw new Error("script profile generic renderer is required");

  function render(parent: HTMLElement, _args: unknown, result: unknown, originalResult: unknown) {
    const envelope = presentation.getResultEnvelope(originalResult)
      || presentation.getResultEnvelope(result);
    const value = envelope && Object.prototype.hasOwnProperty.call(envelope, "result")
      ? presentation.normalizeFriendlyValue(envelope.result)
      : (result ?? originalResult);
    if (Array.isArray(envelope?.trace) && envelope.trace.length) {
      presentation.appendScriptTrace(parent, envelope.trace);
    }
    if (value === undefined || value === null || value === "") {
      presentation.appendCompactLine(parent, {
        title: t("noReturnValue"),
        subtitle: t("theScriptRanWithoutAReturnValueOrReturned"),
      });
      return true;
    }
    genericRenderer.appendJsonCodeBlock(parent, "result", value);
    return true;
  }

  return { render };
}
