import { stripInvisibleTitlePrefix } from "./unicode-utils.js";

/** Browser tab fields shared across contexts without importing a Chrome runtime. */
export interface TabReference {
  id?: number | null;
  windowId?: number | null;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
}

export function isWebTabUrl(url: unknown) {
  return /^https?:\/\//i.test(String(url || ""));
}

export function getEffectiveTabUrl(tab: TabReference | null | undefined) {
  if (!tab || typeof tab !== "object") return "";
  const currentUrl = String(tab.url || "").trim();
  const pendingUrl = String(tab.pendingUrl || "").trim();
  if (isWebTabUrl(currentUrl)) return currentUrl;
  if (isWebTabUrl(pendingUrl)) return pendingUrl;
  return currentUrl || pendingUrl;
}

export function isWebTab(tab: TabReference | null | undefined) {
  return isWebTabUrl(getEffectiveTabUrl(tab));
}

export function filterWebTabs<T extends TabReference>(tabs: readonly T[] | null | undefined): T[] {
  return (Array.isArray(tabs) ? tabs : []).filter(isWebTab);
}

export function formatTab(tab: TabReference, { titleLimit = 80 } = {}) {
  const currentUrl = String(tab?.url || "").trim();
  const url = getEffectiveTabUrl(tab);
  const rawTitle = stripInvisibleTitlePrefix(String(tab?.title || ""));
  const title = isWebTabUrl(url) && (
    !isWebTabUrl(currentUrl)
    || /^(?:about:|chrome(?:-extension)?:\/\/|edge:\/\/|brave:\/\/|opera:\/\/|vivaldi:\/\/)/i.test(rawTitle.trim())
  )
    ? ""
    : rawTitle;
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: title.slice(0, titleLimit),
    url,
    active: !!tab.active,
    pinned: !!tab.pinned,
  };
}
