import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record, type ToolEvent } from "#sdk/sidepanel/presentation";
import type { ToolPresentationDefinition } from "#sdk/sidepanel";
type Data = Record<string, unknown>;

export function extractSessionPrompt(value: unknown): string {
  const args = record(value);
  const direct = firstPromptString([
    args.prompt,
    args.firstMessage,
    args.initialMessage,
    args.message,
    args.instructions,
    args.instruction,
    args.task,
    args.input,
    args.content,
    args.text,
    args.query,
  ]);
  if (direct) return direct;

  for (const container of [args.session, args.task, args.taskConfig, args.taskOptions, args.child, args.childTask, args.params, args.payload, args.options]) {
    const nested = extractPromptFromObject(container);
    if (nested) return nested;
  }

  if (Array.isArray(args.messages)) {
    const message: unknown = [...args.messages].reverse().find((item: unknown) => {
      if (typeof item === "string") return item.trim();
      if (!item || typeof item !== "object") return false;
      const content = record(item).content;
      return typeof content === "string" && content.trim();
    });
    if (typeof message === "string") return message.trim();
    if (record(message).content) return String(record(message).content).trim();
  }
  return "";
}

export function extractPromptFromObject(input: unknown) {
  const value = record(input);
  return firstPromptString([
    value.prompt,
    value.firstMessage,
    value.initialMessage,
    value.message,
    value.instructions,
    value.instruction,
    value.task,
    value.input,
    value.content,
    value.text,
    value.query,
  ]);
}

export function firstPromptString(values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function formatSessionArgsPreview(args: Record<string, unknown>, rawText = "") {
  const action = presentation.fieldLabel(args.action || "manage_sessions");
  const prompt = extractSessionPrompt(args);
  if (prompt) return `(${action} · prompt: ${presentation.summarizeValue(prompt, 72)})`;
  const target = presentation.firstNonEmpty([
    args.title,
    args.sessionId && t("task", { sessionId: String(args.sessionId) }),
    Array.isArray(args.sessionIds) && args.sessionIds.length ? t("tasks", { count: String(args.sessionIds.length) }) : "",
  ]);
  if (target) return `(${action} · ${presentation.summarizeValue(target, 72)})`;
  return rawText ? t("argumentCharacters", { action: String(action), count: String(rawText.length) }) : `(${action})`;
}

export const presentations: readonly ToolPresentationDefinition[] = [{ id: "manage_sessions", argsSummary: ({ args, rawArgsText }) => formatSessionArgsPreview(args, rawArgsText) }];
