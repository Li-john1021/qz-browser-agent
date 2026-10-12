import { localizeDocument } from "../i18n/dom.js";

/** Templates stay inert and reusable; only the current mount's clone is owned and removed. */
export function mountUiTemplate(root: Document, id: string, onDispose: (cleanup: () => void) => void): HTMLElement {
  const template = root.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) throw new Error(`UI template is missing: ${id}`);
  const container = root.createElement("div");
  container.style.display = "contents";
  container.append(template.content.cloneNode(true));
  localizeDocument(container);
  const ids = new Set<string>();
  for (const element of container.querySelectorAll("[id]")) {
    if (ids.has(element.id) || root.getElementById(element.id)) throw new Error(`Duplicate mounted UI id: ${element.id}`);
    ids.add(element.id);
  }
  const nodes = [...container.childNodes];
  onDispose(() => { for (const node of nodes) node.parentNode?.removeChild(node); container.remove(); });
  (root.getElementById("app") || root.body).append(container);
  return container;
}
