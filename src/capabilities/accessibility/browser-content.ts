import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { appendHtmlSection, escapeHtml } from "#sdk/sidepanel/dom";
import { record } from "#sdk/sidepanel/presentation";
import { createTreeRenderer } from "#sdk/sidepanel/components";
import type { ProfileHelpers } from "#sdk/sidepanel/components";

export function createTreeProfiles({ renderDataCell }: ProfileHelpers) {
  const tree = createTreeRenderer();
  return {
    renderPageTree(parent: HTMLElement, name: string, args: Record<string, unknown>, value: unknown) {
      return tree.render(parent, args, value, { title: name === "get_ax_tree" ? t("pageStructure") : "DOM",
        appendDetails: name === "get_ax_tree" ? (section, result) => appendAxActionsProfile(section, result.actions) : undefined });
    },
  };

function appendAxActionsProfile(parent: HTMLElement, actions: unknown = []) {
  const items = Array.isArray(actions) ? actions.filter(Boolean).map(record) : [];
  if (!items.length) return;
  const rows = items.slice(0, 8).map(action => ({
    element: presentation.firstNonEmpty([
      action.name,
      action.text,
      action.value,
      action.placeholder,
      action.href,
      action.role,
      action.target,
    ]) || t("element"),
    target: action.target || "",
    state: [
      action.role,
      action.editable ? t("editable") : "",
      action.disabled ? "disabled" : "",
      typeof action.checked === "boolean" ? (action.checked ? "checked" : "unchecked") : "",
      action.inViewport === false ? t("outsideViewport") : "",
    ].filter(Boolean).join(" · "),
  }));
  appendHtmlSection(parent, "tool-data-table-section tool-ax-actions-table", `
    <div class="tool-data-table-head">
      <div class="tool-data-table-title">${escapeHtml(t("interactiveElements"))}</div>
      <div class="tool-data-table-meta">
        <span>${escapeHtml(String(items.length))} ${escapeHtml(t("items"))}</span>
        ${items.length > rows.length ? `<span>${escapeHtml(t("showingTheFirst"))} ${escapeHtml(String(rows.length))} ${escapeHtml(t("items"))}</span>` : ""}
      </div>
    </div>
    <div class="tool-data-table-wrap">
      <table class="tool-data-table">
        <thead>
          <tr>
            <th>${escapeHtml(t("element"))}</th>
            <th>target</th>
            <th>${escapeHtml(t("attributes"))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              ${renderDataCell(row.element)}
              ${renderDataCell(row.target)}
              ${renderDataCell(row.state)}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `);
}

}
