import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
import { extractSessionPrompt } from "./presentation.js";
import { appendSessionPrompt } from "./session-details.js";
type Data = Record<string, unknown>;

export function createSessionProfiles(helpers: ProfileHelpers) {
  const { describeToolRun } = helpers;

function appendSessionProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const sessions = Array.isArray(result) ? result : Array.isArray(data.sessions) ? data.sessions : Array.isArray(data.items) ? data.items : [];
  const prompt = extractSessionPrompt(args);
  if (prompt) appendSessionPrompt(parent, prompt);
  if (sessions.length) {
    presentation.appendSlimList(parent, t("tasksLabel"), sessions.map(record), item => ({
      title: item.title || item.name || item.id || t("tasksLabel"),
      subtitle: item.prompt || item.firstMessage || item.lastMessage || item.summary || item.id || "",
      meta: [item.status, item.updatedAt || item.createdAt].filter(Boolean),
    }));
    return true;
  }
  if (result && typeof result === "object") {
    presentation.appendCompactLine(parent, {
      title: data.title || data.status || describeToolRun("manage_sessions", args, result, true),
      subtitle: data.message || data.sessionId || "",
      meta: [data.status, data.updatedAt].filter(Boolean),
    });
    return true;
  }
  return false;
}

  return { renderSessions: appendSessionProfile };
}
