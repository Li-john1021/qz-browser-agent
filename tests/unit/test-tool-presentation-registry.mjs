import assert from "node:assert/strict";
import test from "node:test";
import { ToolPresentationRegistry } from "../../src/sidepanel/tools/tool-presentation.js";

for (const projection of ["timelineBadge", "timelineGroupTitle"]) {
  test(`${projection} rejects invalid or asynchronous labels and preserves the next contribution`, async () => {
    const registry = new ToolPresentationRegistry();
    const fallback = { label: "Readable evidence", order: 20, key: "evidence" };
    registry.register({ id: "fallback", [projection]: () => fallback });
    const bad = [
      () => { throw new Error("bad capability"); },
      () => Promise.reject(new Error("asynchronous capability")),
      () => ({ then() {}, label: "thenable", order: 1 }),
      () => ({ label: "infinite", order: Infinity }),
      () => ({ label: "not a number", order: "1" }),
      () => ({ label: 1, order: 1 }),
      () => ({ label: "invalid grouping", order: 1, key: [] }),
      () => Object.create({ label: "inherited", order: 1 }),
    ];
    for (const callback of bad) {
      const remove = registry.register({ id: "custom", [projection]: callback });
      assert.deepEqual(registry.project(projection, { name: "custom", rendererId: "fallback" }, {}), fallback);
      remove();
    }
    const remove = registry.register({ id: "custom", [projection]: () => ({ label: "First", order: 1 }) });
    assert.deepEqual(registry.project(projection, { name: "custom", rendererId: "fallback" }, {}), { label: "First", order: 1 });
    remove();
    let reads = 0;
    const mutable = { get label() { reads += 1; if (reads > 1) throw new Error("late getter"); return "Snapshot"; }, order: 2 };
    registry.register({ id: "snapshot", [projection]: () => mutable });
    const snapshot = registry.project(projection, "snapshot", {});
    mutable.order = 99;
    assert.deepEqual(snapshot, { label: "Snapshot", order: 2 });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(reads, 1);
    await new Promise(resolve => setImmediate(resolve));
  });
}

test("timeline policies retain immutable historical identity and support generic metadata selectors", () => {
  const registry = new ToolPresentationRegistry();
  registry.register({ id: "labeler:custom-format", timelineBadge: ({ tool }) => ({ label: tool.familyId, order: 10 }) });
  registry.register({ id: "media:custom-media", timelineGroupTitle: () => ({ label: "Custom media", order: 20 }) });
  const tool = { name: "historical_alias", labelerId: "custom-format", mediaPresentation: "custom-media", familyId: "original" };
  assert.deepEqual(registry.project("timelineBadge", tool, {}), { label: "original", order: 10 });
  assert.deepEqual(registry.project("timelineGroupTitle", tool, {}), { label: "Custom media", order: 20 });
  registry.register({ id: tool.name, timelineBadge: ({ tool: snapshot }) => { snapshot.familyId = "mutation"; return { label: "wrong", order: 0 }; } });
  assert.deepEqual(registry.project("timelineBadge", tool, {}), { label: "original", order: 10 });
  assert.equal(tool.familyId, "original");
});
