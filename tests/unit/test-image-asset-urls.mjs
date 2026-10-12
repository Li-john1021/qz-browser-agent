import assert from "node:assert/strict";
import { createImageAssetUrls } from "../../src/sidepanel/ui/image-asset-urls.js";

const loads = [], revoked = [];
const urls = createImageAssetUrls({
  loadAsset: id => new Promise((resolve, reject) => loads.push({ id, resolve, reject })),
  revokeUrl: url => revoked.push(url),
});
const first = urls.acquire("one");
assert.equal(urls.acquire("one"), first, "simultaneous readers share one asset request");
await Promise.resolve();
urls.retain(new Set());
const replacement = urls.acquire("one");
await Promise.resolve();
loads[0].resolve({ objectUrl: "blob:retired" });
assert.equal(await first, null);
assert.deepEqual(revoked, ["blob:retired"]);
loads[1].resolve({ objectUrl: "blob:current" });
assert.equal(await replacement, "blob:current");
assert.equal(urls.peek("one"), "blob:current");
const failure = urls.acquire("failure"); await Promise.resolve();
loads[2].reject(new Error("unavailable"));
assert.equal(await failure, null);
assert.equal(await urls.acquire("failure"), null);
assert.equal(loads.length, 3, "failed assets do not retry on each render");
const late = urls.acquire("late"); await Promise.resolve();
urls.dispose(); urls.dispose();
loads[3].resolve({ objectUrl: "blob:after-disposal" });
assert.equal(await late, null);
assert.equal(await urls.acquire("new"), null);
assert.deepEqual(revoked, ["blob:retired", "blob:current", "blob:after-disposal"]);
assert.equal(loads.length, 4);
console.log("image asset URL lifecycle tests passed");
