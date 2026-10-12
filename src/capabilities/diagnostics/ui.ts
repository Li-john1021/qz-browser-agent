import { t } from "./i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createLogsFeature } from "./workspace/logs-feature.js";

export default function (qz: UiExtensionAPI) {
  const logs = createLogsFeature({
    root: qz.root, signal: qz.signal, send: qz.send,
    isEnabled: qz.isDebugEnabled,
    onClearLandingHistory: () => qz.extensions.notify({ type: "ui_clear_landing_history" }),
  });
  qz.onDispose(logs.dispose);
  qz.on("trace", event => logs.render(Array.isArray(event.logs) ? event.logs : []));
  qz.on("trace_cleared", () => logs.render([]));
  qz.registerPage({
    id: "logs", title: t("logs"), order: 50, elements: [logs.panel],
    isEnabled: qz.isDebugEnabled, activate: ({ refresh }) => { if (refresh) logs.load(); },
  });
}
