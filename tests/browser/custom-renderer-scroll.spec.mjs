import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.evaluate(async () => {
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
    document.body.replaceChildren();
    const renderer = await import("/extension/sidepanel/tools/tool-renderer.js");
    const counts = { mounts: 0, updates: 0, static: 0, disposed: 0 };
    const id = "third-party.measurements";
    const build = (view, document) => {
      const output = document.createElement("section");
      for (const key of view.args.order) {
        const region = document.createElement("div");
        region.dataset.toolScrollSurface = key;
        region.dataset.toolStreamSurface = String(view.args.priorities?.[key] || 0);
        region.style.cssText = "width:220px;height:100px;overflow:auto;margin:4px;";
        const content = document.createElement("div");
        content.style.cssText = "width:600px;white-space:pre;";
        for (let index = 0; index < view.args.count; index += 1) {
          const line = document.createElement("div");
          line.style.height = "18px";
          line.textContent = `${key} measurement ${index + 1}`;
          content.append(line);
        }
        region.append(content); output.append(region);
      }
      return output;
    };
    const unregister = renderer.toolRendererRegistry.register({
      id,
      mount(container, view, { document }) {
        counts.mounts += 1;
        container.replaceChildren(build(view, document));
        return {
          // Real extension updates may replace and reorder their inner DOM.
          update(next) { counts.updates += 1; container.replaceChildren(build(next, document)); },
          dispose() { counts.disposed += 1; },
        };
      },
      renderStatic(view, { document }) { counts.static += 1; return build(view, document); },
    });
    const options = { lazyDetails: false, presentationState: { userToggled: true, expanded: true } };
    let tool, root;
    const surfaces = () => [...root.querySelectorAll("[data-tool-scroll-surface]")];
    window.__customScroll = {
      counts,
      create({ streaming = false, order = ["first", "second"], priorities = {} } = {}) {
        tool = { name: "external_measurements", rendererId: id, toolCallId: "external-scroll", args: { order, priorities, count: 40 },
          ...(streaming ? { isRunning: true, argsIncomplete: true, phase: "preparing" } : { result: { ok: true } }) };
        root = renderer.renderToolEvent(tool, options); document.body.append(root);
      },
      patch(input) {
        tool = { ...tool, args: { ...tool.args, ...input } };
        renderer.patchToolEvent(root, tool, options);
      },
      position(key, top, left = 0) {
        const element = surfaces().find(item => item.dataset.toolScrollSurface === key);
        element.scrollTop = top === "tail" ? element.scrollHeight : top;
        element.scrollLeft = left;
        element.dispatchEvent(new Event("scroll"));
      },
      snapshot() {
        return surfaces().map(element => ({ key: element.dataset.toolScrollSurface, top: element.scrollTop,
          left: element.scrollLeft, following: element.dataset.followTail,
          gap: element.scrollHeight - element.scrollTop - element.clientHeight }));
      },
      staticHTML() { return renderer.renderToolEvent(tool, { static: true, lazyDetails: false }).outerHTML; },
      dispose() { renderer.disposeRendererTree(root); unregister(); },
    };
  });
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__customScroll?.dispose());
});

test("stable scroll keys preserve both axes when an unknown renderer replaces and reorders its DOM", async ({ page }) => {
  await page.evaluate(() => window.__customScroll.create());
  const before = await page.evaluate(() => {
    window.__customScroll.position("first", 130, 45);
    window.__customScroll.position("second", 240, 85);
    return window.__customScroll.snapshot();
  });
  await page.evaluate(() => window.__customScroll.patch({ order: ["second", "first"], count: 60 }));
  const after = await page.evaluate(() => window.__customScroll.snapshot());
  expect(after.map(item => item.key)).toEqual(["second", "first"]);
  for (const expected of before) {
    expect(after.find(item => item.key === expected.key)).toMatchObject({ top: expected.top, left: expected.left, following: "false" });
  }
  expect(await page.evaluate(() => window.__customScroll.counts)).toMatchObject({ mounts: 1, updates: 1 });
  expect(await page.locator(".js-code-block, .tool-file-content-block, .tool-skill-content-preview, .tool-data-table-wrap").count()).toBe(0);
});

test("stream following uses declared priority and respects the reader's pause and resume", async ({ page }) => {
  await page.evaluate(() => window.__customScroll.create({ streaming: true,
    order: ["low", "first", "last"], priorities: { first: 5, last: 5 } }));
  await expect.poll(() => page.evaluate(() => window.__customScroll.snapshot().at(-1).gap)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.__customScroll.snapshot().slice(0, 2).map(item => item.top))).toEqual([0, 0]);
  const pinned = await page.evaluate(() => {
    window.__customScroll.position("last", 180, 30);
    return window.__customScroll.snapshot().at(-1).top;
  });
  await page.evaluate(() => window.__customScroll.patch({ count: 70 }));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__customScroll.snapshot().at(-1))).toMatchObject({ top: pinned, left: 30, following: "false" });
  await page.evaluate(() => {
    window.__customScroll.position("last", "tail");
    window.__customScroll.patch({ count: 90 });
  });
  await expect.poll(() => page.evaluate(() => window.__customScroll.snapshot().at(-1))).toMatchObject({ gap: 0, following: "true" });
});

test("the same third-party renderer exports every row without mounting a live instance", async ({ page }) => {
  await page.evaluate(() => { window.__customScroll.create(); window.__customScroll.patch({ count: 80 }); });
  const exported = await page.evaluate(() => {
    const before = { ...window.__customScroll.counts };
    const html = window.__customScroll.staticHTML();
    return { html, before, after: { ...window.__customScroll.counts } };
  });
  expect(exported.after.mounts).toBe(exported.before.mounts);
  expect(exported.after.updates).toBe(exported.before.updates);
  expect(exported.after.static).toBe(exported.before.static + 1);
  const offline = await page.context().newPage();
  await offline.setContent(exported.html);
  await expect(offline.locator('[data-tool-scroll-surface="first"]')).toContainText("first measurement 80");
  await expect(offline.locator('[data-tool-scroll-surface="second"]')).toContainText("second measurement 80");
  await expect(offline.locator('[data-tool-stream-surface="0"]')).toHaveCount(2);
  await offline.close();
});

test("declared third-party surfaces own wheel scrolling and hand off at their boundary", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.__customScroll.create();
    const { resolveWheelScrollOwner, pauseDescendantTailTargets } = await import("/extension/sidepanel/ui/scroll-tail-controller.js");
    const boundary = document.createElement("div");
    boundary.style.cssText = "height:240px;overflow:auto";
    boundary.append(...document.body.childNodes);
    const filler = document.createElement("div"); filler.style.height = "1000px"; boundary.append(filler);
    document.body.append(boundary);
    const [first, second] = boundary.querySelectorAll("[data-tool-scroll-surface]");
    const target = first.firstElementChild.firstElementChild;
    first.scrollTop = 150;
    const inner = resolveWheelScrollOwner(target, 100, { boundary });
    first.scrollTop = first.scrollHeight;
    const outer = resolveWheelScrollOwner(target, 100, { boundary });
    first.dataset.followTail = second.dataset.followTail = "true";
    const paused = pauseDescendantTailTargets(boundary, { except: second });
    return {
      inner: inner.owner === first && inner.ownerIsInner && inner.innerCandidate === first,
      handoff: outer.owner === boundary && !outer.ownerIsInner && outer.innerCandidate === first,
      paused, firstFollow: first.dataset.followTail, secondFollow: second.dataset.followTail,
    };
  });
  expect(result).toEqual({ inner: true, handoff: true, paused: 1, firstFollow: "false", secondFollow: "true" });
});
