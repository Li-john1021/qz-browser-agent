interface TreeOptions<T> {
  rootId?: string; expandedIds?: ReadonlySet<string>; getId?(item: T): unknown; getParentId?(item: T): unknown;
  compare?: ((a: T, b: T) => number) | null;
}
interface TreeNode<T> {
  id: string; item: T; parentId: string; depth: number; hasChildren: boolean; expanded: boolean; childCount: number;
  ariaLevel: number; ariaPosInSet: number; ariaSetSize: number; children: TreeNode<T>[];
}
function treeIdentity(value: unknown): { id?: unknown; parentId?: unknown } { return value && typeof value === "object" ? value : {}; }

/**
 * Small headless tree model for the Sessions tab.
 *
 * It follows the WAI-ARIA TreeView data shape: each node carries
 * aria-level / aria-posinset / aria-setsize while the renderer owns DOM/CSS.
 */

export function buildTreeNodes<T>(items: T[], {
  rootId = "0",
  expandedIds = new Set(),
  getId = item => treeIdentity(item).id,
  getParentId = item => treeIdentity(item).parentId,
  compare = null,
}: TreeOptions<T> = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const ids = new Set(list.map(item => String(getId(item) || "")).filter(Boolean));
  const parentById = normalizeParents(list, { rootId, ids, getId, getParentId });
  const childrenByParent = buildChildrenByParent(list, { rootId, parentById, getId, compare });
  const visited = new Set<string>();

  const visit = (parentId: string, depth: number): TreeNode<T>[] => {
    const children = childrenByParent.get(parentId) || [];
    return children.map((item, index) => {
      const id = String(getId(item) || "");
      if (!id || visited.has(id)) return null;
      visited.add(id);

      const childrenOfItem = childrenByParent.get(id) || [];
      const childCount = childrenOfItem.length;
      const hasChildren = childCount > 0;
      const expanded = hasChildren && expandedIds.has(id);

      const node: TreeNode<T> = {
        id,
        item,
        parentId,
        depth,
        hasChildren,
        expanded,
        childCount,
        ariaLevel: depth + 1,
        ariaPosInSet: index + 1,
        ariaSetSize: children.length,
        children: [],
      };

      if (expanded) node.children = visit(id, depth + 1);
      return node;
    }).filter((node): node is TreeNode<T> => node !== null);
  };

  return { nodes: visit(rootId, 0), childrenByParent };
}

function normalizeParents<T>(list: T[], { rootId, ids, getId, getParentId }: Pick<Required<TreeOptions<T>>, "rootId" | "getId" | "getParentId"> & { ids: ReadonlySet<string> }) {
  const parentById = new Map<string, string>();

  for (const item of list) {
    const id = String(getId(item) || "");
    if (!id) continue;
    let parentId = String(getParentId(item) || rootId);
    if (parentId === id || (parentId !== rootId && !ids.has(parentId))) {
      parentId = rootId;
    }
    parentById.set(id, parentId);
  }

  for (const id of parentById.keys()) {
    const seen = new Set([id]);
    let parentId = parentById.get(id) || rootId;
    while (parentId !== rootId) {
      if (seen.has(parentId)) {
        parentById.set(id, rootId);
        break;
      }
      seen.add(parentId);
      parentId = parentById.get(parentId) || rootId;
    }
  }

  return parentById;
}

function buildChildrenByParent<T>(list: T[], { rootId, parentById, getId, compare }: Pick<Required<TreeOptions<T>>, "rootId" | "getId" | "compare"> & { parentById: ReadonlyMap<string, string> }) {
  const childrenByParent = new Map<string, T[]>();
  for (const item of list) {
    const id = String(getId(item) || "");
    if (!id) continue;
    const parentId = parentById.get(id) || rootId;
    const children = childrenByParent.get(parentId) || [];
    children.push(item);
    childrenByParent.set(parentId, children);
  }

  if (typeof compare === "function") {
    for (const children of childrenByParent.values()) {
      children.sort(compare);
    }
  }

  return childrenByParent;
}
