import { t } from "../../shared/i18n/backend.js";
import type { ToolBehavior } from "../../shared/contracts/tool.js";
import type { ToolContext } from "../../sdk/background.js";
import { ToolExecutionError } from "./arguments.js";

export function toolBehaviorEnabled(policy: ToolBehavior["mayUnloadPage"], args: Record<string, unknown>): boolean {
  return typeof policy === "function" ? policy(args) === true : policy === true;
}

/** Runs after argument/target validation, including trusted plugin-host forwarding. */
export function assertScriptPageLifecycle(
  definition: { name: string; behavior?: Readonly<ToolBehavior> },
  args: Record<string, unknown>,
  context: ToolContext,
) {
  if (context.source !== "run_script" && context.runScriptToolDepth == null) return;
  const sourceTabId = Number(context.senderTabId);
  if (!Number.isFinite(sourceTabId) || sourceTabId <= 0) return;
  // UID targets are resolved by the element host later. Missing tab IDs remain
  // conservative here; an unresolved target cannot opt out of the unload guard.
  const targetTabId = Number(args.tabId ?? args._tabId ?? sourceTabId);
  if (!Number.isFinite(targetTabId) || targetTabId !== sourceTabId
    || !toolBehaviorEnabled(definition.behavior?.mayUnloadPage, args)) return;

  const name = definition.name;
  throw Object.assign(new ToolExecutionError(
    "RUN_SCRIPT_SELF_UNLOADING_TOOL_BLOCKED",
    t("browser.selfUnloadingTool", { name: String(name) }),
    { toolName: name, sourceTabId, targetTabId, action: args.action || null, key: args.key || args.value || null, submit: args.submit === true },
  ), {
    diagnostic: {
      category: "page_lifecycle",
      likelyCause: t("browser.selfUnloadCause"),
      suggestedNextStep: t("browser.selfUnloadRecovery"),
    },
  });
}
