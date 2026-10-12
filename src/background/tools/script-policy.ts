export function isRunScriptInnerTargetArgs(args: { target?: unknown } = {}) {
  return String(args?.target || "").trim().toLowerCase() === "inner";
}

export function resolveRunScriptTargetTabId(tabId: unknown, context: { workingTabId?: unknown } = {}) {
  const explicitTabId = Number(tabId);
  if (Number.isFinite(explicitTabId) && explicitTabId > 0) return explicitTabId;
  const workingTabId = Number(context?.workingTabId);
  if (Number.isFinite(workingTabId) && workingTabId > 0) return workingTabId;
  return null;
}
