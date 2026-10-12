/** Supported sessions helpers; mutable host state is accessed through extension ports. */
export { clipText, formatLiveElapsedMs, goalStatusClass } from "../../sidepanel/features/sessions/session-format.js";
export { optionalSessionId, stringSessionId } from "../../sidepanel/features/sessions/session-id.js";
export type { ClientRuntime, SessionViewEvent, TrackerView } from "../../sidepanel/features/sessions/session-state.js";
export { isSessionRuntimeActive, normalizeSessionGoal, normalizeSessionTaskSites, normalizeSessionTracker, trackerModeTitle, trackerModeUnit } from "../../sidepanel/features/sessions/session-state.js";
export { buildTreeNodes } from "../../sidepanel/features/sessions/session-tree-view.js";
