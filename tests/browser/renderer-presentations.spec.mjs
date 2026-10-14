import { expect, test } from "./fixtures.mjs";

test("a new tool contributes summaries and parameters without modifying the tool host", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { toolPresentationRegistry } = await import("/extension/sidepanel/tools/tool-presentation.js");
    const unregister = toolPresentationRegistry.register({
      id: "fixture.weather",
      argsSummary: ({ args }) => `(${args.city} · weather)`,
      describeRun: ({ args }) => `Forecast for ${args.city}`,
      compactParams: ({ args }) => ({ city: args.city }),
    });
    try {
      return [false, true].map(staticOutput => {
        const root = renderToolEvent({ name: "new_weather_tool_42", rendererId: "fixture.weather",
          args: { city: "杭州", implementationOption: "hidden-parameter" }, result: { temperature: 21 } },
        { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.replaceChildren(root);
        const snapshot = { staticOutput, summary: root.querySelector(".tool-args-preview").textContent,
          description: root.querySelector(".tool-compact-title").textContent,
          params: root.querySelector(".tool-chip-row").textContent,
          fallback: root.querySelectorAll(".tool-renderer-fallback").length };
        disposeRendererTree(root);
        return snapshot;
      });
    } finally { unregister(); }
  });
  for (const snapshot of snapshots) {
    expect(snapshot.summary).toBe("(杭州 · weather)");
    expect(snapshot.description).toBe("Forecast for 杭州");
    expect(snapshot.params).toContain("杭州");
    expect(snapshot.params).not.toContain("hidden-parameter");
    expect(snapshot.fallback).toBe(0);
  }
});

test("throwing or malformed presentation callbacks preserve generic live and static output", async ({ page }) => {
  await page.goto("/__test_health");
  const snapshots = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { toolPresentationRegistry } = await import("/extension/sidepanel/tools/tool-presentation.js");
    const snapshots = [];
    for (const failure of ["throw", "invalid", "promise", "rejected-promise", "thenable"]) {
      const args = { query: "retained query", marker: "retained parameter" };
      const bad = () => {
        if (failure === "throw") throw new Error("broken capability");
        if (failure === "promise") return Promise.resolve({ wrong: "async parameters" });
        if (failure === "rejected-promise") return Promise.reject(new Error("async callback failed"));
        if (failure === "thenable") return { then() {}, wrong: "thenable parameters" };
        return [];
      };
      const unregister = toolPresentationRegistry.register({ id: "fixture.broken", argsSummary: bad, describeRun: bad, compactParams: bad });
      try {
        for (const staticOutput of [false, true]) {
          const root = renderToolEvent({ name: "another_new_tool", rendererId: "fixture.broken", args, result: "retained result" },
            { expanded: true, lazyDetails: false, static: staticOutput });
          document.body.replaceChildren(root);
          snapshots.push({ failure, staticOutput, summary: root.querySelector(".tool-args-preview").textContent,
            params: root.querySelector(".tool-chip-row").textContent, text: root.querySelector(".tool-details").textContent,
            fallbacks: root.querySelectorAll(".tool-renderer-fallback").length });
          disposeRendererTree(root);
        }
      } finally { unregister(); }
    }
    return snapshots;
  });
  for (const snapshot of snapshots) {
    expect(snapshot.summary).toContain("retained query");
    expect(snapshot.params).toContain("retained parameter");
    expect(snapshot.text).toContain("retained result");
    expect(snapshot.fallbacks).toBe(0);
  }
});

test("built-in media parameters and streaming file previews survive capability registration", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const image = renderToolEvent({ name: "read_image", args: { url: "https://example.test/image.png", maxBytes: 1234 }, isError: true,
      result: { ok: false, error: "failed" } }, { expanded: true, lazyDetails: false });
    document.body.replaceChildren(image);
    const imageParams = image.querySelector(".tool-chip-row").textContent;
    disposeRendererTree(image);
    const file = renderToolEvent({ name: "save_file", args: { filename: "draft.md", content: "# Streaming content" },
      isRunning: true, argsIncomplete: true, phase: "preparing" }, { expanded: true, lazyDetails: false });
    document.body.replaceChildren(file);
    const fileContent = file.querySelector(".tool-file-content-block")?.textContent;
    const fileParams = file.querySelector(".tool-chip-row").textContent;
    disposeRendererTree(file);
    return { imageParams, fileContent, fileParams };
  });
  expect(result.imageParams).toContain("image.png");
  expect(result.imageParams).not.toContain("1234");
  expect(result.fileContent).toBe("# Streaming content");
  expect(result.fileParams).toContain("draft.md");
  expect(result.fileParams).not.toContain("Streaming content");
});

test("timeline visibility does not leak to other tools sharing a wait renderer", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { groupConsecutiveToolTranscriptEntries } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const names = entries => groupConsecutiveToolTranscriptEntries(entries).flatMap(entry =>
      entry.type === "tool-group" ? entry.entries.map(tool => tool.name) : entry.type === "tool" ? [entry.name] : []);
    const tool = (name, extra = {}) => ({ type: "tool", name, _uiKey: name, args: {}, result: {}, ...extra });
    return {
      mixed: names([tool("open_tab"), tool("wait"), tool("wait_for_navigation"), tool("wait_until"),
        tool("custom_wait_tool", { rendererId: "wait", profileFamily: "wait" }), tool("image_assets"), tool("read_image")]),
      standalone: names([tool("wait")]),
      hidden: names([tool("image_assets")]),
    };
  });
  expect(result).toEqual({
    mixed: ["open_tab", "wait_for_navigation", "wait_until", "custom_wait_tool", "read_image"],
    standalone: ["wait"], hidden: [],
  });
});
