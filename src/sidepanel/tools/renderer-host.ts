import { t } from "../i18n/index.js";
import type { ToolView } from "../../sdk/sidepanel/renderers.js";
import { hasActiveSelectionInsideNode, morphChildren } from "../ui/dom-morph.js";

export type { ToolView };
export type { RendererContext, RendererInstance, RendererDefinition } from "../../sdk/sidepanel/renderers.js";
import type { RendererContext, RendererInstance, RendererDefinition } from "../../sdk/sidepanel/renderers.js";
type Plan = { registry: RendererRegistry; view: ToolView; static: boolean };
type Mounted = { definition: RendererDefinition; instance: RendererInstance; controller: AbortController; id: string; view: ToolView };
const plans = new WeakMap<HTMLElement, Plan>();
const mounted = new WeakMap<HTMLElement, Mounted>();
const selector = "[data-tool-renderer]";
let staticProjection = false;
let deferredMounts = 0;
let renderPath: readonly string[] = [];
const renderPaths = new WeakMap<ToolView, readonly string[]>();
export function isStaticRendererProjection(): boolean { return staticProjection; }
export function prepareRendererTree<T>(create: () => T): T {
  deferredMounts += 1;
  try { return create(); } finally { deferredMounts -= 1; }
}

export function createToolView(value: Partial<ToolView>): ToolView {
  return Object.freeze({
    id: value.id || value.name || "tool", rendererId: value.rendererId || "generic",
    name: value.name || "", title: value.title || "", state: value.state || "completed",
    args: value.args || {}, result: value.result, originalResult: value.originalResult,
    rawArgsText: value.rawArgsText || "", hasResult: value.hasResult ?? value.result != null,
    isRunning: value.isRunning === true, isError: value.isError === true,
    argsIncomplete: value.argsIncomplete === true, profileFamily: value.profileFamily || "",
    status: value.status || { title: t("completed"), tone: "success" },
  });
}

/** Each execution context owns its registry; installed Skills can only contribute declarative IR. */
export class RendererRegistry {
  private definitions = new Map<string, RendererDefinition>();
  private generation = 0;
  get revision(): number { return this.generation; }
  constructor(private readonly fallback: RendererDefinition) { this.definitions.set(fallback.id, fallback); }
  register(definition: RendererDefinition): () => void {
    if (!definition.id.trim() || this.definitions.has(definition.id)) throw new Error(`Duplicate or empty renderer: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    this.generation += 1;
    return () => {
      if (this.definitions.get(definition.id) !== definition) return;
      this.definitions.delete(definition.id);
      this.generation += 1;
    };
  }
  resolve(id: string): RendererDefinition { return this.definitions.get(id) || this.fallback; }
  render(parent: HTMLElement, view: ToolView): true {
    const container = parent.ownerDocument.createElement("div");
    container.style.display = "contents";
    if (renderPath.includes(view.rendererId)) container.append(readableFallback(view, parent.ownerDocument));
    else {
      const child = createToolView({ ...view, id: `${view.id}/${view.rendererId}` });
      renderPaths.set(child, [...renderPath, view.rendererId]);
      planRenderer(container, this, child, staticProjection);
    }
    parent.append(container);
    return true;
  }
  renderStatic(view: ToolView, document: Document): Node {
    const previous = staticProjection;
    const previousPath = renderPath;
    staticProjection = true;
    renderPath = renderPaths.get(view) || [view.rendererId];
    try { return this.resolve(view.rendererId).renderStatic(view, { document }); }
    catch { return readableFallback(view, document); }
    finally { staticProjection = previous; renderPath = previousPath; }
  }
}

export function readableFallback(view: ToolView, document: Document): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "tool-renderer-fallback";
  try { pre.textContent = JSON.stringify(view.hasResult ? view.result : view.args, null, 2) ?? t("noDisplayableResult"); }
  catch { pre.textContent = String(view.result ?? t("cannotDisplayResult")); }
  return pre;
}

/** Planning creates no live instance. A morph may discard this tree without leaking listeners. */
export function planRenderer(container: HTMLElement, registry: RendererRegistry, view: ToolView, staticOutput = false): void {
  container.dataset.toolRenderer = view.rendererId;
  container.dataset.toolRendererKey = view.id;
  plans.set(container, { registry, view, static: staticOutput });
  if (staticOutput) {
    container.replaceChildren(registry.renderStatic(view, container.ownerDocument));
    commitRendererTree(container);
  }
}

export function commitRendererTree(root: Element): void {
  if (deferredMounts) return;
  if (root instanceof HTMLElement && root.matches(selector)) commit(root);
  for (const child of root.children) commitRendererTree(child);
}

/** Single → timeline/family upgrades move the existing component after its new shell is connected. */
export function adoptRendererTree(source: Element, target: Element): void {
  for (const next of target.querySelectorAll<HTMLElement>(selector)) {
    const plan = plans.get(next);
    if (!plan || mounted.has(next)) continue;
    const current = [...source.querySelectorAll<HTMLElement>(selector)].find(node =>
      node !== next && mounted.get(node)?.id === plan.view.id && plans.get(node)?.registry === plan.registry,
    );
    if (!current) continue;
    const active = current.ownerDocument.activeElement;
    const focused = active instanceof HTMLElement && current.contains(active) ? active : null;
    const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
    const caret = input?.selectionStart != null ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null;
    const selection = current.ownerDocument.getSelection();
    const range = !input && selection && current.contains(selection.anchorNode) && current.contains(selection.focusNode)
      ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset } : null;
    plans.set(current, plan);
    next.replaceWith(current);
    focused?.focus({ preventScroll: true });
    if (caret) input?.setSelectionRange(caret.start, caret.end, caret.direction || undefined);
    if (range?.anchor && range.focus) selection?.setBaseAndExtent(range.anchor, range.anchorOffset, range.focus, range.focusOffset);
  }
  commitRendererTree(target);
}

function commit(container: HTMLElement): void {
  const plan = plans.get(container);
  if (!plan || plan.static) return;
  const definition = plan.registry.resolve(plan.view.rendererId);
  let current = mounted.get(container);
  if (current?.definition === definition && current.view === plan.view) return;
  if (current && (current.definition !== definition || current.id !== plan.view.id)) {
    disposeRendererTree(container);
    current = undefined;
  }
  const previousPath = renderPath;
  renderPath = renderPaths.get(plan.view) || [plan.view.rendererId];
  try {
    if (current) { current.instance.update(plan.view); current.view = plan.view; }
    else {
      const controller = new AbortController();
      // Instance lifetime is independent of the Agent run; abort also cleans up a failed mount.
      try {
        container.replaceChildren();
        const instance = definition.mount(container, plan.view, { document: container.ownerDocument, signal: controller.signal });
        mounted.set(container, { definition, instance, controller, id: plan.view.id, view: plan.view });
      } catch (error) { controller.abort(); throw error; }
    }
  } catch {
    disposeRendererTree(container);
    container.replaceChildren(readableFallback(plan.view, container.ownerDocument));
  } finally { renderPath = previousPath; }
}

export function disposeRendererTree(root: Node): void {
  if (!(root instanceof Element)) return;
  for (const child of root.children) disposeRendererTree(child);
  if (!(root instanceof HTMLElement)) return;
  const current = mounted.get(root);
  mounted.delete(root);
  if (!current) return;
  current.controller.abort();
  try { current.instance.dispose(); } catch { /* A broken renderer cannot prevent sibling cleanup. */ }
}

/** Protect live component subtrees from the outer transcript/timeline morph. */
export function preserveRendererSubtree(current: Node, next: Node): boolean {
  if (!(current instanceof HTMLElement) || !(next instanceof HTMLElement)) return false;
  const plan = plans.get(next);
  if (!plan) {
    if (mounted.has(current)) { disposeRendererTree(current); plans.delete(current); }
    return false;
  }
  if (current.dataset.toolRendererKey !== next.dataset.toolRendererKey) {
    disposeRendererTree(current);
    current.replaceWith(next);
    commitRendererTree(next);
    return true;
  }
  plans.set(current, plan);
  current.dataset.toolRenderer = next.dataset.toolRenderer;
  if (!hasActiveSelectionInsideNode(current)) commitRendererTree(current);
  return true;
}

export function morphRendererChildren(current: HTMLElement, next: HTMLElement, commit = true): void {
  morphChildren(current, next, {
    preserveSubtree: preserveRendererSubtree,
    beforeRemove: disposeRendererTree,
    beforeReplace: disposeRendererTree,
  });
  if (commit) for (const child of current.children) commitRendererTree(child);
}

/** Ordinary profiles and declarative IR share this lifecycle instead of implementing instances. */
export function projectedRenderer(id: string, project: (parent: HTMLElement, view: ToolView, staticOutput: boolean) => void): RendererDefinition {
  const renderStatic = (view: ToolView, context: Pick<RendererContext, "document">) => {
    const root = context.document.createElement("div");
    root.style.display = "contents";
    project(root, view, true);
    return root;
  };
  return {
    id, renderStatic,
    mount(container, view) {
      const update = (next: ToolView): undefined => {
        const projected = container.ownerDocument.createElement("div");
        project(projected, next, false);
        morphRendererChildren(container, projected);
      };
      update(view);
      return { update, dispose() {} };
    },
  };
}
