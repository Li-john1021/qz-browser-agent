import { t } from "./i18n.js";
import type { UiExtensionAPI } from "#sdk/sidepanel";
import { createDataFeature } from "./workspace/data-feature.js";
import { createDataReferences } from "./references.js";

export default function (qz: UiExtensionAPI) {
  const data = createDataFeature({
    root: qz.root, signal: qz.signal,
    isActive: () => qz.getCurrentPage() === "data",
    onStableViewChange: qz.notifyViewChange,
    startTrace: (name, detail) => qz.performance.start(name, detail) || (() => {}),
    gridTrace: qz.performance.grid,
    confirm: qz.dialogs.confirm, requestText: qz.dialogs.requestText,
    showToast: qz.showToast, hideToast: qz.hideToast,
    showArtifactToast: message => qz.showToast(message),
    beforeOpenArtifactTable: () => {
      qz.extensions.invoke("sessions.closeArtifacts");
      qz.navigate("data", { userInitiated: true, refresh: false });
    },
  });
  qz.onDispose(data.dispose);
  qz.extensions.register({
    references: [createDataReferences(data.listTables, data.formatTableDate)],
    commands: [{ id: "data.openTable", run: payload => {
      const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      return data.openArtifactTable(String(value.table || ""), {
        anchorEl: value.anchorEl instanceof HTMLElement ? value.anchorEl : null,
      });
    } }],
  });
  qz.on("data_changed", () => data.invalidate());
  qz.registerPage({
      id: "data", title: t("data"), order: 30, elements: [data.panel],
      activate: () => data.activate(), deactivate: data.deactivate,
      capture: () => ({ table: data.getCurrentTable() }),
      restore: state => {
        // Restore the destination before reveal; loading a table must not hold workspace startup.
        void data.restore(state && typeof state === "object" && "table" in state ? String(state.table || "") || null : null)
          .catch(error => { if (!qz.signal.aborted) console.debug("[轻舟] restore data table failed:", error); });
      },
  });
  qz.registerOverlay({ id: "data", priority: 40, close: data.closeTopmostTransientUi, blocksFocus: data.hasBlockingOverlay });
}
