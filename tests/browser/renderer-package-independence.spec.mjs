import { expect, test } from "./fixtures.mjs";
import { ensureCapabilityExtension, resolveTestAsset } from "../support/extension-build.mjs";

const variants = [
  { omit: "skills", renderer: { type: "skill", action: "update" }, result: { name: "retained Skill output", changes: [{ path: "SKILL.md", patchPreview: "- old\n+ new" }] }, text: "retained Skill output" },
  { omit: "mcp", runtime: "mcp", result: { text: "retained MCP output" }, text: "retained MCP output" },
  { omit: "script", result: { message: "retained script output" }, text: "retained script output" },
  { omit: "accessibility", renderer: { type: "tree" }, result: { title: "retained tree output", nodes: [{ depth: 0, name: "Root" }, { depth: 1, name: "Child" }] }, text: "retained tree output" },
  { omit: "ui", renderer: { type: "summary" }, result: { message: "retained Plugin output" }, text: "retained Plugin output" },
];

for (const variant of variants) {
  test(`removing ${variant.omit} preserves buildability and readable live/static plugin results`, async ({ page }) => {
    const extensionDir = await ensureCapabilityExtension({ omit: [variant.omit] });
    await page.route("**/extension/**", route => {
      const path = resolveTestAsset(decodeURIComponent(new URL(route.request().url()).pathname), { root: process.cwd(), extensionDir });
      return path ? route.fulfill({ path }) : route.abort();
    });
    await page.goto("/__test_health");
    const result = await page.evaluate(async variant => {
      const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const { setSkillToolUiCatalog } = await import("/extension/sidepanel/tools/skill-tool-ui-registry.js");
      setSkillToolUiCatalog({ plugins: [{ id: "independent", tools: [{ name: "independent__result", title: "Independent result", runtime: variant.runtime || "page", renderer: variant.renderer }] }] });
      return [false, true].map(staticOutput => {
        const element = renderToolEvent({ name: "independent__result", args: {}, result: variant.result }, { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.replaceChildren(element);
        const text = element.querySelector(".tool-details").textContent;
        const tree = element.querySelectorAll(".tool-tree-line").length;
        disposeRendererTree(element);
        return { text, tree };
      });
    }, variant);
    expect(result[0].text).toContain(variant.text);
    expect(result[1].text).toBe(result[0].text);
    if (variant.omit === "accessibility") expect(result[0].tree).toBe(2);
    if (variant.omit === "ui") {
      const mcp = await page.evaluate(async () => {
        const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
        const root = renderToolEvent({ name: "mcp_call_tool", args: {}, result: { structuredContent: [{ name: "MCP without UI package" }] } }, { expanded: true, lazyDetails: false });
        document.body.replaceChildren(root);
        const result = { text: root.textContent, tables: root.querySelectorAll(".tool-data-table").length };
        disposeRendererTree(root);
        return result;
      });
      expect(mcp.text).toContain("MCP without UI package");
      expect(mcp.tables).toBe(1);
    }
  });
}

test("nested registered renderers retain lifecycle, static parity and bounded recursive fallback", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { RendererRegistry, projectedRenderer, createToolView, planRenderer, commitRendererTree, disposeRendererTree } = await import("/extension/sidepanel/tools/renderer-host.js");
    const calls = { mounts: 0, updates: 0, disposes: 0, aborted: false };
    const registry = new RendererRegistry(projectedRenderer("generic", (parent, view) => { parent.textContent = JSON.stringify(view.result); }));
    registry.register({ id: "child", mount(parent, view, { signal }) {
      calls.mounts += 1;
      const update = view => { parent.textContent = `Child: ${view.result}`; calls.updates += 1; };
      update(view);
      return { update, dispose() { calls.disposes += 1; calls.aborted = signal.aborted; } };
    }, renderStatic(view, { document }) { const node = document.createElement("span"); node.textContent = `Child: ${view.result}`; return node; } });
    registry.register(projectedRenderer("parent", (parent, view) => registry.render(parent, { ...view, rendererId: "child" })));
    const root = document.createElement("div"); document.body.replaceChildren(root);
    for (const result of ["first", "second"]) {
      planRenderer(root, registry, createToolView({ id: "stable", rendererId: "parent", result }));
      commitRendererTree(root);
    }
    const live = root.textContent;
    const exported = registry.renderStatic(createToolView({ id: "stable", rendererId: "parent", result: "second" }), document).textContent;
    disposeRendererTree(root);
    const lifecycle = { ...calls, live, exported };
    registry.register(projectedRenderer("recursive", (parent, view) => registry.render(parent, { ...view, rendererId: "recursive" })));
    const recursion = [false, true].map(staticOutput => {
      planRenderer(root, registry, createToolView({ id: "loop", rendererId: "recursive", result: { retained: "cycle result" } }), staticOutput);
      commitRendererTree(root);
      const result = { text: root.textContent, fallbacks: root.querySelectorAll(".tool-renderer-fallback").length };
      disposeRendererTree(root); root.replaceChildren();
      return result;
    });
    return { lifecycle, recursion };
  });
  expect(result.lifecycle).toEqual({ mounts: 1, updates: 2, disposes: 1, aborted: true, live: "Child: second", exported: "Child: second" });
  for (const state of result.recursion) {
    expect(state.text).toContain("cycle result");
    expect(state.fallbacks).toBe(1);
  }
  expect(result.recursion[1].text).toBe(result.recursion[0].text);
});

test("renderer declarations own container decoration and raw-data visibility without tool-name rules", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { renderToolEvent, toolRendererRegistry, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { projectedRenderer } = await import("/extension/sidepanel/tools/renderer-host.js");
    const unregister = toolRendererRegistry.register({
      ...projectedRenderer("independent.quiet", (parent, view) => { parent.textContent = String(view.result); }),
      showRawData: false, detailsClass: () => "independent-detail-skin",
    });
    const result = [false, true].flatMap(staticOutput => ["independent.quiet", "missing-renderer"].map(rendererId => {
      const root = renderToolEvent({ name: "unrelated_operation", rendererId, args: {}, result: "retained result" }, { expanded: true, lazyDetails: false, static: staticOutput });
      const state = { rendererId, raw: root.querySelectorAll(".tool-event-raw-btn:not(.hidden)").length,
        decorated: root.querySelector(".tool-details").classList.contains("independent-detail-skin"), text: root.textContent };
      disposeRendererTree(root);
      return state;
    }));
    unregister();
    return result;
  });
  for (const state of result) {
    expect(state.text).toContain("retained result");
    expect(state.raw).toBe(state.rendererId === "independent.quiet" ? 0 : 1);
    expect(state.decorated).toBe(state.rendererId === "independent.quiet");
  }
});
