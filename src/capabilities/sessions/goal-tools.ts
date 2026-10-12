import { modelT } from "./model-messages.js";
import { t } from "./i18n.js";
import { requireToolFields } from "#sdk/background/tools";
import type { ToolExtensionAPI } from "#sdk/background";

type GoalToolDependencies = Pick<ToolExtensionAPI, "registerTool" | "ToolExecutionError" | "getToolRuntimeDependencies">;

/** Goal state and write authorization remain owned by Session commands. */
export function registerGoalTools({
  registerTool,
  getToolRuntimeDependencies,
  ToolExecutionError,
}: GoalToolDependencies) {
  registerTool({
    name: "manage_goal",
    requires: { rootSession: { code: "GOAL_SESSION_FORBIDDEN", get message() { return "manage_goal is only available in user-created root sessions. Child sessions and automation sessions do not have goal tracking."; } } },
    effects: (_args, result) => [{
      type: "context.goalRefresh",
      action: String(result && typeof result === "object" && "action" in result ? result.action || "" : ""),
    }],
    get description() { return modelT("manageGoal"); },
    get parameters() { return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "checkpoint", "update", "block", "complete", "pause", "resume", "clear", "get"],
          description: modelT("goalAction"),
        },
        objective: {
          type: "string",
          description: modelT("goalObjective"),
        },
        criteria: {
          type: "string",
          description: modelT("goalCriteria"),
        },
        progress: {
          type: "string",
          description: modelT("goalProgress"),
        },
        next: {
          type: "string",
          description: modelT("goalNext"),
        },
        checkpoint: {
          type: "string",
          description: modelT("goalCheckpoint"),
        },
        timeout: {
          type: "number",
          description: modelT("goalTimeout"),
        },
      },
      required: ["action"],
    } as const; },
    execute: async (input, _signal, context = {}) => {
      const commands = getToolRuntimeDependencies(context).sessions;
      if (typeof commands?.updateGoal !== "function") {
        throw new ToolExecutionError("GOAL_RUNTIME_UNAVAILABLE", t("goalRuntimeIsNotAvailable"), {
          action: input?.action || "",
        });
      }
      const sessionId = String(context.sessionId || "").trim();
      if (!sessionId) {
        throw new ToolExecutionError("MISSING_SESSION_ID", t("manageGoalRequiresASessionid"), {
          action: input?.action || "",
        });
      }
      return await commands.updateGoal({
        ...input,
        sessionId,
        runId: context.runId || "",
        signal: _signal,
      });
    },
    validateArgs: input => {
      const action = String(input.action || "").trim();
      const required = action === "create" ? ["objective", "criteria"] : action === "block" ? ["progress", "next"] : [];
      requireToolFields("manage_goal", input, required, { action, requiredWhen: `action=${action}` });
    },
  });
}
