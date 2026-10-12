/** Live and exported timelines share traversal; their hosts supply only stable family IDs. */
export function resolveFamilyTimelineTarget(familyIds: readonly string[], index: number, direction: number, mode = "family"): number {
  if (!familyIds.length) return index;
  const current = Math.max(0, Math.min(familyIds.length - 1, Number(index) || 0));
  const step = Math.sign(Number(direction) || 0);
  if (!step) return current;
  if (mode !== "family") return Math.max(0, Math.min(familyIds.length - 1, current + step));
  const groups = new Map<string, number[]>();
  familyIds.forEach((family, item) => {
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family)!.push(item);
  });
  const order = [...groups.values()].flat();
  const position = order.indexOf(current);
  return position < 0 ? current : order[position + step] ?? current;
}
