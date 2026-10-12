import assert from "node:assert/strict";
import { test, after } from "node:test";
import { ensureOffscreenDocument } from "../../src/background/services/offscreen-document.js";
import { createOffscreenKeepalive } from "../../src/background/services/offscreen-keepalive.js";
const originalChrome = globalThis.chrome;
after(() => { globalThis.chrome = originalChrome; });

test("concurrent consumers share creation and reuse the existing document", async () => {
  let exists = false;
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.chrome = { offscreen: {
    hasDocument: async () => exists,
    createDocument: async () => { calls++; await gate; exists = true; },
  } };
  const scripts = ensureOffscreenDocument();
  const images = ensureOffscreenDocument();
  const keepalive = createOffscreenKeepalive().ensure();
  assert.equal(scripts, images);
  release();
  await Promise.all([scripts, images, keepalive]);
  assert.equal(calls, 1);
  assert.deepEqual(await ensureOffscreenDocument(), { existed: true });
  assert.equal(calls, 1);
});

test("failed creation releases the lock so the next call can recover", async () => {
  let calls = 0;
  globalThis.chrome = { offscreen: {
    hasDocument: async () => false,
    createDocument: async () => { if (++calls === 1) throw new Error("creation failed"); },
  } };
  await assert.rejects(ensureOffscreenDocument(), /creation failed/);
  assert.deepEqual(await ensureOffscreenDocument(), { existed: false });
  assert.equal(calls, 2);
});

test("a document created by another context wins the creation race", async () => {
  let exists = false;
  globalThis.chrome = { offscreen: {
    hasDocument: async () => exists,
    createDocument: async () => { exists = true; throw new Error("only one document allowed"); },
  } };
  assert.deepEqual(await ensureOffscreenDocument(), { existed: true });
});
