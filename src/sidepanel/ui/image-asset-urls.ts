import { getImageAssetObjectUrl } from "../../shared/asset-store.js";

export interface ImageAssetUrlOptions {
  loadAsset?(id: string): Promise<{ objectUrl: string } | null>;
  revokeUrl?(url: string): void;
}
interface Entry { promise: Promise<string | null>; url?: string | null }

/** Each UI instance owns a scope. Late results from retired entries are revoked immediately. */
export function createImageAssetUrls(options: ImageAssetUrlOptions = {}) {
  const load = options.loadAsset || (id => getImageAssetObjectUrl(id, { thumbnail: false, touch: false }));
  const revoke = options.revokeUrl || (url => URL.revokeObjectURL(url));
  const entries = new Map<string, Entry>();
  let disposed = false;
  function retain(ids: ReadonlySet<string>) {
    for (const [id, entry] of entries) if (!ids.has(id)) {
      entries.delete(id);
      if (entry.url) revoke(entry.url);
    }
  }
  function acquire(id: string): Promise<string | null> {
    if (disposed || !id) return Promise.resolve(null);
    const current = entries.get(id);
    if (current) return current.promise;
    const entry: Entry = { promise: Promise.resolve(null) };
    entries.set(id, entry);
    entry.promise = Promise.resolve().then(() => load(id)).then(asset => {
      const url = asset?.objectUrl || null;
      if (disposed || entries.get(id) !== entry) { if (url) revoke(url); return null; }
      entry.url = url;
      return url;
    }, () => { entry.url = null; return null; });
    return entry.promise;
  }
  return {
    acquire, retain,
    peek(id: string) { return entries.get(id)?.url; },
    dispose() { disposed = true; retain(new Set()); },
  };
}
