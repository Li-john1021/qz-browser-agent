import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/git-skill-source/probe.html");
  await page.evaluate(async () => {
    const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
    const parsed = new DOMParser().parseFromString(html, "text/html");
    document.head.innerHTML = '<link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
    document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
    document.querySelector("#app").removeAttribute("data-workspace-booting");
    document.querySelectorAll(".tab-panel").forEach(panel => panel.classList.add("hidden"));
    document.querySelector("#skills-panel").classList.remove("hidden");
    const { normalizeModernSkill } = await import("/extension/shared/skills/skill-utils.js");
    const { createMemoryStorage } = await import("/tests/support/memory-storage.mjs");
    const alpha = normalizeModernSkill({ name: "alpha", description: "Alpha skill", content: "original" });
    const beta = normalizeModernSkill({ name: "beta", description: "Beta skill", content: "second" });
    const storage = createMemoryStorage({ _skills: { alpha, beta } });
    const tabListeners = new Set();
    const tabEvent = () => ({ addListener: listener => tabListeners.add(listener), removeListener: listener => tabListeners.delete(listener) });
    globalThis.chrome = { storage: { local: storage }, tabs: { query: async () => [], onUpdated: tabEvent(), onActivated: tabEvent() } };
    const { createSkillStateRepository } = await import("/extension/background/skills/skill-repository.js");
    const { createSkillWorkspaceService } = await import("/extension/background/skills/skill-workspace.js");
    const repository = createSkillStateRepository({ storage });
    const gates = [];
    const workspace = createSkillWorkspaceService({ repository, prepare: async () => {}, validate: async () => {}, onChanged: async () => {} });
    const { createSkillsFeature } = await import("/extension/capabilities/skills/workspace/skills-feature.js");
    const calls = [], toasts = [];
    const lifetime = new AbortController();
    const featureOptions = {
      signal: lifetime.signal, root: document, isActive: () => true, showToast: message => toasts.push(message), confirm: async () => true,
      request: async (type, payload) => {
        calls.push({ type, payload: structuredClone(payload) });
        if (type === "get_skill_workspace") return workspace.read();
        if (type === "save_workspace_skill") {
          await new Promise((resolve, reject) => gates.push({ resolve, reject }));
          return workspace.save(payload);
        }
        if (type === "delete_workspace_skill") return workspace.remove(payload);
        if (type === "import_workspace_skills") return workspace.import(payload);
        return {};
      },
    };
    const feature = createSkillsFeature(featureOptions);
    await feature.activate();
    feature.showDetail("alpha");
    window.__skillsTest = {
      feature, calls, toasts, storage, lifetime, tabListeners,
      async remount() {
        const nextLifetime = new AbortController();
        const next = createSkillsFeature({ ...featureOptions, signal: nextLifetime.signal });
        await next.activate();
        next.showDetail("alpha");
        return next;
      },
      resolveSave: () => gates.shift().resolve(),
      rejectSave: () => gates.shift().reject(new Error("temporary storage failure")),
      async competingWrite() {
        const before = await repository.read();
        await repository.commit(before, { _skills: { ...before._skills, alpha: normalizeModernSkill({ ...alpha, content: "Agent update" }) } });
      },
    };
  });
  await page.locator("#btn-edit-skill").click();
});

async function save(page, value) {
  await page.locator("#skill-body-text").fill(value);
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBeGreaterThan(0);
}

test("saving preserves newer edits and uses the saved snapshot for the next save", async ({ page }) => {
  await save(page, "first edit");
  await page.locator("#skill-body-text").fill("newer edit");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("newer edit");
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("first edit");
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  expect(await page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill")[1].payload.expected.content)).toBe("first edit");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeDisabled();
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("newer edit");
});

test("a late save cannot replace the newly opened Skill editor", async ({ page }) => {
  await save(page, "saved alpha");
  await page.evaluate(() => window.__skillsTest.feature.showDetail("beta"));
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#skill-detail-name")).toHaveText("beta");
  await expect(page.locator("#skill-body-text")).toHaveValue("second");
  await expect.poll(() => page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("saved alpha");
});

test("a competing Agent write rejects the stale draft without losing either value", async ({ page }) => {
  await save(page, "local draft");
  await page.evaluate(async () => { await window.__skillsTest.competingWrite(); window.__skillsTest.resolveSave(); });
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("local draft");
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("Agent update");
  expect(await page.evaluate(() => window.__skillsTest.toasts.join("\n"))).toContain("已被其他操作修改");
});

test("a failed save retains the draft and a subsequent retry succeeds", async ({ page }) => {
  await save(page, "retry me");
  await page.evaluate(() => window.__skillsTest.rejectSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
  await expect(page.locator("#skill-body-text")).toHaveValue("retry me");
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeDisabled();
  expect(await page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("retry me");
});


test("disposing Skills isolates late saves and releases browser listeners before remount", async ({ page }) => {
  await save(page, "persisted by the old mount");
  expect(await page.evaluate(() => window.__skillsTest.tabListeners.size)).toBe(2);
  await page.evaluate(async () => {
    const state = window.__skillsTest;
    state.lifetime.abort();
    state.listenersAfterAbort = state.tabListeners.size;
    state.feature = await state.remount();
  });
  expect(await page.evaluate(() => window.__skillsTest.listenersAfterAbort)).toBe(0);
  expect(await page.evaluate(() => window.__skillsTest.tabListeners.size)).toBe(2);
  await page.locator("#btn-edit-skill").click();
  await page.locator("#skill-body-text").fill("draft in the new mount");
  await page.evaluate(() => window.__skillsTest.resolveSave());
  await expect.poll(() => page.evaluate(() => window.__skillsTest.storage.snapshot()._skills.alpha.content)).toBe("persisted by the old mount");
  await expect(page.locator("#skill-body-text")).toHaveValue("draft in the new mount");
  await expect(page.locator("#skill-detail")).not.toHaveClass(/has-error/);
  expect(await page.evaluate(() => window.__skillsTest.toasts)).toEqual([]);
  await page.locator("#btn-save-skill-edit-top").click();
  await expect.poll(() => page.evaluate(() => window.__skillsTest.calls.filter(call => call.type === "save_workspace_skill").length)).toBe(2);
  await page.evaluate(() => window.__skillsTest.rejectSave());
  await expect(page.locator("#btn-save-skill-edit-top")).toBeEnabled();
});
