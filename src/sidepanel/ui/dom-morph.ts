interface MorphOptions {
  beforeReplace?(current: ChildNode, next: ChildNode): void;
  beforeRemove?(node: ChildNode): void;
  preserveSubtree?(current: Element, next: Element): boolean;
}

export function morphElementChildren(current: Element, next: Element, options: MorphOptions = {}) {
  morphChildren(current, next, options);
}

export function morphNode(current: ChildNode | null, next: ChildNode | null, options: MorphOptions = {}) {
  if (!current || !next) return false;
  if (current.nodeType !== next.nodeType) {
    options.beforeReplace?.(current, next);
    current.replaceWith(next);
    return true;
  }
  if (current.nodeType === Node.TEXT_NODE) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return true;
  }
  if (!(current instanceof Element) || !(next instanceof Element)) return true;
  if (current.tagName !== next.tagName) {
    options.beforeReplace?.(current, next);
    current.replaceWith(next);
    return true;
  }
  if (options.preserveSubtree?.(current, next)) return true;

  patchAttributes(current, next);
  morphChildren(current, next, options);
  return true;
}

export function morphChildren(current: Node & ParentNode, next: Node & ParentNode, options: MorphOptions = {}) {
  let currentChild = current.firstChild;
  let nextChild = next.firstChild;

  while (currentChild || nextChild) {
    if (!currentChild && nextChild) {
      const inserted = nextChild;
      nextChild = nextChild.nextSibling;
      current.appendChild(inserted);
      continue;
    }
    if (currentChild && !nextChild) {
      const remove = currentChild;
      currentChild = currentChild.nextSibling;
      options.beforeRemove?.(remove);
      remove.remove();
      continue;
    }

    if (!currentChild || !nextChild) break;
    const followingCurrent: ChildNode | null = currentChild.nextSibling;
    const followingNext: ChildNode | null = nextChild.nextSibling;
    morphNode(currentChild, nextChild, options);
    currentChild = followingCurrent;
    nextChild = followingNext;
  }
}

export function patchAttributes(current: Element, next: Element) {
  for (const attr of Array.from(current.attributes)) {
    if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  }
  for (const attr of Array.from(next.attributes)) {
    if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  }
}

export function moveNodePreservingScrollState(parent: Element | null, node: Element | null, before: Node | null = null, options: { scrollSelector?: string } = {}) {
  if (!parent || !node || node === before) return false;
  if (node.parentNode !== parent) {
    parent.insertBefore(node, before);
    return true;
  }
  const selector = String(options.scrollSelector || "").trim();
  const targets = selector
    ? [
      ...(node.matches?.(selector) ? [node] : []),
      ...Array.from(node.querySelectorAll?.(selector) || []),
    ]
    : [];
  const scrollState = targets
    .map(target => ({
      target,
      top: target.scrollTop || 0,
      left: target.scrollLeft || 0,
    }))
    .filter(item => item.top !== 0 || item.left !== 0);

  parent.insertBefore(node, before);
  for (const item of scrollState) {
    if (!item.target.isConnected) continue;
    item.target.scrollTop = item.top;
    item.target.scrollLeft = item.left;
  }
  return true;
}

export function hasActiveSelectionInsideNode(node: Node | null) {
  const selection = document.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  if (containsSelectionNode(node, selection.anchorNode) || containsSelectionNode(node, selection.focusNode)) return true;
  for (let i = 0; i < selection.rangeCount; i += 1) {
    const range = selection.getRangeAt(i);
    if (containsSelectionNode(node, range.commonAncestorContainer)) return true;
  }
  return false;
}

export function containsSelectionNode(root: Node | null, candidate: Node | null) {
  if (!root || !candidate) return false;
  const node = candidate.nodeType === Node.ELEMENT_NODE ? candidate : candidate.parentNode;
  return Boolean(node && root.contains(node));
}
