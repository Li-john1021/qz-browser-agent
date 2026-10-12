import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(() => document.body.replaceChildren());
});

test("registered instances update in place, isolate failures, and abort on disposal", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { RendererRegistry, createToolView, planRenderer, commitRendererTree, disposeRendererTree, readableFallback } = await import("/extension/sidepanel/tools/renderer-host.js");
    const counts = { mount: 0, update: 0, dispose: 0, clicks: 0, aborted: false };
    const fallback = { id: "fallback", renderStatic: (view, { document }) => readableFallback(view, document), mount() { throw new Error("fallback mount"); } };
    const registry = new RendererRegistry(fallback);
    const definition = {
      id: "interactive",
      renderStatic: fallback.renderStatic,
      mount(root, view, { signal }) {
        counts.mount += 1;
        const button = document.createElement("button");
        root.append(button);
        button.addEventListener("click", () => counts.clicks += 1, { signal });
        return {
          update(next) { counts.update += 1; if (next.result === "fail") throw new Error("bad update"); button.textContent = String(next.result); },
          dispose() { counts.dispose += 1; counts.aborted = signal.aborted; },
        };
      },
    };
    const unregister = registry.register(definition);
    let duplicateRejected = false;
    try { registry.register(definition); } catch { duplicateRejected = true; }
    const root = document.createElement("div"); document.body.append(root);
    const set = result => { planRenderer(root, registry, createToolView({ id: "same-tool", rendererId: "interactive", result })); commitRendererTree(root); };
    set("first"); const button = root.querySelector("button"); button.focus(); set("next"); button.click();
    const stable = root.querySelector("button") === button && document.activeElement === button;
    set("fail"); button.click();
    const fallbackReadable = root.textContent.includes("fail");
    disposeRendererTree(root); unregister();
    const unknown = registry.renderStatic(createToolView({ rendererId: "removed", result: { retained: 42 } }), document).textContent;
    return { counts, duplicateRejected, stable, fallbackReadable, unknown };
  });
  expect(result).toEqual({ counts: { mount: 1, update: 2, dispose: 1, clicks: 1, aborted: true }, duplicateRejected: true, stable: true, fallbackReadable: true, unknown: '{\n  "retained": 42\n}' });
});

test("table updates keep the focused copy control and copy current rows", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderToolEvent, patchToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => copied.push(text) } });
    const tool = { name: "example_table", rendererId: "table", toolCallId: "table-call", result: { rows: [{ value: "first" }] } };
    const options = { presentationState: { userToggled: true, expanded: true } };
    const root = renderToolEvent(tool, options); document.body.append(root);
    const button = root.querySelector(".tool-data-table-copy"); button.focus();
    patchToolEvent(root, { ...tool, result: { rows: [{ value: "updated" }] } }, options);
    const stable = root.querySelector(".tool-data-table-copy") === button && document.activeElement === button;
    button.click(); await Promise.resolve();
    disposeRendererTree(root); button.click(); await Promise.resolve();
    return { stable, copied, visible: root.querySelector("tbody").textContent.trim() };
  });
  expect(result.stable).toBe(true);
  expect(result.copied).toEqual(["value\nupdated"]);
  expect(result.visible).toContain("updated");
});

test("single tool upgrades preserve the live renderer while static export never mounts it", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderToolEvent, toolRendererRegistry, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { prepareRendererTree, adoptRendererTree } = await import("/extension/sidepanel/tools/renderer-host.js");
    const { createToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    let mounts = 0, disposals = 0;
    const unregister = toolRendererRegistry.register({
      id: "canvas-example",
      mount(root, view, { signal }) {
        mounts += 1;
        const input = document.createElement("input"); input.value = "user state";
        const canvas = document.createElement("canvas"); root.append(input, canvas);
        return { update() {}, dispose() { if (signal.aborted) disposals += 1; } };
      },
      renderStatic(view, { document }) { const table = document.createElement("table"); table.textContent = `Static value: ${view.result.value}`; return table; },
    });
    const first = { type: "tool", name: "custom", rendererId: "canvas-example", toolCallId: "keep", result: { value: 7 } };
    const state = { userToggled: true, expanded: true, activeToolKey: "keep" };
    const single = renderToolEvent(first, { presentationState: state }); document.body.append(single);
    const input = single.querySelector("input"); input.focus(); input.setSelectionRange(2, 5);
    const entry = { type: "tool-group", entries: [first, { type: "tool", name: "other", toolCallId: "other", result: "okay" }] };
    const timeline = prepareRendererTree(() => createToolTimelineGroupElement(entry, { presentationState: state }));
    document.body.append(timeline); adoptRendererTree(document.body, timeline); disposeRendererTree(single); single.remove();
    const kept = timeline.querySelector("input") === input && document.activeElement === input && input.value === "user state"
      && input.selectionStart === 2 && input.selectionEnd === 5;
    const exported = renderToolEvent(first, { expanded: true, lazyDetails: false, static: true });
    const output = { kept, mounts, staticText: exported.textContent, staticCanvas: exported.querySelectorAll("canvas").length };
    disposeRendererTree(timeline); unregister();
    return { ...output, disposals };
  });
  expect(result.kept).toBe(true);
  expect(result.mounts).toBe(1);
  expect(result.staticText).toContain("Static value: 7");
  expect(result.staticCanvas).toBe(0);
  expect(result.disposals).toBe(1);
});

test("the build-time example retains local state across cancellation and exports the whole result", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { valueCardRenderer } = await import("/extension/examples/value-card.js");
    const { renderToolEvent, patchToolEvent, disposeRendererTree, toolRendererRegistry } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const unregister = toolRendererRegistry.register(valueCardRenderer);
    const options = { presentationState: { userToggled: true, expanded: true } };
    const tool = { name: "example", rendererId: valueCardRenderer.id, toolCallId: "example", result: "first ".repeat(50) };
    const root = renderToolEvent(tool, options); document.body.append(root);
    const button = root.querySelector("[data-tool-renderer] button"); button.click(); button.focus();
    const stopped = { ...tool, result: { aborted: true, reason: "用户终止", partial: "saved ".repeat(50) } };
    patchToolEvent(root, stopped, options);
    const preserved = root.querySelector("[data-tool-renderer] button") === button
      && document.activeElement === button && button.getAttribute("aria-expanded") === "true";
    const staticOutput = renderToolEvent(stopped, { lazyDetails: false, static: true });
    const fullResult = staticOutput.textContent.includes("saved ".repeat(50));
    const noControl = !staticOutput.querySelector("[data-tool-renderer] button");
    disposeRendererTree(root); button.click();
    const disposed = button.getAttribute("aria-expanded") === "true";
    unregister();
    patchToolEvent(root, stopped, options);
    const fallback = root.textContent.includes("用户终止") && !root.querySelector("[data-tool-renderer] button");
    disposeRendererTree(root);
    return { preserved, fullResult, noControl, disposed, fallback };
  });
  expect(result).toEqual({ preserved: true, fullResult: true, noControl: true, disposed: true, fallback: true });
});

test("a failed mount releases signal-scoped effects and cannot block sibling cleanup", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { RendererRegistry, createToolView, planRenderer, commitRendererTree, disposeRendererTree, readableFallback } = await import("/extension/sidepanel/tools/renderer-host.js");
    let aborts = 0, clicks = 0, disposals = 0;
    const registry = new RendererRegistry({
      id: "throw-mount", renderStatic: (view, { document }) => readableFallback(view, document),
      mount(_root, _view, { signal }) {
        document.addEventListener("click", () => clicks += 1, { signal });
        signal.addEventListener("abort", () => aborts += 1, { once: true });
        throw new Error("mount failed after adding effects");
      },
    });
    registry.register({ id: "throw-dispose", renderStatic: () => document.createElement("div"), mount() {
      return { update() {}, dispose() { disposals += 1; throw new Error("one broken component"); } };
    } });
    const root = document.createElement("div"); document.body.append(root);
    for (const id of ["throw-dispose", "throw-mount", "throw-dispose"]) {
      const slot = document.createElement("div"); root.append(slot);
      planRenderer(slot, registry, createToolView({ id, rendererId: id, result: "retained" }));
    }
    commitRendererTree(root); document.body.click(); disposeRendererTree(root); disposeRendererTree(root);
    return { aborts, clicks, disposals, readable: root.textContent.includes("retained") };
  });
  expect(result).toEqual({ aborts: 1, clicks: 0, disposals: 2, readable: true });
});

test("preparing table profiles retain selection, refresh after collapse, and ignore late clipboard completion", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderToolEvent, patchToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    let finishCopy;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => new Promise(resolve => { finishCopy = resolve; }) } });
    const options = { presentationState: { userToggled: true, expanded: true } };
    const tool = { name: "data_store", toolCallId: "streaming-data", isRunning: true, argsIncomplete: true, args: { action: "insert", table: "items", rows: [{ name: "first" }] } };
    const root = renderToolEvent(tool, options); document.body.append(root);
    const cell = root.querySelector("tbody td:last-child");
    const selection = document.getSelection(); selection.setBaseAndExtent(cell.firstChild, 0, cell.firstChild, 5);
    const complete = { ...tool, isRunning: false, argsIncomplete: false, args: { ...tool.args, rows: [{ name: "latest" }] }, result: { inserted: 1 } };
    patchToolEvent(root, complete, options);
    const preserved = selection.toString() === "first" && root.querySelector("tbody td:last-child") === cell;
    selection.removeAllRanges();
    patchToolEvent(root, complete, { presentationState: { userToggled: true, expanded: false } });
    root.querySelector(".tool-summary").click();
    const latest = root.querySelector("tbody").textContent.includes("latest");
    const button = root.querySelector(".tool-data-table-copy"); button.click();
    disposeRendererTree(root); finishCopy(); await Promise.resolve(); await Promise.resolve();
    return { preserved, latest, lateResultIgnored: !button.classList.contains("is-confirmed") };
  });
  expect(result).toEqual({ preserved: true, latest: true, lateResultIgnored: true });
});

test("exported HTML uses static projections for all timeline members and survives an unavailable renderer", async ({ page }) => {
  const html = await page.evaluate(async () => {
    const { toolRendererRegistry } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const { buildStaticSessionChatHtml, buildSessionExportHtml } = await import("/extension/sidepanel/features/export/session-export-feature.js");
    const { createSessionExchangePayload } = await import("/extension/shared/session/session-exchange.js");
    const unregister = toolRendererRegistry.register({ id: "broken-static", mount() { throw new Error("must not mount while exporting"); }, renderStatic() { throw new Error("unavailable chart"); } });
    const transcript = [
      { type: "tool", name: "example", rendererId: "table", toolCallId: "a", result: { rows: [{ amount: 12 }] } },
      { type: "tool", name: "chart", rendererId: "broken-static", toolCallId: "b", result: { readable: "chart underlying data" } },
      { type: "tool", name: "removed", rendererId: "uninstalled", toolCallId: "c", result: { readable: "unknown renderer data" } },
    ];
    const session = { id: "offline", title: "Offline renderers" };
    const chatHtml = buildStaticSessionChatHtml(session, transcript, { normalizeSessionId: String, projectTranscript: value => value, renderTranscriptElement: () => null });
    unregister();
    return buildSessionExportHtml(session, createSessionExchangePayload({ session, transcript }), { chatHtml });
  });
  await page.setContent(html);
  expect(await page.locator("body").textContent()).toContain("unknown renderer data");
  expect(html).toContain("chart underlying data");
  expect(html).toContain("amount");
  expect(html).toContain("12");
  await expect(page.locator("canvas, .tool-data-table-copy")).toHaveCount(0);
});

test("image grids own asset URLs, discard late loads, and export without async work", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createImageGridRenderer } = await import("/extension/sidepanel/tools/primitives/image-grid-renderer.js");
    const { RendererRegistry, createToolView, planRenderer, commitRendererTree, disposeRendererTree } = await import("/extension/sidepanel/tools/renderer-host.js");
    const loads = [], revoked = [], waits = new Map();
    const grid = createImageGridRenderer({
      loadAsset: id => { loads.push(id); return new Promise((resolve, reject) => waits.set(id, { resolve, reject })); },
      revokeUrl: url => { revoked.push(url); URL.revokeObjectURL(url); },
    });
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const asset = () => ({ objectUrl: URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: "image/svg+xml" })) });
    const view = items => createToolView({ id: "grid", rendererId: "image-grid", result: { items } });
    const discarded = document.createElement("div");
    grid.appendImageGrid(discarded, "discarded", [{ assetId: "unused" }]);
    await settle();
    const projectionLoads = loads.length;
    const registry = new RendererRegistry(grid.definition);
    const root = document.createElement("div"); document.body.append(root);
    const set = items => { planRenderer(root, registry, view(items)); commitRendererTree(root); };
    set([{ assetId: "one", title: "first" }, { assetId: "one", title: "duplicate" }]);
    set([{ assetId: "one", title: "updated" }, { assetId: "one", title: "duplicate" }]);
    await settle();
    const first = asset(); waits.get("one").resolve(first); await settle();
    const image = root.querySelector("img");
    set([{ assetId: "one", title: "updated" }, { assetId: "one", title: "duplicate" }]);
    const stable = root.querySelector("img") === image && root.querySelectorAll("img").length === 2;
    const gallery = JSON.parse(root.querySelector("[data-gallery-item]").dataset.galleryItem).title;
    set([{ assetId: "late" }]); await settle();
    set([{ assetId: "failed" }]); await settle();
    const late = asset(); waits.get("late").resolve(late);
    waits.get("failed").reject(new Error("asset missing")); await settle();
    const failed = root.textContent.includes("缺失") && !root.querySelector("img");
    set([{ assetId: "dispose-late" }]); await settle();
    disposeRendererTree(root);
    const disposed = asset(); waits.get("dispose-late").resolve(disposed); await settle();
    const snapshot = registry.renderStatic(view([{ assetId: "offline-asset", title: "本地截图" }, { src: "https://example.test/photo.png", title: "远程图片" }]), document);
    const staticText = snapshot.textContent;
    const invalid = registry.renderStatic(view([{ src: 'javascript:alert("x")', title: '<script>bad</script>' }]), document);
    return { projectionLoads, loads, stable, gallery, failed, urlsReleased: [first, late, disposed].every(value => revoked.filter(url => url === value.objectUrl).length === 1), afterDisposeImages: root.querySelectorAll("img").length, staticText, staticImages: snapshot.querySelectorAll("img").length, unsafeElements: invalid.querySelectorAll("script, img").length };
  });
  expect(result.projectionLoads).toBe(0);
  expect(result.loads).toEqual(["one", "late", "failed", "dispose-late"]);
  expect(result.stable).toBe(true);
  expect(result.gallery).toBe("updated");
  expect(result.failed).toBe(true);
  expect(result.urlsReleased).toBe(true);
  expect(result.afterDisposeImages).toBe(0);
  expect(result.staticText).toContain("本地截图");
  expect(result.staticText).toContain("offline-asset");
  expect(result.staticText).toContain("https://example.test/photo.png");
  expect(result.staticText).not.toContain("加载中");
  expect(result.staticImages).toBe(0);
  expect(result.unsafeElements).toBe(0);
});

test("an unknown renderer uses readable data instead of dispatching by its tool name", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderToolEvent } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const tool = { name: "list_tabs", rendererId: "unavailable", toolCallId: "missing", result: [{ title: "Retained", url: "https://example.test/" }] };
    const live = renderToolEvent(tool, { expanded: true, lazyDetails: false });
    const offline = renderToolEvent(tool, { expanded: true, lazyDetails: false, static: true });
    return [live, offline].map(node => ({ text: node.textContent, records: node.querySelectorAll(".tool-record-list").length, tabs: node.querySelectorAll(".tool-tab-list").length }));
  });
  for (const value of result) {
    expect(value.text).toContain("Retained");
    expect(value.records).toBe(1);
    expect(value.tabs).toBe(0);
  }
});

test("gallery selection rejects late images and closing releases its asset scope", async ({ page }) => {
  await page.route("**/extension/shared/asset-store.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `export * from './asset-store.js?actual';
      export function getImageAssetObjectUrl(id) { window.assetLoads.push(id); return new Promise(resolve => window.assetWaits.set(id, resolve)); }`,
  }));
  const result = await page.evaluate(async () => {
    window.assetLoads = []; window.assetWaits = new Map();
    const revoked = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    const asset = () => ({ objectUrl: URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: "image/svg+xml" })) });
    const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    const { openImageGallery } = await import("/extension/sidepanel/ui/image-lightbox.js");
    openImageGallery([{ assetId: "first", title: "First" }, { assetId: "second", title: "Second" }]);
    await settle();
    document.querySelector(".data-image-gallery-nav.next").click();
    const second = asset(); window.assetWaits.get("second")(second); await settle();
    const first = asset(); window.assetWaits.get("first")(first); await settle();
    const selected = document.querySelector(".data-image-gallery-stage img").alt;
    const count = document.querySelector(".data-image-gallery-meta-count").textContent;
    document.querySelector(".data-image-gallery-close").click();
    openImageGallery([{ assetId: "late" }]); await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    const late = asset(); window.assetWaits.get("late")(late); await settle();
    return { selected, count, loads: window.assetLoads, released: [first, second, late].every(value => revoked.filter(url => url === value.objectUrl).length === 1), overlays: document.querySelectorAll(".data-image-gallery-overlay").length };
  });
  expect(result).toEqual({ selected: "Second", count: "2/2", loads: ["first", "second", "late"], released: true, overlays: 0 });
});


test("absolute wait results use the registered profile in live and static output", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    return [
      { waitedSeconds: 300, lateBySeconds: 0.01, pastDue: false },
      { waitedSeconds: 0, lateBySeconds: 90, pastDue: true },
    ].map((wait, index) => {
      const tool = {
        name: "wait_until", toolCallId: `absolute-wait-${index}`,
        args: { until: "2026-07-17T12:00:00+08:00" },
        result: { targetAt: "2026-07-17 12:00:00", ...wait },
      };
      return [false, true].map(staticOutput => {
        const root = renderToolEvent(tool, { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.append(root);
        const profile = root.querySelector('[data-tool-renderer="wait"]');
        const output = {
          title: profile?.querySelector(".tool-compact-title")?.textContent,
          subtitle: profile?.querySelector(".tool-compact-subtitle")?.textContent,
          meta: [...profile?.querySelectorAll(".tool-compact-meta span") || []].map(item => item.textContent),
        };
        disposeRendererTree(root); root.remove();
        return output;
      });
    });
  });
  const arrived = { title: "已到达目标时间", subtitle: "2026-07-17 12:00:00", meta: ["等待 5min"] };
  const overdue = { title: "目标时间已过，立即继续", subtitle: "2026-07-17 12:00:00", meta: ["已过 1.5min"] };
  expect(result).toEqual([[arrived, arrived], [overdue, overdue]]);
});

for (const colorScheme of ["light", "dark"]) {
  test(`exported image grids keep inline previews compact in ${colorScheme} skin`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 430, height: 900 });
    const exported = await page.evaluate(async () => {
      const { buildStaticSessionChatHtml, buildSessionExportHtml } = await import("/extension/sidepanel/features/export/session-export-feature.js");
      const { createSessionExchangePayload } = await import("/extension/shared/session/session-exchange.js");
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 128;
      const context = canvas.getContext("2d");
      const pixels = context.createImageData(128, 128);
      let seed = 12345;
      for (let index = 0; index < pixels.data.length; index += 4) {
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        pixels.data.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], index);
      }
      context.putImageData(pixels, 0, 0);
      const image = canvas.toDataURL("image/png");
      const tool = {
        type: "tool", name: "collect_images", toolCallId: "inline-export", args: {},
        result: { collected: 3, images: [
          { src: image, alt: "内嵌图片" },
          { src: "https://example.test/photo.png", alt: "远程图片" },
          { assetId: "offline-asset", alt: "本地截图" },
        ] },
      };
      const session = { id: "image-export", title: "Image grid export" };
      const chatHtml = buildStaticSessionChatHtml(session, [tool], {
        normalizeSessionId: String, projectTranscript: value => value,
        renderTranscriptElement: () => { throw new Error("Expected the registered tool export path"); },
      });
      const stylesheet = await (await fetch("/extension/sidepanel/sidepanel.css")).text();
      const html = buildSessionExportHtml(session, createSessionExchangePayload({ session, transcript: [tool] }), { chatHtml, stylesheet });
      return { html, imageLength: image.length };
    });
    expect(exported.imageLength).toBeGreaterThan(16000);
    await page.setContent(exported.html);
    await page.locator(".msg-tool > .tool-summary").click();
    await expect(page.locator(".tool-image-grid-section")).toBeVisible();
    await page.locator(".tool-image-grid-thumb img").evaluate(image => image.decode());
    const geometry = await page.locator(".tool-image-grid-card").evaluateAll(cards => cards.map(card => {
      const image = card.querySelector("img");
      const thumb = card.querySelector(".tool-image-grid-thumb");
      const source = card.querySelector(".tool-image-grid-source")?.textContent || "";
      return {
        height: card.getBoundingClientRect().height,
        thumbnailHeight: thumb.getBoundingClientRect().height,
        imageWidth: image?.naturalWidth || 0,
        imageHeight: image?.naturalHeight || 0,
        sourceLength: source.length,
        hasEncodedSource: source.startsWith("data:image/"),
      };
    }));
    await testInfo.attach("exported-image-geometry.json", {
      body: Buffer.from(JSON.stringify({ imageLength: exported.imageLength, geometry }, null, 2)),
      contentType: "application/json",
    });
    expect(geometry).toHaveLength(3);
    expect(geometry[0].imageWidth).toBe(128);
    expect(geometry[0].imageHeight).toBe(128);
    expect(geometry[0].height).toBeLessThanOrEqual(geometry[0].thumbnailHeight + 80);
    expect(geometry[0].hasEncodedSource).toBe(false);
    await expect(page.locator(".tool-image-grid-source")).toHaveText(["https://example.test/photo.png", "offline-asset"]);
  });

  test(`data_store summary keeps its table spacing in live and exported ${colorScheme} skin`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
    const exported = await page.evaluate(async () => {
      const { renderToolEvent, disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const { buildStaticSessionChatHtml, buildSessionExportHtml } = await import("/extension/sidepanel/features/export/session-export-feature.js");
      const { createSessionExchangePayload } = await import("/extension/shared/session/session-exchange.js");
      const tool = {
        type: "tool", name: "data_store", toolCallId: "list-spacing", phase: "completed", hasResult: true,
        args: { action: "list", table: "spacing" },
        result: { table: "spacing", totalRows: 1, rows: [{ id: 1, data: { name: "Alpha", value: 10 } }] },
      };
      const root = renderToolEvent(tool, { expanded: true, lazyDetails: false });
      const messages = document.createElement("main"); messages.id = "messages";
      messages.append(root); document.body.append(messages);
      const summary = root.querySelector(".tool-data-summary");
      const table = root.querySelector(".tool-data-table-section");
      const live = {
        margin: getComputedStyle(table).marginTop,
        gap: table.getBoundingClientRect().top - summary.getBoundingClientRect().bottom,
        text: table.textContent,
      };
      const session = { id: "spacing-export", title: "Data table spacing" };
      const chatHtml = buildStaticSessionChatHtml(session, [tool], {
        normalizeSessionId: value => String(value || ""), projectTranscript: value => value,
        renderTranscriptElement: () => { throw new Error("Expected the registered tool export path"); },
      });
      const stylesheet = await (await fetch("/extension/sidepanel/sidepanel.css")).text();
      const html = buildSessionExportHtml(session, createSessionExchangePayload({ session, transcript: [tool] }), { chatHtml, stylesheet });
      disposeRendererTree(root);
      return { live, html };
    });
    expect(exported.live.text).toContain("Alpha");
    expect(exported.live.margin).toBe("8px");
    expect(exported.live.gap).toBeCloseTo(8, 2);
    await page.setContent(exported.html);
    await page.locator(".msg-tool > .tool-summary").click();
    await expect(page.locator(".tool-data-table-section")).toBeVisible();
    await expect(page.locator(".tool-data-table-section")).toContainText("Alpha");
    const offline = await page.evaluate(() => {
      const summary = document.querySelector(".tool-data-summary");
      const table = document.querySelector(".tool-data-table-section");
      return { margin: getComputedStyle(table).marginTop, gap: table.getBoundingClientRect().top - summary.getBoundingClientRect().bottom };
    });
    expect(offline.margin).toBe("8px");
    expect(offline.gap).toBeCloseTo(8, 2);
  });
}

for (const colorScheme of ["light", "dark"]) {
  test(`tab title prefixes do not indent or truncate visible titles · ${colorScheme}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 430, height: 900 });
    await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
    const result = await page.evaluate(async () => {
      const { renderToolEvent } = await import("/extension/sidepanel/tools/tool-renderer.js");
      const { formatTab } = await import("/extension/shared/tab-utils.js");
      const prefix = "\u200b\u202c\ufeff\u200c\u200d\u2061\u2062\u2063 ".repeat(30);
      const titles = ["普通标题", "「轻舟」使用技巧分享", "「Demo Playground」玩法攻略", "می\u200cروم", "👩\u200d💻 开发笔记", "\u200fالعربية"];
      const tool = { name: "list_tabs", result: { tabs: titles.map((title, index) => ({
        id: index + 1, title: index === 1 || index === 2 ? prefix + title : title, url: `https://example.test/${index}`,
      })) } };
      const original = JSON.stringify(tool);
      const snapshots = [false, true].flatMap(fromBrowser => [false, true].map(staticOutput => {
        const input = fromBrowser ? { ...tool, result: { tabs: tool.result.tabs.map(tab => formatTab(tab)) } } : tool;
        const root = renderToolEvent(input, { expanded: true, lazyDetails: false, static: staticOutput });
        document.body.append(root);
        const elements = [...root.querySelectorAll(".tool-slim-main")];
        return {
          titles: elements.map(element => element.textContent),
          offsets: elements.slice(0, 3).map(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            return range.getBoundingClientRect().left - element.getBoundingClientRect().left;
          }),
        };
      }));
      return { snapshots, titles, unchanged: JSON.stringify(tool) === original };
    });
    expect(result.unchanged).toBe(true);
    for (const snapshot of result.snapshots) {
      expect(snapshot.titles).toEqual(result.titles);
      for (const offset of snapshot.offsets) expect(Math.abs(offset)).toBeLessThan(1);
    }
    await page.screenshot({ path: testInfo.outputPath("tab-title-alignment.png"), fullPage: true });
  });
}
