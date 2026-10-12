import assert from "node:assert/strict";
import test from "node:test";
import { resolveProviderPresets } from "../../src/background/llm/provider-presets.js";

const definition = Object.freeze({ label: "Catalog provider", api: "openai-chat-completions", protocol: "openai", endpoint: "https://example.test/v1/chat/completions" });

test("explicit provider overrides apply after definitions regardless of contribution order", () => {
  const base = { example: definition };
  const patch = { example: { override: true, requestHeaders: { "x-client": "example" } } };
  for (const records of [[base, patch], [patch, base], [undefined, patch, base]]) {
    const resolved = resolveProviderPresets(records);
    assert.equal(resolved.example.endpoint, definition.endpoint);
    assert.equal(resolved.example.label, definition.label);
    assert.equal(resolved.example.requestHeaders["x-client"], "example");
    assert.equal(Object.hasOwn(resolved.example, "override"), false);
    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.getPrototypeOf(resolved), null);
  }
  assert.equal(resolveProviderPresets([base]).example, definition, "unmodified definitions retain their identity");
});

test("provider declarations reject ambiguous identities and overrides without targets", () => {
  assert.throws(() => resolveProviderPresets([{ example: definition }, { example: definition }]), /Duplicate provider identity: example/);
  for (const id of ["", "  "]) {
    assert.throws(() => resolveProviderPresets([{ [id]: definition }]), /Empty provider identity/);
    assert.throws(() => resolveProviderPresets([{ [id]: { override: true } }]), /Empty provider identity/);
  }
  assert.throws(() => resolveProviderPresets([{ example: { override: true, hideEndpoint: true } }]), /Cannot override missing provider: example/);
  assert.throws(() => resolveProviderPresets([
    { example: { override: true, hideEndpoint: true } }, { example: definition }, { example: { override: true, requiresApiKey: false } },
  ]), /Duplicate provider override: example/);
});

test("patching frozen definitions preserves live getters, handlers and source objects", async () => {
  let language = "en";
  let reads = 0;
  const auth = { status: async () => ({ loggedIn: false }) };
  const originalListModels = async () => ["original"];
  const replacementListModels = async () => ["replacement"];
  const base = Object.freeze({ ...definition, auth, listModels: originalListModels,
    get label() { reads++; return language === "en" ? "Catalog provider" : "目录服务商"; },
    get modelOptions() { reads++; return [{ key: "reasoning", label: language }]; },
  });
  const patch = Object.freeze({ override: true, listModels: replacementListModels,
    get label() { reads++; return language === "en" ? "Specialized provider" : "专用服务商"; },
  });
  const beforeBase = Object.getOwnPropertyDescriptors(base);
  const beforePatch = Object.getOwnPropertyDescriptors(patch);
  const resolved = resolveProviderPresets([{ example: base }, { example: patch }]).example;
  assert.equal(reads, 0, "registration must not eagerly translate declarations");
  assert.equal(resolved.auth, auth);
  assert.equal(resolved.listModels, replacementListModels);
  assert.deepEqual(await resolved.listModels(), ["replacement"]);
  assert.equal(resolved.label, "Specialized provider");
  assert.equal(resolved.modelOptions[0].label, "en");
  language = "zh-CN";
  assert.equal(resolved.label, "专用服务商");
  assert.equal(resolved.modelOptions[0].label, "zh-CN");
  assert.equal(base.listModels, originalListModels);
  assert.equal(base.label, "目录服务商");
  assert.deepEqual(Object.getOwnPropertyDescriptors(base), beforeBase);
  assert.deepEqual(Object.getOwnPropertyDescriptors(patch), beforePatch);
});

test("provider registry treats prototype property names as ordinary independent identities", () => {
  const resolved = resolveProviderPresets([
    { ["__proto__"]: definition, constructor: definition },
    { ["__proto__"]: { override: true, hideEndpoint: true } },
  ]);
  assert.equal(resolved.__proto__.hideEndpoint, true);
  assert.equal(resolved.constructor, definition);
  assert.throws(() => { resolved.extra = definition; }, TypeError);
  assert.throws(() => { delete resolved.constructor; }, TypeError);
});
