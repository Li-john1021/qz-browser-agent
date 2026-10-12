import { expect, test } from "./fixtures.mjs";

test.describe("Git skill publish target lifecycle", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps the confirmed target after the live tab target disappears", async ({ page }) => {
    await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
      const parsed = new DOMParser().parseFromString(html, "text/html");
      document.head.innerHTML = '<meta charset="utf-8"><link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">';
      document.body.replaceChildren(...Array.from(parsed.body.children, element => document.importNode(element, true)));
      document.querySelector("#app")?.removeAttribute("data-workspace-booting");

      const calls = [];
      let liveTargetAvailable = true;
      const confirmedTarget = {
        available: true,
        tabId: 71,
        pageUrl: "https://gitlab.example.com/example-user/testlib/tree/master/skills",
        repositoryUrl: "https://gitlab.example.com/example-user/testlib",
        browseUrl: "https://gitlab.example.com/example-user/testlib/tree/master/skills",
        host: "gitlab.example.com",
        namespace: "example-user",
        name: "testlib",
        ref: "master",
        subpath: "skills",
        projectId: "4242575",
      };
      const skill = {
        name: "publish-smoke",
        description: "Publish lifecycle smoke Skill.",
        content: "# Publish lifecycle smoke",
        scope: "global",
        status: "active",
        format: "qingzhou.skill",
        schemaVersion: 2,
        resources: [],
        updatedAt: "2026-07-14 10:00:00",
      };

      const event = () => ({
        addListener(listener) { this.listeners.push(listener); },
        removeListener(listener) { this.listeners = this.listeners.filter(item => item !== listener); },
        listeners: [],
      });
      const onActivated = event();
      const onUpdated = event();
      globalThis.chrome = {
        storage: {
          local: {
            async get() {
              return { _skills: { [skill.name]: skill } };
            },
            async set() {},
          },
        },
        tabs: {
          onActivated,
          onUpdated,
          async query() { return []; },
        },
        downloads: { async download() {} },
      };

      const request = async (type, payload = {}) => {
        calls.push({ type, payload: structuredClone(payload) });
        if (type === "get_skill_workspace") return { skills: [skill], installStates: {} };
        if (type === "inspect_git_skill_publish_target") {
          return liveTargetAvailable
            ? structuredClone(confirmedTarget)
            : { available: false, reason: "active_tab_not_code_tree" };
        }
        if (type === "publish_skill_to_git") {
          throw new Error("Git 页面重新打开失败");
        }
        return {};
      };
      const { createSkillsFeature } = await import(
        `/extension/capabilities/skills/workspace/skills-feature.js?git-publish-lifecycle=${Date.now()}`
      );
      const feature = createSkillsFeature({
        root: document,
        request,
        isActive: () => true,
        renderMarkdown: value => String(value || ""),
        showToast: () => {},
      });
      await feature.activate();
      document.querySelector("#skills-panel")?.classList.remove("hidden");
      feature.showDetail(skill.name);

      globalThis.__gitPublishLifecycleHarness = {
        calls,
        confirmedTarget,
        setLiveTargetAvailable(value) { liveTargetAvailable = value; },
        activateTab() {
          for (const listener of [...onActivated.listeners]) listener({ tabId: 99, windowId: 1 });
        },
      };
    });

    const publishButton = page.locator("#btn-publish-skill-git");
    await expect(publishButton).toBeVisible();
    await publishButton.click();
    await expect(page.locator("#skill-git-publish-confirm")).toBeVisible();
    await expect(page.locator("#skill-git-publish-repository")).toHaveText("example-user/testlib");

    const inspectCountBeforeActivation = await page.evaluate(() => (
      globalThis.__gitPublishLifecycleHarness.calls
        .filter(call => call.type === "inspect_git_skill_publish_target")
        .length
    ));
    await page.evaluate(() => {
      const harness = globalThis.__gitPublishLifecycleHarness;
      harness.setLiveTargetAvailable(false);
      harness.activateTab();
    });
    await expect.poll(() => page.evaluate(() => (
      globalThis.__gitPublishLifecycleHarness.calls
        .filter(call => call.type === "inspect_git_skill_publish_target")
        .length
    ))).toBeGreaterThan(inspectCountBeforeActivation);
    await expect(publishButton).toBeHidden();

    await page.locator("#btn-confirm-skill-git-publish").click();
    await expect.poll(() => page.evaluate(() => (
      globalThis.__gitPublishLifecycleHarness.calls
        .filter(call => call.type === "publish_skill_to_git")
        .length
    ))).toBe(1);

    const publishPayload = await page.evaluate(() => (
      globalThis.__gitPublishLifecycleHarness.calls
        .find(call => call.type === "publish_skill_to_git")
        ?.payload
    ));
    expect(publishPayload.target).toEqual(await page.evaluate(() => (
      globalThis.__gitPublishLifecycleHarness.confirmedTarget
    )));
    await expect(page.locator("#skill-git-publish-confirm")).toBeVisible();
    await expect(page.locator("#skill-git-publish-status")).toHaveText("Git 页面重新打开失败");
  });
});
