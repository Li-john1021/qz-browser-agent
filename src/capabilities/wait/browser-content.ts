import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection, escapeHtml } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createWaitProfiles(helpers: ProfileHelpers) {
  const { describeToolRun, formatDurationMsForUi, pageDisplayTarget } = helpers;

function appendSendAlertProfile(parent: HTMLElement, args: Data = {}, result: unknown = {}) {
  const data = record(result);
  const message = presentation.firstNonEmpty([
    data.message,
    args.message,
    data.title,
    args.title,
    data.sent === false ? t("notificationRateLimitedNoDuplicateWasSent") : t("notificationSent"),
  ]);
  appendHtmlSection(parent, "tool-alert-message", presentation.linkifyText(presentation.clipDisplayText(message, 1200)));
  return true;
}

function appendWaitProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  if (toolName === "wait_for_user") return appendWaitForUserProfile(parent, args, result);
  const data = record(result);
  const absoluteTarget = data.targetAt || data.until || args.until || "";
  presentation.appendCompactLine(parent, {
    title: data.message || (toolName === "wait_until"
      ? (data.pastDue ? t("theTargetTimeHasPassedContinuingNow") : t("targetTimeReached"))
      : describeToolRun(toolName, args, result, true)),
    subtitle: absoluteTarget || data.url || data.selector || args.selector || "",
    meta: [
      args.seconds != null ? `${args.seconds}s` : (args.ms ? `${formatDurationMsForUi(args.ms)}` : ""),
      toolName === "wait_until" && Number(data.waitedSeconds) > 0 ? t("waitingFor", { duration: String(formatDurationMsForUi(Number(data.waitedSeconds) * 1000)) }) : "",
      toolName === "wait_until" && data.pastDue && Number(data.lateBySeconds) > 0 ? t("elapsed", { duration: String(formatDurationMsForUi(Number(data.lateBySeconds) * 1000)) }) : "",
      args.timeout != null ? `timeout ${args.timeout}s` : (args.timeoutMs ? `timeout ${formatDurationMsForUi(args.timeoutMs)}` : ""),
      data.elapsedMs ? `${data.elapsedMs}ms` : "",
    ].filter(Boolean),
  });
  return true;
}

function appendWaitForUserProfile(parent: HTMLElement, args: Data, result: unknown) {
  const data = record(result);
  const pageTarget = pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false });
  presentation.appendCompactLine(parent, {
    title: waitForUserTitle(args, data),
    subtitle: data.note || (data.continued === false ? t("theUserDidNotContinueTheTask") : t("theUserCompletedTheManualStepAndContinuedThe")),
    meta: [
      args.timeout != null ? `timeout ${args.timeout}s` : (args.timeoutMs ? `timeout ${formatDurationMsForUi(args.timeoutMs)}` : ""),
      data.elapsedMs ? `${data.elapsedMs}ms` : "",
      data.reason ? `reason ${presentation.fieldLabel(data.reason)}` : "",
      pageTarget,
      data._image ? t("returnScreenshot") : "",
    ].filter(Boolean),
  });
  const fields = {
    request: args.message,
    observation: data._image ? t("returnScreenshot") : pageTarget,
  };
  presentation.appendKeyValueSection(parent, t("waitDetails"), fields, { compact: true });
  return true;
}

function waitForUserTitle(args: Data = {}, data: Data = {}) {
  if (data.error || data.code === "USER_CANCELLED_WAIT") return t("userCanceledTheWait");
  if (data.message) return data.message;
  if (data.continued === false) return t("waitNotContinued");
  const text = String(args.message || "").trim();
  if (/登录|验证码|验证|授权/.test(text)) return t("loginVerificationCompleted");
  return t("userContinued");
}

  return { renderSendAlert: appendSendAlertProfile, renderWait: appendWaitProfile };
}
