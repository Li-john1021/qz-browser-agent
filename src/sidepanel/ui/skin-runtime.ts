interface SkinOptions { root?: Document; runtime?: Pick<typeof chrome.runtime, "getURL"> }
interface LoadSkinOptions extends SkinOptions { fetchStylesheet?: typeof fetch }

const DEFAULT_SKIN_PATH = "sidepanel/sidepanel.css";
const SKIN_LINK_SELECTORS = [
  "#qingzhou-sidepanel-skin",
  'link[rel~="stylesheet"][data-qingzhou-skin]',
  'link[rel~="stylesheet"][href*="sidepanel"][href$=".css"]',
];

/**
 * Resolves the stylesheet that currently defines the Sidepanel presentation.
 * @param {{root?: Document, runtime?: Pick<typeof chrome.runtime, "getURL">}} [options]
 */
export function resolveActiveSidepanelSkin({
  root = globalThis.document,
  runtime = globalThis.chrome?.runtime,
}: SkinOptions = {}) {
  const link = findSkinLink(root);
  const fallbackHref = runtime?.getURL?.(DEFAULT_SKIN_PATH) || DEFAULT_SKIN_PATH;
  const href = resolveHref(link?.href || link?.getAttribute?.("href") || fallbackHref, root, fallbackHref);
  const path = extensionResourcePath(href, runtime);
  const name = String(link?.dataset?.qingzhouSkin || skinNameFromPath(path) || "default").trim() || "default";
  return Object.freeze({ name, href, path });
}

/** @param {{root?: Document, runtime?: Pick<typeof chrome.runtime, "getURL">, fetchStylesheet?: typeof fetch}} [options] */
export async function loadActiveSidepanelSkin({
  root = globalThis.document,
  runtime = globalThis.chrome?.runtime,
  fetchStylesheet = globalThis.fetch,
}: LoadSkinOptions = {}) {
  const skin = resolveActiveSidepanelSkin({ root, runtime });
  if (typeof fetchStylesheet !== "function") return { ...skin, css: "" };
  const response = await fetchStylesheet(skin.href);
  if (!response?.ok) throw new Error(`stylesheet ${response?.status || "unavailable"}`);
  return { ...skin, css: await response.text() };
}

function findSkinLink(root: Document | undefined) {
  if (!root?.querySelector) return null;
  for (const selector of SKIN_LINK_SELECTORS) {
    const link = root.querySelector<HTMLLinkElement>(selector);
    if (link) return link;
  }
  return null;
}

function resolveHref(value: unknown, root: Document | undefined, fallbackHref: string) {
  const text = String(value || fallbackHref || "").trim();
  if (!text) return "";
  try {
    return new URL(text, root?.baseURI || fallbackHref || undefined).href;
  } catch (_error) {
    return text;
  }
}

function extensionResourcePath(href: string, runtime: SkinOptions["runtime"]) {
  const extensionRoot = runtime?.getURL?.("") || "";
  if (extensionRoot && href.startsWith(extensionRoot)) {
    return href.slice(extensionRoot.length).split(/[?#]/u, 1)[0];
  }
  try {
    const url = new URL(href);
    return url.protocol === "data:" ? "" : url.pathname.replace(/^\/+/, "");
  } catch (_error) {
    return String(href || "").split(/[?#]/u, 1)[0].replace(/^\/+/, "");
  }
}

function skinNameFromPath(path: string) {
  const filename = String(path || "").split("/").at(-1) || "";
  return filename.replace(/\.css$/iu, "").replace(/^sidepanel(?:[-_.]+)?/iu, "") || "default";
}
