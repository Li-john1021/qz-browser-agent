import { expect, test } from "./fixtures.mjs";

function navigationFlow(routes = ["A", "B", "C"]) {
  const entries = [];
  const navigation = [];
  routes.forEach((route, batch) => {
    for (let member = 1; member <= 3; member += 1) {
      const id = `route-${batch}-${member}`;
      const index = entries.length;
      const url = `https://example.com/${route.toLowerCase()}#${id}`;
      entries.push({
        type: "tool", id, name: "navigate",
        args: { url: `https://example.com/${route.toLowerCase()}` },
        result: { title: `Route ${route}`, url },
      });
      navigation.push({ route, index, url, batch, member });
    }
    entries.push({
      type: "tool", id: `read-${batch}`, name: "read_article",
      args: { source: "auto" }, result: { title: `Evidence ${batch}`, text: `Evidence ${batch}` },
    });
  });
  entries.push({
    type: "tool", id: "process-final", name: "run_script",
    args: { code: "return 42" }, result: { ok: true, result: 42 },
  });
  return { entries, navigation };
}

async function openFlow(page, entries, { direction = "ltr", width = 390 } = {}) {
  await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.visualTimelineTest?.renderConversationFlow);
  await page.evaluate(({ entries, direction, width }) => {
    document.documentElement.dir = direction;
    document.querySelector("#visual-device").style.setProperty("--visual-width", `${width}px`);
    window.visualTimelineTest.renderConversationFlow({ title: "Tool navigation order", entries });
  }, { entries, direction, width });
  await page.locator(".msg-tool-timeline > .tool-timeline-summary").click();
  return page.locator(".msg-tool-timeline");
}

function pager(group, direction) {
  return group.locator(`.tool-timeline-nav-btn[data-timeline-nav-direction="${direction}"]`);
}

for (const colorScheme of ["light", "dark"]) {
  for (const mode of ["steps", "family"]) {
    test(`navigation and details have one separator · ${mode} ${colorScheme}`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme });
      const { entries } = navigationFlow();
      const group = await openFlow(page, mode === "family" ? entries : entries.slice(0, 3));
      await expect(group.locator(".tool-timeline-details")).toHaveAttribute("data-timeline-mode", mode);
      await expect(group.locator(".tool-timeline-nav-area")).toHaveCSS("box-shadow", "none");
      await expect(group.locator(".tool-timeline-nav-area")).toHaveCSS("border-bottom-width", "0px");
      await expect(group.locator(".tool-timeline-slot")).toHaveCSS("border-top-width", "1px");
      await group.screenshot({ path: testInfo.outputPath("single-separator.png"), animations: "disabled" });
    });
  }
}

async function expectNavigation(group, call, position, total) {
  await expectFamilyPosition(group, position, total);
  await expect(group.locator(".tool-family-panel.active .tool-family-batch.active")).toHaveCount(1);
  await expect(group.locator(".tool-family-panel.active .tool-family-batch.active")).toBeVisible();
  await expect(group.locator(".tool-family-panel.active .tool-family-batch.active em")).toHaveText(`Route ${call.route}`);
  await expect(group.locator(".tool-timeline-slot")).toContainText(call.url);
}

async function expectFamilyPosition(group, position, total) {
  await expect(group.locator(".tool-timeline-slot-nav > span")).toHaveText(`${position}/${total}`);
  await expect(group.locator(".tool-family-row.active .tool-family-count")).toHaveText(String(total));
  await expect(group.locator(":scope > .tool-timeline-summary .tool-args-preview")).toContainText(`· ${position}/${total}`);
}

for (const scene of [
  { name: "wide light LTR", direction: "ltr", width: 780, colorScheme: "light" },
  { name: "narrow dark LTR", direction: "ltr", width: 360, colorScheme: "dark" },
  { name: "narrow dark RTL", direction: "rtl", width: 360, colorScheme: "dark" },
]) {
  test(`family chips and previous/next follow the same call order · ${scene.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.emulateMedia({ colorScheme: scene.colorScheme });
    const { entries, navigation } = navigationFlow();
    const group = await openFlow(page, entries, scene);
    await group.locator('.tool-family-row[data-tool-family-id="arrival"]').click();
    const chips = group.locator('.tool-family-panel.active .tool-family-batch');
    await expect(chips.locator("em")).toHaveText(["Route A", "Route B", "Route C"]);
    await expect(chips.locator("b")).toHaveText(["×3", "×3", "×3"]);

    // Choosing a batch opens its latest call; paging still visits every member.
    await chips.filter({ hasText: "Route C" }).click();
    await expectNavigation(group, navigation.at(-1), 9, 9);
    for (let index = navigation.length - 2; index >= 0; index -= 1) {
      await pager(group, -1).click();
      await expectNavigation(group, navigation[index], index + 1, navigation.length);
      await expect(chips.nth(Math.floor(index / 3))).toHaveClass(/active/);
    }
    await expect(pager(group, -1)).toBeDisabled();
    for (let index = 1; index < navigation.length; index += 1) {
      await pager(group, 1).click();
      await expectNavigation(group, navigation[index], index + 1, navigation.length);
      await expect(chips.nth(Math.floor(index / 3))).toHaveClass(/active/);
    }

    await pager(group, 1).click();
    await expect(group.locator(".tool-family-row.active")).toHaveAttribute("data-tool-family-id", "collect");
    await expectFamilyPosition(group, 1, 3);
    await expect(group.locator(".tool-timeline-slot")).toContainText("Evidence 0");
    await pager(group, -1).click();
    await expectNavigation(group, navigation.at(-1), 9, 9);
    await group.screenshot({ path: testInfo.outputPath("family-navigation.png"), animations: "disabled" });
  });
}

test("revisiting the same page forms a later batch and stays visible beyond the preview limit", async ({ page }) => {
  const { entries, navigation } = navigationFlow(["A", "B", "A", "C"]);
  const group = await openFlow(page, entries);
  await group.locator('.tool-family-row[data-tool-family-id="arrival"]').click();
  for (let index = navigation.length - 1; index >= 0; index -= 1) {
    if (index !== navigation.length - 1) await pager(group, -1).click();
    await expectNavigation(group, navigation[index], index + 1, navigation.length);
    await expect(group.locator(".tool-family-panel.active .tool-family-batch.active b")).toHaveText("×3");
  }
  for (let index = 1; index < navigation.length; index += 1) {
    await pager(group, 1).click();
    await expectNavigation(group, navigation[index], index + 1, navigation.length);
  }
});

test("ungrouped timeline keeps previous/next in transcript order at both boundaries", async ({ page }) => {
  const { entries } = navigationFlow();
  const selected = [entries[0], entries[3], entries[4], entries.at(-1)];
  const group = await openFlow(page, selected);
  await expect(group.locator(".tool-family-trace")).toHaveCount(0);
  await expect(pager(group, 1)).toBeDisabled();
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (index !== selected.length - 1) await pager(group, -1).click();
    await expect(group.locator(".tool-timeline-slot-nav > span")).toHaveText(`${index + 1}/${selected.length}`);
    await expect(group.locator(".tool-timeline-step").nth(index)).toHaveClass(/active/);
  }
  await expect(pager(group, -1)).toBeDisabled();
  for (let index = 1; index < selected.length; index += 1) {
    await pager(group, 1).click();
    await expect(group.locator(".tool-timeline-slot-nav > span")).toHaveText(`${index + 1}/${selected.length}`);
    await expect(group.locator(".tool-timeline-step").nth(index)).toHaveClass(/active/);
  }
  await expect(pager(group, 1)).toBeDisabled();
});

test("streamed calls keep the family count, pager and summary consistent with the selected call", async ({ page }) => {
  const { entries } = navigationFlow();
  const script = index => ({
    type: "tool", id: `process-${index}`, name: "run_script",
    args: { code: `return ${index}` }, result: { ok: true, result: `Process result ${index}` },
  });
  const group = await openFlow(page, [...entries.slice(0, 6), ...Array.from({ length: 8 }, (_, index) => script(index + 1))]);
  await group.locator('.tool-family-row[data-tool-family-id="process"]').click();
  await expectFamilyPosition(group, 8, 8);
  await expect(group.locator(".tool-timeline-slot")).toContainText("Process result 8");

  await page.evaluate(async calls => {
    const { patchToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const group = document.querySelector(".msg-tool-timeline");
    const entry = group.__toolTimelineGroupEntry;
    patchToolTimelineGroupElement(group, { ...entry, entries: [...entry.entries, ...calls] }, {
      presentationState: { expanded: true, userToggled: true, activeToolKey: group.dataset.activeToolKey },
    });
  }, Array.from({ length: 6 }, (_, index) => script(index + 9)));

  await expectFamilyPosition(group, 8, 14);
  await expect(group.locator(".tool-timeline-slot")).toContainText("Process result 8");
  await pager(group, -1).click();
  await expectFamilyPosition(group, 7, 14);
  await expect(group.locator(".tool-timeline-slot")).toContainText("Process result 7");
  await pager(group, 1).click();
  await expectFamilyPosition(group, 8, 14);
  await expect(group.locator(".tool-timeline-slot")).toContainText("Process result 8");
});

test("historical calls with transcript IDs keep distinct selections and matching counters", async ({ page }) => {
  await page.goto("/tests/tool-timeline/visual-test.html", { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const { createToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const entries = Array.from({ length: 14 }, (_, index) => ({
      type: "tool", id: `history-${index + 1}`, name: "run_script",
      args: { code: `return ${index + 1}` }, result: { result: `Historical call ${index + 1}` },
    }));
    document.querySelector("#messages").replaceChildren(createToolTimelineGroupElement({ entries }, { expanded: true }));
  });
  const group = page.locator(".msg-tool-timeline");
  await expectFamilyPosition(group, 14, 14);
  for (let index = 13; index >= 8; index -= 1) {
    await pager(group, -1).click();
    await expectFamilyPosition(group, index, 14);
    await expect(group.locator(".tool-timeline-slot")).toContainText(`Historical call ${index}`);
  }
  await expect(group).toHaveAttribute("data-active-tool-key", "history-8");
});

test("timeline patches refresh changed results and retain the selected call", async ({ page }) => {
  const { entries } = navigationFlow();
  const group = await openFlow(page, entries);
  await group.locator('.tool-family-row[data-tool-family-id="arrival"]').click();
  const results = await page.evaluate(async () => {
    const { createToolTimelineGroupElement, patchToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
    const { disposeRendererTree } = await import("/extension/sidepanel/tools/tool-renderer.js");
    const group = document.querySelector(".msg-tool-timeline");
    const entry = group.__toolTimelineGroupEntry;
    const key = group.dataset.activeToolKey;
    const tool = entry.entries.find(tool => (tool._uiKey || tool.toolCallId || tool.id) === key);
    const options = { presentationState: { expanded: true, userToggled: true, activeToolKey: key } };
    const changes = [
      () => { tool.result.title = "Updated destination"; },
      () => { tool.args.url = "https://example.com/updated"; },
      () => { tool.isError = true; tool.result.error = "Navigation failed"; },
      () => { tool.isError = false; tool.result = { title: "Recovered destination", url: tool.args.url }; },
    ];
    return changes.map(change => {
      const previous = group.dataset.toolTimelineSignature;
      change();
      patchToolTimelineGroupElement(group, entry, options);
      const fresh = createToolTimelineGroupElement(entry, options);
      const result = {
        changed: group.dataset.toolTimelineSignature !== previous,
        matchesFresh: group.dataset.toolTimelineSignature === fresh.dataset.toolTimelineSignature,
        selected: group.dataset.activeToolKey === key,
        detailsMatch: group.querySelector(".tool-timeline-slot").textContent === fresh.querySelector(".tool-timeline-slot").textContent,
      };
      const summary = group.querySelector(".tool-summary");
      patchToolTimelineGroupElement(group, entry, options);
      result.unchangedKeepsDom = group.querySelector(".tool-summary") === summary;
      disposeRendererTree(fresh);
      return result;
    });
  });
  expect(results).toEqual(Array(4).fill({ changed: true, matchesFresh: true, selected: true, detailsMatch: true, unchangedKeepsDom: true }));
  await expect(group.locator(".tool-family-batch.active em")).toHaveText("Recovered destination");
});
