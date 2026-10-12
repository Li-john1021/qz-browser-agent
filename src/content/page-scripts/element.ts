/** Compiled together for CDP injection; helpers may share this module, never Background closures. */
function elementSelector(target: Element, { includeRoot = false, maxParts = Infinity, ancestorIdTag = false } = {}): string {
  if (target.id) return `#${escapeIdentifier(target.id)}`;
  const parts: string[] = [];
  let node: Element | null = target;
  while (node && node.nodeType === Node.ELEMENT_NODE && (includeRoot || node !== document.documentElement) && parts.length < maxParts) {
    let part = node.localName || node.tagName.toLowerCase();
    if (!part) break;
    if (node.id) {
      parts.unshift(`${ancestorIdTag ? part : ''}#${escapeIdentifier(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const localName = node.localName;
      const siblings = Array.from(parent.children).filter(child => child.localName === localName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}
function escapeIdentifier(value: string): string {
  return typeof globalThis.CSS?.escape === 'function' ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
}
export function selector(value: unknown): string {
  const element = value instanceof Element ? value : value instanceof Node ? value.parentElement : null;
  return element ? elementSelector(element, { includeRoot: true, maxParts: 12, ancestorIdTag: true }) : '';
}
export function bounds(value: unknown) {
  if (!(value instanceof Element)) return { error: 'Resolved node is not an Element' };
  const rect = value.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (rect.width <= 0 || rect.height <= 0) return { error: 'Element has no rendered box to screenshot', rect: box };
  const vv = window.visualViewport;
  const pageX = vv && Number.isFinite(vv.pageLeft) ? vv.pageLeft : window.scrollX;
  const pageY = vv && Number.isFinite(vv.pageTop) ? vv.pageTop : window.scrollY;
  return {
    selector: elementSelector(value),
    bounds: { x: rect.left + pageX, y: rect.top + pageY, width: rect.width, height: rect.height },
    rect: box,
    viewport: {
      pageX, pageY, scrollX: window.scrollX, scrollY: window.scrollY,
      scale: vv && Number.isFinite(vv.scale) ? vv.scale : 1,
      width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1,
    },
  };
}
