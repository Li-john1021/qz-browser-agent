import { withMathRuntime } from "./math-runtime.js";

const PENDING_MATH_SELECTOR = '.math-formula:not([data-math-pending="true"]):not([data-math-rendered="true"]):not([data-math-rendering="true"])';

export function createMathFeature({ signal }: { signal?: AbortSignal } = {}) {
  const pendingRoots = new Set<Element>();
  const owners = new Map<HTMLElement, symbol>();
  let frame = 0;
  let disposed = signal?.aborted === true;

  function schedule(root: Node | null) {
    if (disposed || !(root instanceof Element) || !root.querySelector(PENDING_MATH_SELECTOR)) return;
    pendingRoots.add(root);
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; void flush(); });
  }

  async function flush() {
    const targets = [...new Set([...pendingRoots].filter(root => root.isConnected)
      .flatMap(root => [...root.querySelectorAll<HTMLElement>(PENDING_MATH_SELECTOR)]))];
    pendingRoots.clear();
    if (disposed || !targets.length) return;
    // Loading is shared, but write authority belongs to this projection of each formula.
    const owner = Symbol();
    for (const target of targets) { owners.set(target, owner); target.dataset.mathRendering = "true"; }
    const current = (target: HTMLElement) => !disposed && target.isConnected && owners.get(target) === owner;
    try {
      await withMathRuntime(async runtime => {
        const active = targets.filter(current);
        if (!active.length) return;
        const stages = active.map(target => {
          const stage = target.ownerDocument.createElement("div");
          const style = getComputedStyle(target);
          stage.style.cssText = "position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;contain:layout style";
          stage.style.width = `${target.parentElement!.getBoundingClientRect().width}px`;
          stage.style.font = style.font;
          stage.style.lineHeight = style.lineHeight;
          stage.style.letterSpacing = style.letterSpacing;
          stage.inert = true;
          stage.setAttribute("aria-hidden", "true");
          const projection = target.cloneNode(true) as HTMLElement;
          // The measuring copy has no transcript ancestors or inherited reading-size variables.
          projection.style.font = style.font;
          projection.style.lineHeight = style.lineHeight;
          projection.style.letterSpacing = style.letterSpacing;
          projection.style.width = style.width;
          projection.style.padding = style.padding;
          stage.append(projection);
          target.ownerDocument.body.append(stage);
          return stage;
        });
        const projections = stages.map(stage => stage.firstElementChild as HTMLElement);
        try {
          // MathJax can resume after an asynchronous dependency; it never owns live message nodes.
          try { await runtime.typesetPromise(projections); }
          // Release MathJax's node references before SVG children move to the live projection.
          finally { runtime.typesetClear?.(projections); }
          for (const [index, target] of active.entries()) {
            if (!current(target)) continue;
            const projection = projections[index]!;
            delete target.dataset.mathRendering;
            if (projection.querySelector("mjx-merror")) renderFallback(target);
            else {
              target.replaceChildren(...projection.childNodes);
              target.dataset.mathRendered = "true";
            }
          }
        } finally { for (const stage of stages) stage.remove(); }
      });
    } catch (error) {
      const active = targets.filter(current);
      for (const target of active) { delete target.dataset.mathRendering; renderFallback(target); }
      if (active.length) console.warn("[sidepanel] MathJax typeset failed", error);
    } finally {
      for (const target of targets) if (owners.get(target) === owner) owners.delete(target);
    }
  }

  function renderFallback(target: HTMLElement) {
    const fallback = target.dataset.mathFallback || target.textContent || "";
    target.classList.add("math-fallback");
    target.dataset.mathRendered = "true";
    target.dataset.mathFallbackRendered = "true";
    target.textContent = fallback;
  }

  function clear(root: Node | null) {
    if (!(root instanceof Element)) return;
    for (const pending of pendingRoots) if (root === pending || root.contains(pending)) pendingRoots.delete(pending);
    try { window.MathJax?.typesetClear?.([root]); } catch { /* A removed subtree can already be absent from MathJax. */ }
    const formulas = [...root.querySelectorAll<HTMLElement>(".math-formula")];
    if (root instanceof HTMLElement && root.matches(".math-formula")) formulas.unshift(root);
    for (const formula of formulas) {
      owners.delete(formula);
      delete formula.dataset.mathRendered;
      delete formula.dataset.mathRendering;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    frame = 0;
    pendingRoots.clear();
    for (const target of owners.keys()) delete target.dataset.mathRendering;
    owners.clear();
    signal?.removeEventListener("abort", dispose);
  }
  signal?.addEventListener("abort", dispose, { once: true });

  return { schedule, clear, clearRemovedNode: clear, flush, dispose };
}
