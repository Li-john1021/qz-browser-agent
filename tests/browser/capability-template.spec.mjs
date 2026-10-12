import { expect, test } from "./fixtures.mjs";

test("capability templates remount from clean markup and release only their own clone", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { mountUiTemplate } = await import("/extension/sidepanel/capability-host/mount-template.js");
    document.body.innerHTML = '<main id="app"><aside id="sibling">Keep</aside></main><template id="example-template"><section id="example-page"><input value="Initial"></section><section id="example-settings">Settings</section></template>';
    const cleanups = [];
    const first = mountUiTemplate(document, "example-template", callback => cleanups.push(callback));
    first.querySelector("input").value = "Edited";
    // The settings shell may move a contributed section into its own panel.
    document.body.append(first.querySelector("#example-settings"));
    let duplicate = "";
    try { mountUiTemplate(document, "example-template", callback => cleanups.push(callback)); }
    catch (error) { duplicate = error.message; }
    const before = { pages: document.querySelectorAll("#example-page").length, cleanups: cleanups.length };
    cleanups.pop()();
    const removed = !document.getElementById("example-page") && !document.getElementById("example-settings");
    const second = mountUiTemplate(document, "example-template", callback => cleanups.push(callback));
    const restored = second.querySelector("input").value;
    cleanups.pop()();
    let missing = "";
    try { mountUiTemplate(document, "missing", callback => cleanups.push(callback)); }
    catch (error) { missing = error.message; }
    return { before, removed, restored, duplicate, missing,
      templatePresent: document.getElementById("example-template") instanceof HTMLTemplateElement,
      sibling: document.getElementById("sibling").textContent, remaining: document.querySelector("#app").children.length };
  });
  expect(result).toMatchObject({ before: { pages: 1, cleanups: 1 }, removed: true, restored: "Initial",
    templatePresent: true, sibling: "Keep", remaining: 1 });
  expect(result.duplicate).toMatch(/Duplicate mounted UI id/);
  expect(result.missing).toMatch(/template is missing/);
});
