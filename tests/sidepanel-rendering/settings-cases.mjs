import assert from "node:assert/strict";
import { captureSkillDraftSave, classifySkillDraftSave, createSkillDraft } from "../../src/capabilities/skills/workspace/skill-draft.js";
import { createModelOptionsController } from "../../src/capabilities/settings/model-options.js";
import { createDeferred } from "./helpers.mjs";

export function testSkillDraft() {
  const draft = createSkillDraft({ name: "demo", content: "old" }, {
    parse: source => ({ body: source.replace(/^BODY:/, "") }),
    serialize: value => `BODY:${value.body}`,
  });
  assert.equal(draft.dirty, false);
  const first = draft.update({ body: "new" }, { expectedRevision: 0 });
  assert.equal(first.authority, "structured");
  assert.equal(draft.serialize(), "BODY:new");
  const unchangedRevision = draft.update({ body: "new" }).revision;
  assert.equal(unchangedRevision, first.revision, "equivalent edits must not advance the revision");
  assert.throws(() => draft.update({ body: "bad" }, { expectedRevision: 0 }), error => error.code === "SKILL_DRAFT_REVISION_MISMATCH");
  draft.replaceFromSource("BODY:source", { expectedRevision: first.revision });
  assert.equal(draft.snapshot().body, "source");
  assert.equal(draft.authority, "source");
  draft.setAuthority("structured");
  assert.equal(draft.authority, "structured");
  draft.markSaved();
  assert.equal(draft.dirty, false);
  draft.reset({ name: "next", content: "reset" });
  assert.equal(draft.snapshot().metadata.name, "next");
  assert.equal(draft.dirty, false);
}

export function testSkillSaveIsolation() {
  const first = createSkillDraft({ name: "demo", content: "initial" });
  const snapshot = captureSkillDraftSave(first, "demo");
  assert.deepEqual(classifySkillDraftSave(snapshot, first, "demo"), {
    editorStillCurrent: true,
    saveIsCurrent: true,
  });

  first.update({ body: "edited while saving" });
  assert.deepEqual(classifySkillDraftSave(snapshot, first, "demo"), {
    editorStillCurrent: true,
    saveIsCurrent: false,
  });

  const second = createSkillDraft({ name: "other", content: "other" });
  assert.deepEqual(classifySkillDraftSave(snapshot, second, "other"), {
    editorStillCurrent: false,
    saveIsCurrent: false,
  });
  assert.equal(first.snapshot().body, "edited while saving");
}

export async function testModelRequestIsolation() {
  const requests = [];
  const controller = createModelOptionsController({
    loadModels(input) {
      const deferred = createDeferred();
      requests.push({ input, deferred });
      return deferred.promise;
    },
  });
  const first = controller.load({ provider: "one" });
  const second = controller.load({ provider: "two" });
  requests[0].deferred.resolve({ provider: "one", models: [{ id: "old", name: "Old" }] });
  requests[1].deferred.resolve({ provider: "two", models: [{ id: "new", name: "New" }] });
  const [oldResult, newResult] = await Promise.all([first, second]);
  assert.equal(oldResult.stale, true);
  assert.equal(newResult.stale, false);
  assert.equal(newResult.models[0].id, "new");

  const staleFailureController = createModelOptionsController({
    loadModels(input) { return input.provider === "old" ? Promise.reject(new Error("old failed")) : Promise.resolve([]); },
  });
  const oldFailure = staleFailureController.load({ provider: "old" });
  const current = staleFailureController.load({ provider: "new" });
  assert.equal((await oldFailure).stale, true);
  assert.equal((await current).stale, false);
}

export async function testModelCacheContracts() {
  const calls = [];
  const controller = createModelOptionsController({
    cacheLimit: 2,
    async loadModels(input) {
      calls.push({ ...input });
      return { provider: input.provider, models: [{ id: `${input.provider}-${input.credentialVersion}`, name: "Model" }] };
    },
  });
  await controller.load({ provider: "p1", endpoint: "https://one", credentialVersion: "key-a" });
  const cached = await controller.load({ provider: "p1", endpoint: "https://one", credentialVersion: "key-a" });
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1);
  await controller.load({ provider: "p1", endpoint: "https://one", credentialVersion: "key-b" });
  await controller.load({ provider: "p2", credentialVersion: "key-c" });
  assert.equal(controller.getSnapshot().cacheSize, 2);
  assert.equal(controller.peek({ provider: "p1", endpoint: "https://one", credentialVersion: "key-a" }), null);

  const pending = createDeferred();
  const cancellable = createModelOptionsController({ loadModels: () => pending.promise });
  const request = cancellable.load({ provider: "p" });
  cancellable.cancel();
  pending.resolve([{ id: "late", name: "Late" }]);
  assert.equal((await request).stale, true);
  assert.deepEqual(controller.filter([{ id: "alpha-model" }, { id: "beta-model" }], "beta").map(model => model.id), ["beta-model"], "controller search must pass the query and normalized options in their public order");
}
