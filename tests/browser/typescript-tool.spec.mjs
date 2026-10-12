import { expect, test } from "./fixtures.mjs";

test("a compiled TypeScript tool loads at its .js URL and preserves Session identity", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { registerGoalTools } = await import("/extension/capabilities/sessions/goal-tools.js");
    let tool;
    registerGoalTools({
      registerTool: definition => { tool = definition; },
      getToolRuntimeDependencies: () => ({ sessions: { updateGoal: async input => input } }),
      ToolExecutionError: Error,
      isMissingRequiredValue: value => value == null || String(value).trim() === "",
      throwMissingToolArgs: (_name, missing) => { throw new Error(missing.join(",")); },
    });
    const input = { action: "create", objective: "Build a typed tool", criteria: "Browser execution succeeds", sessionId: "untrusted" };
    tool.validateArgs(input);
    return tool.execute(input, new AbortController().signal, { sessionId: "owned-session", runId: "active-run" });
  });
  expect(result).toMatchObject({ action: "create", sessionId: "owned-session", runId: "active-run" });
});

test("grouped core modules and public SDK imports resolve in the compiled browser graph", async ({ page, request }) => {
  const manifest = await (await request.get("/extension/manifest.json")).json();
  expect(manifest.background).toEqual({ service_worker: "background/service-worker.js", type: "module" });
  expect(manifest.side_panel.default_path).toBe("sidepanel/sidepanel.html");
  for (const path of ["background/service-worker.js", "sidepanel/sidepanel.js", "background/tools/runtime.js", "background/llm/index.js", "background/mcp/mcp-runtime.js"]) {
    expect((await request.get(`/extension/${path}`)).ok(), path).toBe(true);
  }

  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const [{ projectDocumentRead }, { normalizeSessionListSummary }, { SessionState }, { getToolUiMeta }] = await Promise.all([
      import("/extension/sdk/shared/documents.js"),
      import("/extension/sdk/shared/sessions.js"),
      import("/extension/sidepanel/features/sessions/session-state.js"),
      import("/extension/sidepanel/tools/tool-model.js"),
    ]);
    const sessions = new SessionState();
    sessions.ensure("layout-session");
    return {
      document: projectDocumentRead({ id: "layout-document", blocks: [{ type: "paragraph", text: "Compiled document" }] }),
      summary: normalizeSessionListSummary({}),
      sessionId: sessions.get("layout-session").sessionId,
      tool: getToolUiMeta("open_tab"),
    };
  });
  expect(result.document).toMatchObject({ docModelId: "layout-document", content: "Compiled document" });
  expect(result.summary).not.toBeNull();
  expect(result.sessionId).toBe("layout-session");
  expect(result.tool.title).toBeTruthy();
  for (const retired of ["background/tools.js", "background/llm.js", "background/mcp-runtime.js", "sidepanel/tool-model.js", "shared/document-read-projection.js", "shared/session-codec.js"]) {
    expect((await request.get(`/extension/${retired}`)).status(), retired).toBe(404);
  }
});
