import { t } from "./i18n/backend.js";
type GroupAppearance = Pick<chrome.tabGroups.UpdateProperties, "color" | "collapsed">;

export const QINGZHOU_TAB_GROUP_TITLE = "轻舟任务";

export function qingzhouTabGroupPatch({ color = "cyan", collapsed = false }: GroupAppearance = {}) {
  return {
    title: t("notification.task"),
    color,
    collapsed,
  };
}

export async function ensureQingzhouTabGroupForWindow(tabIds: readonly unknown[] = [], {
  preferredGroupId = null,
  color = "cyan",
  collapsed = false,
}: GroupAppearance & { preferredGroupId?: number | null } = {}) {
  const desiredTabIds = normalizeTabIds(tabIds);
  if (desiredTabIds.length < 1) return null;

  const tabs = [];
  for (const tabId of desiredTabIds) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.id != null && Number.isFinite(Number(tab.windowId))) tabs.push(tab);
    } catch (_err) {}
  }
  if (!tabs.length) return null;

  const windowId = Number(tabs[0].windowId);
  const windowTabIds = tabs
    .filter(tab => Number(tab.windowId) === windowId)
    .map(tab => Number(tab.id));
  if (!windowTabIds.length) return null;

  const preferredId = typeof preferredGroupId === "number" && Number.isInteger(preferredGroupId) && preferredGroupId >= 0
    && tabs.some(tab => tab.windowId === windowId && tab.groupId === preferredGroupId)
    ? preferredGroupId : null;
  const groups = await listQingzhouTabGroups(windowId, preferredId);
  let target = groups.find(group => Number(group.id) === preferredId) || groups[0] || null;

  if (!target) {
    const groupId = await chrome.tabs.group({ tabIds: windowTabIds as [number, ...number[]] });
    const group = await chrome.tabGroups.update(groupId, qingzhouTabGroupPatch({ color, collapsed }));
    return { groupId, tabIds: windowTabIds as [number, ...number[]], group };
  }

  target = await normalizeQingzhouTabGroupDuplicates(target, groups, { color, collapsed });
  const currentTabIds = await getTabIdsInGroup(target.id, windowId);
  const missingTabIds = windowTabIds.filter(tabId => !currentTabIds.includes(tabId));
  if (missingTabIds.length) {
    await chrome.tabs.group({ groupId: Number(target.id), tabIds: missingTabIds as [number, ...number[]] });
  }
  const group = await chrome.tabGroups.update(Number(target.id), qingzhouTabGroupPatch({ color, collapsed }));
  return { groupId: Number(target.id), tabIds: windowTabIds as [number, ...number[]], group };
}

async function normalizeQingzhouTabGroupDuplicates(target: chrome.tabGroups.TabGroup, groups: readonly chrome.tabGroups.TabGroup[] = [], { color, collapsed }: GroupAppearance = {}) {
  const targetId = Number(target?.id);
  if (!Number.isFinite(targetId) || targetId < 0) return target;
  const windowId = Number(target?.windowId);
  for (const group of groups) {
    const groupId = Number(group?.id);
    if (!Number.isFinite(groupId) || groupId < 0 || groupId === targetId) continue;
    const tabIds = await getTabIdsInGroup(groupId, windowId);
    if (!tabIds.length) continue;
    try {
      await chrome.tabs.group({ groupId: targetId, tabIds: tabIds as [number, ...number[]] });
    } catch (_err) {}
  }
  try {
    return await chrome.tabGroups.update(targetId, qingzhouTabGroupPatch({ color, collapsed })) || target;
  } catch (_err) {
    return target;
  }
}

async function listQingzhouTabGroups(windowId: number, preferredGroupId: number | null) {
  if (!chrome.tabGroups?.query) return [];
  const groups = await chrome.tabGroups.query({ windowId });
  // A stored group ID needs a current task tab as evidence; browser restarts may reuse IDs.
  // That witnessed identity survives translated-title changes after a language switch.
  // Title matching remains a fallback for older groups without a stored identity.
  const titles = new Set([t("notification.task"), QINGZHOU_TAB_GROUP_TITLE, "Qingzhou task", "qz task"]);
  return groups
    .filter(group => group.windowId === windowId && (
      group.id === preferredGroupId || typeof group.title === "string" && titles.has(group.title)
    ))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

async function getTabIdsInGroup(groupId: number, windowId: number) {
  const id = Number(groupId);
  if (!Number.isFinite(id) || id < 0) return [];
  const query: chrome.tabs.QueryInfo = { groupId: id };
  if (Number.isFinite(Number(windowId))) query.windowId = Number(windowId);
  try {
    const tabs = await chrome.tabs.query(query);
    return normalizeTabIds(tabs.map(tab => tab.id));
  } catch (_err) {
    return [];
  }
}

function normalizeTabIds(tabIds: readonly unknown[] = []): number[] {
  return [...new Set((Array.isArray(tabIds) ? tabIds : [])
    .map(tabId => Number(tabId))
    .filter(tabId => Number.isFinite(tabId) && tabId > 0))];
}
