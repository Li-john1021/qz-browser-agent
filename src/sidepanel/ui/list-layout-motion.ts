interface ListMotionOptions {
  root(): HTMLElement | null;
  selector: string;
  key(element: HTMLElement): string;
  reduceMotion(): boolean;
  duration?: number;
  enterDuration?: number;
}

/** Read all geometry before writes; only the current animation may clear a row's moving state. */
export function createListLayoutMotion({ root, selector, key, reduceMotion, duration = 260, enterDuration = 0 }: ListMotionOptions) {
  const animations = new WeakMap<HTMLElement, Animation>();
  const items = (container: HTMLElement | null) => Array.from(container?.querySelectorAll<HTMLElement>(selector) || [])
    .filter(item => !item.closest('[data-session-removing="true"]'));
  function capture(container = root()) {
    const rects = new Map<string, DOMRect>();
    if (!reduceMotion()) for (const item of items(container)) {
      const id = key(item);
      if (id) rects.set(id, item.getBoundingClientRect());
    }
    return rects;
  }
  function animate(previousRects: ReadonlyMap<string, DOMRect>) {
    if (!previousRects.size || reduceMotion()) return;
    const moves = items(root()).map(item => ({ item, previous: previousRects.get(key(item)), next: item.getBoundingClientRect() }));
    for (const { item, previous, next } of moves) {
      if (!previous) {
        if (enterDuration) item.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: enterDuration, easing: "linear" });
        continue;
      }
      const dx = previous.left - next.left, dy = previous.top - next.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      animations.get(item)?.cancel();
      item.classList.add("is-layout-moving");
      const animation = item.animate?.([{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: "translate3d(0, 0, 0)" }], {
        duration, easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      });
      if (!animation) { item.classList.remove("is-layout-moving"); continue; }
      animations.set(item, animation);
      const cleanup = () => {
        if (animations.get(item) !== animation) return;
        animations.delete(item);
        item.classList.remove("is-layout-moving");
      };
      animation.finished.catch(() => {}).finally(cleanup);
      window.setTimeout(cleanup, duration + 120);
    }
  }
  function settle() {
    for (const item of items(root())) {
      animations.get(item)?.cancel();
      animations.delete(item);
      item.classList.remove("is-layout-moving");
    }
  }
  return Object.freeze({ capture, animate, settle });
}

interface ListExitOptions { className: string; keyframes: Keyframe[]; duration: number; easing: string }

/** Only the current exit may commit its replacement; cancellation revokes it first. */
export function createListExitTransition({ className, keyframes, duration, easing }: ListExitOptions) {
  let active: { nodes: Element[]; animations: Animation[]; timer: number } | null = null;
  function cancel() {
    const exit = active;
    if (!exit) return;
    active = null;
    window.clearTimeout(exit.timer);
    for (const animation of exit.animations) animation.cancel();
    for (const node of exit.nodes) node.classList.remove(className);
  }
  function start(nodes: Element[], commit: () => void) {
    cancel();
    const animations: Animation[] = [];
    for (const node of nodes) {
      node.classList.add(className);
      if (typeof node.animate === "function") {
        animations.push(node.animate(keyframes, { duration, easing, fill: "forwards" }));
      }
    }
    const exit = { nodes, animations, timer: 0 };
    active = exit;
    const finish = () => {
      if (active !== exit) return;
      active = null;
      window.clearTimeout(exit.timer);
      commit();
    };
    exit.timer = window.setTimeout(finish, duration + 100);
    Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(finish);
  }
  return { start, cancel };
}
