// Privilege is process-local provenance, never a serialized builtin/system flag.
const records = new WeakMap<object, string>();
const manifests = new WeakMap<object, string>();
const unchanged = (store: WeakMap<object, string>, value: object) => {
  try { return store.has(value) && store.get(value) === JSON.stringify(value); }
  catch { return false; }
};
export function trustEmbeddedSkill<T extends object>(skill: T): T {
  records.set(skill, JSON.stringify(skill));
  return skill;
}
export function isTrustedEmbeddedSkill(skill: object): boolean { return unchanged(records, skill); }
export function trustSkillManifest<T extends object>(manifest: T): T {
  manifests.set(manifest, JSON.stringify(manifest));
  return manifest;
}
export function isTrustedSkillManifest(manifest: object): boolean { return unchanged(manifests, manifest); }
export function copySkillManifestTrust(source: object, target: object): void {
  if (isTrustedSkillManifest(source)) trustSkillManifest(target);
}
