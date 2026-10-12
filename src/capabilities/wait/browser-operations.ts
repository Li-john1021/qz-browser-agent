import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createQuestionProfiles(helpers: ProfileHelpers) {
function appendAskUserProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const fields = Array.isArray(args.fields) ? args.fields : [];
  const answers = record(data.answers);
  const submitted = data.submitted !== false;

  presentation.appendCompactLine(parent, {
    title: submitted ? t("submitted") : t("notSubmitted"),
    subtitle: args.message || args.title || "",
    meta: [
      fields.length ? t("fields", { count: String(fields.length) }) : "",
      data.reason ? `reason: ${presentation.fieldLabel(data.reason)}` : "",
      args.submitLabel ? t("button", { label: String(args.submitLabel) }) : "",
    ].filter(Boolean),
  });

  if (fields.length) {
    presentation.appendSlimList(parent, t("question"), fields, field => ({
      title: field.label || field.id || t("question"),
      subtitle: field.help || field.placeholder || choiceOptionsText(field.options),
      meta: [field.type || "text", field.required === false ? t("optional") : t("required")].filter(Boolean),
    }));
  }

  if (Object.keys(answers).length) presentation.appendKeyValueSection(parent, t("answer"), answers, { compact: true });
  return true;
}

function choiceOptionsText(options: unknown) {
  if (!Array.isArray(options) || !options.length) return "";
  return options
    .slice(0, 5)
    .map(option => option?.label || option?.value || presentation.summarizeValue(option, 40))
    .filter(Boolean)
    .join(" / ");
}

function appendAskLlmProfile(parent: HTMLElement, args: Data, result: unknown) {
  presentation.appendCompactLine(parent, {
    title: t("modelAnalysisCompleted"),
    subtitle: "",
    meta: [
      args.data ? `data ${presentation.formatTextSize(args.data)}` : "",
      args.system ? "system yes" : "",
    ].filter(Boolean),
  });
  if (args.prompt) presentation.appendTextSection(parent, "Prompt", args.prompt);
  if (result != null && result !== "") presentation.appendTextSection(parent, t("result"), typeof result === "string" ? result : presentation.summarizeValue(result, 2400));
  return true;
}

  return { renderAskUser: appendAskUserProfile, renderAskLlm: appendAskLlmProfile };
}
