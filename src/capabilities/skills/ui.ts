import { t } from "./i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createSkillsFeature } from "./workspace/skills-feature.js";
import { createSkillReferences } from "./references.js";

export default function (qz: UiExtensionAPI) {
  const skills = createSkillsFeature({
    root: qz.root, signal: qz.signal, request: qz.request, send: qz.send,
    isActive: () => qz.getCurrentPage() === "skills",
    getCurrentSessionId: qz.getCurrentSessionId,
    getSessionRuntime: id => qz.sessions.getRuntime(id || ""),
    updateSessionRuntime: qz.sessions.updateRuntime,
    isCurrentSession: id => qz.getCurrentSessionId() === id,
    renderMarkdown: qz.presentation.renderMarkdown,
    clearMathTypeset: qz.presentation.clearMath,
    scheduleMathTypeset: qz.presentation.scheduleMath,
    highlightSearchText: qz.presentation.highlightSearchText,
    confirm: qz.dialogs.confirm, choose: qz.dialogs.choose,
    showToast: qz.showToast, hideToast: qz.hideToast,
    onStableViewChange: qz.notifyViewChange,
  });
  qz.onDispose(skills.dispose);
  qz.extensions.register({
    references: [createSkillReferences(skills.list, () => skills.resolveCurrentSiteUrls({ fresh: false }))],
  });
  qz.on("plugin_registry_update", async () => {
    if (qz.getCurrentPage() !== "skills") return;
    try { await skills.refresh(); }
    catch (error) {
      if (!qz.signal.aborted) console.debug("[轻舟] refresh skills after registry update failed:", error instanceof Error ? error.message : error);
    }
  });
  qz.registerPage({
      id: "skills", title: t("skills"), order: 40, elements: [skills.panel],
      activate: () => skills.activate(), deactivate: skills.deactivate,
      capture: () => ({ skill: skills.getCurrentSkill() }),
      restore: state => skills.restore(state && typeof state === "object" && "skill" in state ? String(state.skill || "") || null : null),
  });
  qz.registerOverlay({
      id: "skills", priority: 30,
      close: () => qz.getCurrentPage() === "skills" && skills.closeTopmostTransientUi(),
      blocksFocus: () => false,
  });
}
