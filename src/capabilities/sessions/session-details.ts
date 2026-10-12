import { t } from "./i18n.js";
import type { RendererServices } from "#sdk/sidepanel";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection, escapeHtml } from "#sdk/sidepanel/dom";
import { extractSessionPrompt } from "./presentation.js";
import type { ToolView } from "#sdk/sidepanel";

export function createSessionDetails({ formatDuration, describeToolRun }: Pick<RendererServices["generic"], "describeToolRun"> & { formatDuration(value: unknown): string }) {
  function appendPreparingSessionProfile(parent: HTMLElement, tool: ToolView, status: ToolView["status"]) {
    const args = tool.args && typeof tool.args === "object" ? tool.args : {};
    const action = String(args.action || "").trim();
    const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds.filter(Boolean) : [];
    const prompt = extractSessionPrompt(args);
    const title = action ? t("manageTasks", { action: String(presentation.fieldLabel(action)) }) : t("manageTasksTitle");
    const subtitle = prompt ? presentation.summarizeValue(prompt, 180) : describeSessionIntent(action, args, tool.state === "preparing");
    const meta = [
      sessionIds.length ? t("tasks", { count: String(sessionIds.length) }) : "",
      prompt ? t("promptCharacters", { count: String(String(prompt).trim().length) }) : "",
      args.waitFor ? t("waitingFor", { mode: String(args.waitFor === "any" ? t("any") : t("all")) }) : "",
      args.limit ? `limit ${args.limit}` : "",
      args.num ? t("latest", { count: String(args.num) }) : "",
      args.timeout != null ? `timeout ${args.timeout}s` : (args.timeoutMs ? `timeout ${formatDuration(args.timeoutMs)}` : ""),
      tool.rawArgsText ? t("characters", { count: String(tool.rawArgsText.length) }) : "",
    ].filter(Boolean);

    appendHtmlSection(parent, "tool-session-intent", `
      <div class="tool-session-intent-title">${escapeHtml(title)}</div>
      <div class="tool-session-intent-subtitle">${escapeHtml(subtitle)}</div>
      ${meta.length ? `<div class="tool-session-intent-meta">${meta.map(item => `<span>${escapeHtml(presentation.summarizeValue(item, 60))}</span>`).join("")}</div>` : ""}
    `);
    if (prompt) appendSessionPrompt(parent, prompt);
    return true;
  }

  function describeSessionIntent(action: string, args: Readonly<Record<string, unknown>>, preparing: boolean) {
    const prompt = extractSessionPrompt(args);
    if (action === "create") {
      if (args.title && prompt) {
        return `${presentation.summarizeValue(args.title, 80)} · ${presentation.summarizeValue(prompt, 140)}`;
      }
      if (prompt) return presentation.summarizeValue(prompt, 160);
      if (args.title) return presentation.summarizeValue(args.title, 120);
      return t("preparingToCreateABackgroundTask");
    }
    if (action === "wait") {
      const ids = Array.isArray(args.sessionIds) ? args.sessionIds.filter(Boolean) : [];
      return ids.length ? t("waitingForBackgroundTasksToFinish", { count: String(ids.length) }) : t("waitingForBackgroundTasks");
    }
    if (action === "last_messages") {
      return args.sessionId ? t("readTheLatestMessagesFromTask", { sessionId: String(presentation.summarizeValue(args.sessionId, 48)) }) : t("readTheLatestTaskMessages");
    }
    if (action === "delete") {
      return args.sessionId ? t("stopAndDeleteTask", { sessionId: String(presentation.summarizeValue(args.sessionId, 48)) }) : t("stopAndDeleteTheTask");
    }
    if (action === "list") return t("viewBackgroundTaskStatus");
    return preparing ? t("preparingToolArguments") : describeToolRun("manage_sessions", args, null, false);
  }
  return { preparing: appendPreparingSessionProfile };
}

export function appendSessionPrompt(parent: HTMLElement, prompt: unknown) {
  const text = String(prompt || "").trim();
  if (!text) return;
  const clipped = presentation.clipDisplayText(text, 1800);
  appendHtmlSection(parent, "tool-session-prompt", `
    <div class="tool-session-prompt-label">${escapeHtml(t("promptSentToTheSubtask"))}</div>
    <div class="tool-session-prompt-body" data-tool-scroll-surface="prompt">${presentation.linkifyText(clipped)}</div>
    ${text.length > clipped.length ? `<div class="tool-more-hint">${escapeHtml(t("promptPreviewTruncated", { count: clipped.length }))}</div>` : ""}
  `);
}
