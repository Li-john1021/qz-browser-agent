import type { RendererDefinition, ToolView } from "#sdk/sidepanel";
import { t } from "./i18n.js";
import { parseExampleTableResult } from "./result.js";

function valueContent(view: ToolView) {
  const result = parseExampleTableResult(view.result);
  // Keep the original payload for unknown historical results and errors; never turn them into success.
  const value = view.result ?? view.args;
  return {
    label: result?.title || view.title,
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

/** Local display state survives updates; static export remains readable without extension code. */
export const valueCardRenderer: RendererDefinition = {
  id: "example.value-card",
  renderStatic(view, { document }) {
    const value = document.createElement("pre");
    const { label, text } = valueContent(view);
    value.setAttribute("aria-label", label);
    value.textContent = text;
    return value;
  },
  mount(container, view, { document, signal }) {
    const button = document.createElement("button");
    button.className = "qz-btn qz-btn--secondary qz-btn--sm";
    button.type = "button";
    const value = document.createElement("pre");
    container.append(button, value);
    let compact = true;
    let current = view;
    const draw = () => {
      const { label, text } = valueContent(current);
      value.setAttribute("aria-label", label);
      value.textContent = compact && text.length > 80 ? `${text.slice(0, 80)}…` : text;
      button.textContent = compact ? t("showFull") : t("showSummary");
      button.setAttribute("aria-expanded", String(!compact));
    };
    button.addEventListener("click", () => { compact = !compact; draw(); }, { signal });
    draw();
    return { update(next) { current = next; draw(); }, dispose() {} };
  },
};
