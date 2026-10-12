import type { ToolContext, ToolErrorConstructor } from '../../sdk/background.js';
import type { GetToolRuntimeDependencies } from '../../sdk/background/services.js';
import type { createCdpRuntime } from './cdp-runtime.js';
export interface ElementReference {
  uid?: string; selector?: string; tabId?: number; sessionId?: string; pageUrl?: string;
  index?: number; imageSrc?: string; imageIndex?: number; backendNodeId?: number; role?: string; name?: string; createdAt?: number;
  [field: string]: unknown;
}
interface ElementRuntimeHost {
  ToolExecutionError: ToolErrorConstructor;
  getToolRuntimeDependencies: GetToolRuntimeDependencies;
  makeSessionTabTargetError(code: string, details: Record<string, unknown>): Error;
  assertTabAllowed(tabId: number, details: Record<string, unknown>): Promise<unknown>;
  withDebugger: ReturnType<typeof createCdpRuntime>['withDebugger'];
}
import { elementPageFunction } from "./page-scripts.js";
import { isCdpFallbackForbiddenError } from "./cdp-runtime.js";
import { getEffectiveTabUrl } from "../../shared/tab-utils.js";
import { getLanguage } from "../../shared/i18n/index.js";
import { t } from "./messages.js";

/** Owns stable element references and page/tab/session validation. */
export function createElementRuntime({
  ToolExecutionError,
  getToolRuntimeDependencies,
  makeSessionTabTargetError,
  assertTabAllowed: assertTabAllowedBySecurityGuardrails,
  withDebugger,
}: ElementRuntimeHost) {
// ---------------------------------------------------------------------------
// Page snapshot element refs
// ---------------------------------------------------------------------------

const elementRefRegistry = new Map<string, ElementReference>();
const ELEMENT_REF_TTL_MS = 30 * 60 * 1000;
const ELEMENT_REF_MAX = 5000;
const ELEMENT_TARGET_GRAMMAR = 'target = "uid:" <element_uid> | "css:" <css_selector>';
function getElementTargetExamples() {
return [
  "uid:t1887138561_ax_42",
  "uid:t1887138561_a7",
  `css:button[aria-label="${t("nextPageSelector")}"]`,
  'css:a[href*="page=2"]',
  'css:input[name="q"]',
  `css:textarea[placeholder*="${t("commentSelector")}"]`,
  'css:[data-testid="submit"]',
];
}
function getElementTargetDescription() {
return t("elementReference", {
  grammar: ELEMENT_TARGET_GRAMMAR,
  examples: getElementTargetExamples().join(getLanguage() === "zh-CN" ? "；" : "; "),
});

}

function makeSnapshotId(tabId: number) {
  return `t${tabId}_${Date.now().toString(36)}`;
}

function registerElementRef(ref: ElementReference) {
  if (!ref?.uid) return;
  cleanupElementRefs();
  elementRefRegistry.set(ref.uid, {
    ...ref,
    createdAt: Date.now(),
  });
}

function cleanupElementRefs() {
  const now = Date.now();
  for (const [uid, ref] of elementRefRegistry.entries()) {
    if (now - Number(ref.createdAt || 0) > ELEMENT_REF_TTL_MS) {
      elementRefRegistry.delete(uid);
    }
  }
  while (elementRefRegistry.size > ELEMENT_REF_MAX) {
    const first = elementRefRegistry.keys().next().value;
    if (!first) break;
    elementRefRegistry.delete(first);
  }
}

function elementTargetForUid(uid: unknown) {
  const value = normalizeElementUid(uid);
  return value ? `uid:${value}` : "";
}

function elementTargetForSelector(selector: unknown) {
  const value = String(selector || "").trim();
  return value ? `css:${value}` : "";
}

function elementTargetForRef(ref: ElementReference = {}) {
  return elementTargetForUid(ref.uid) || elementTargetForSelector(ref.selector);
}

function isElementTarget(value: unknown) {
  return /^(uid|css):/i.test(String(value || "").trim());
}

function isUidElementTarget(value: unknown) {
  return /^uid:/i.test(String(value || "").trim());
}

function parseElementTarget(target = "") {
  const raw = String(target || "").trim();
  if (!raw) return { uid: "", selector: "" };
  const separator = raw.indexOf(":");
  const kind = separator >= 0 ? raw.slice(0, separator).trim().toLowerCase() : "";
  const value = separator >= 0 ? raw.slice(separator + 1).trim() : "";
  if (kind === "uid" && value) return { uid: value, selector: "" };
  if (kind === "css" && value) return { uid: "", selector: value };
  throw new ToolExecutionError("INVALID_ELEMENT_TARGET", `Invalid element target: ${raw}`, {
    target: raw,
    expected: ELEMENT_TARGET_GRAMMAR,
    examples: getElementTargetExamples(),
  });
}

function addElementTargetsToFindResult(result: unknown) {
  if (!isRecord(result)) return result;
  const addTarget = (item: unknown) => {
    if (!isRecord(item)) return item;
    const target = item.target || elementTargetForUid(item.uid) || elementTargetForSelector(item.selector);
    return target ? { ...item, target } : item;
  };
  if (Array.isArray(result.results)) {
    return { ...result, results: result.results.map(addTarget) };
  }
  if (Array.isArray(result.elements)) {
    return { ...result, elements: result.elements.map(addTarget) };
  }
  return addTarget(result);
}

async function resolveSelectorTarget(tabId: number | undefined, selector = "", index = 0, context: ToolContext = {}) {
  const raw = String(selector || "").trim();
  if (!raw) return { tabId, selector: "" };
  if (!isElementTarget(raw)) return { tabId, selector: raw };
  const parsed = parseElementTarget(raw);
  if (parsed.selector) return { tabId, selector: parsed.selector };
  const ref = await resolveElementReference(tabId, { target: raw, index }, context);
  return { tabId: ref.tabId, selector: ref.selector, index: ref.index, target: ref.target };
}

async function resolveElementReference(tabId: number | undefined, { target = "", index = 0, allowBackendOnly = false } = {}, context: ToolContext = {}) {
  const normalized = parseElementTarget(target);
  const requestedUid = normalizeElementUid(normalized.uid);
  const requestedSelector = String(normalized.selector || "").trim();
  if (!requestedUid && !requestedSelector) {
    throw new ToolExecutionError("MISSING_ELEMENT_REFERENCE", "Element reference requires target: uid:<element_uid> or css:<css_selector>", {
      target,
      expected: ELEMENT_TARGET_GRAMMAR,
      examples: getElementTargetExamples(),
    });
  }

  if (!requestedUid) {
    return { tabId, selector: requestedSelector, index, target: elementTargetForSelector(requestedSelector) };
  }

  cleanupElementRefs();
  const ref = elementRefRegistry.get(requestedUid);
  if (!ref) {
    throw new ToolExecutionError(
      "STALE_ELEMENT_UID",
      `Element target is stale or unknown: uid:${requestedUid}. Take a fresh get_ax_tree snapshot, then retry with a new target.`,
      { target: elementTargetForUid(requestedUid) },
    );
  }

  const currentSessionId = String(context.sessionId || "").trim();
  const refSessionId = String(ref.sessionId || "").trim();
  if (currentSessionId && refSessionId && currentSessionId !== refSessionId) {
    throw new ToolExecutionError(
      "ELEMENT_UID_SESSION_MISMATCH",
      `Element target belongs to another session. Take a fresh get_ax_tree snapshot in this session, then retry.`,
      { target: elementTargetForUid(requestedUid), sessionId: currentSessionId, refSessionId },
    );
  }

  const resolvedTabId = Number(tabId || ref.tabId);
  if (!Number.isFinite(resolvedTabId) || resolvedTabId <= 0) {
    throw new ToolExecutionError("MISSING_TAB_ID", `Element target has no usable tabId: uid:${requestedUid}`, {
      target: elementTargetForUid(requestedUid),
      refTabId: ref.tabId,
    });
  }
  const sessions = getToolRuntimeDependencies(context).sessions;
  if (currentSessionId && typeof sessions?.resolveTargetTab === "function") {
    const resolved = await sessions.resolveTargetTab({
      sessionId: currentSessionId,
      tabId: resolvedTabId,
      source: "element_uid_reference",
    });
    if (!resolved?.ok) {
      throw makeSessionTabTargetError(resolved?.code || "SESSION_TAB_TARGET_DENIED", {
        toolName: "element_uid_reference",
        sessionId: currentSessionId,
        tabId: resolvedTabId,
        ownerSessionId: resolved?.ownerSessionId || "",
        reason: resolved?.reason || "",
        message: resolved?.error || "",
      });
    }
  }
  if (ref.pageUrl) {
    let currentUrl = "";
    try {
      const tab = await chrome.tabs.get(resolvedTabId);
      currentUrl = getEffectiveTabUrl(tab);
    } catch(_e) {
      currentUrl = "";
    }
    if (currentUrl && !samePageUrl(currentUrl, ref.pageUrl)) {
      throw new ToolExecutionError(
        "STALE_ELEMENT_UID_PAGE_CHANGED",
        `Element target belongs to a previous page state. Take a fresh get_ax_tree snapshot, then retry.`,
        { target: elementTargetForUid(requestedUid), tabId: resolvedTabId, currentUrl, snapshotUrl: ref.pageUrl },
      );
    }
  }
  if (tabId && Number(tabId) !== Number(ref.tabId)) {
    throw new ToolExecutionError("ELEMENT_UID_TAB_MISMATCH", `Element target belongs to tab ${ref.tabId}, not tab ${tabId}`, {
      target: elementTargetForUid(requestedUid),
      tabId,
      refTabId: ref.tabId,
    });
  }
  await assertTabAllowedBySecurityGuardrails(resolvedTabId, { tool: "element_target", source: "uid_target" });

  let resolvedSelector = requestedSelector || ref.selector || "";
  if (!resolvedSelector && ref.backendNodeId) {
    resolvedSelector = await selectorFromBackendNode(resolvedTabId, ref.backendNodeId, context);
    if (resolvedSelector) {
      elementRefRegistry.set(requestedUid, {
        ...ref,
        selector: resolvedSelector,
        createdAt: Date.now(),
      });
    }
  }

  if (!resolvedSelector && !allowBackendOnly) {
    throw new ToolExecutionError(
      "UID_SELECTOR_UNAVAILABLE",
      `Element target cannot be resolved to a CSS selector: uid:${requestedUid}`,
      {
        target: elementTargetForUid(requestedUid),
        role: ref.role,
        name: ref.name,
        backendNodeId: ref.backendNodeId,
        hint: "Take a fresh get_ax_tree snapshot or use find_elements to choose a target.",
      },
    );
  }

  return {
    tabId: resolvedTabId,
    selector: resolvedSelector,
    index: requestedSelector ? index : Number(ref.index || 0),
    uid: requestedUid,
    target: elementTargetForUid(requestedUid),
    ref,
  };
}

function normalizeElementUid(uid: unknown) {
  const value = String(uid || "").trim();
  if (!value) return "";
  if (elementRefRegistry.has(value)) return value;
  const match = value.match(/\bt\d+_[a-z0-9]+_\d+\b/i);
  return match ? match[0] : value;
}

async function backendNodeIdForSelector(tabId: number, selector: string, context: ToolContext = {}) {
  try {
    return await withDebugger(tabId, async (_target, send) => {
      const root = record(await send("DOM.getDocument", { depth: 0, pierce: true }));
      const documentNodeId = record(root.root).nodeId;
      if (!documentNodeId) return 0;
      const queried = record(await send("DOM.querySelector", { nodeId: documentNodeId, selector }));
      const nodeId = Number(queried?.nodeId || 0);
      if (!nodeId) return 0;
      const described = record(await send("DOM.describeNode", { nodeId }));
      const node = record(described.node);
      return Number(node.backendNodeId || node.backendDOMNodeId || 0);
    }, context);
  } catch(err) {
    if (isCdpFallbackForbiddenError(err)) throw err;
    return 0;
  }
}

async function selectorFromBackendNode(tabId: number, backendNodeId: number, context: ToolContext = {}) {
  try {
    return await withDebugger(tabId, async (_target, send) => {
      const resolved = record(await send("DOM.resolveNode", { backendNodeId }));
      const objectId = record(resolved.object).objectId;
      if (!objectId) return "";
      const evaluated = await send("Runtime.callFunctionOn", {
        objectId,
        returnByValue: true,
        functionDeclaration: elementPageFunction("selector"),
      });
      return String(record(record(evaluated).result).value || "").trim();
    }, context);
  } catch(err) {
    if (isCdpFallbackForbiddenError(err)) throw err;
    return "";
  }
}

function samePageUrl(a: unknown, b: unknown) {
  const left = String(a || "").split("#")[0];
  const right = String(b || "").split("#")[0];
  return !!left && !!right && left === right;
}


  return Object.freeze({
    elementTargetGrammar: ELEMENT_TARGET_GRAMMAR,
    getElementTargetDescription,
    makeSnapshotId,
    registerElementRef,
    elementTargetForUid,
    elementTargetForSelector,
    elementTargetForRef,
    isUidElementTarget,
    resolveSelectorTarget,
    resolveElementReference,
    addElementTargetsToFindResult,
    backendNodeIdForSelector,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
