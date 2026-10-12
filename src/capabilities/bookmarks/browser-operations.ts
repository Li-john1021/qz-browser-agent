import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createBookmarkProfiles(helpers: ProfileHelpers) {
  const { describeToolRun } = helpers;

function appendLibraryProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  const items = Array.isArray(result) ? result : Array.isArray(data.items) ? data.items : [];
  if (items.length) {
    presentation.appendSlimList(parent, toolName === "manage_bookmarks" ? t("bookmarks") : t("history"), items.map(record), item => ({
      title: item.title || item.url || item.id || t("items"),
      subtitle: item.url || "",
      meta: [item.id, item.parentId, item.visitCount != null ? t("visits", { count: String(item.visitCount) }) : ""].filter(Boolean),
    }));
    return true;
  }
  if (result && typeof result === "object") {
    presentation.appendCompactLine(parent, {
      title: data.deleted ? t("deleted", { count: String(data.deleted) }) : record(data.created).title || record(data.updated).title || record(data.moved).title || describeToolRun(toolName, args, result, true),
      subtitle: record(data.created).url || record(data.updated).url || record(data.moved).url || "",
      meta: [record(data.created).id || record(data.updated).id || record(data.moved).id].filter(Boolean),
    });
    return true;
  }
  return false;
}

  return { renderLibrary: appendLibraryProfile };
}
