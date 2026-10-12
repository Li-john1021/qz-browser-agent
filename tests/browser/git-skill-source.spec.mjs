import { expect, test } from "./fixtures.mjs";

const REPOSITORY_URL = "https://gitlab.example.com/example-team/browser-skills";
const GITHUB_REPOSITORY_URL = "https://github.com/openai/codex";

test.describe("Git skill repository page probe", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("extracts old GitLab archive metadata and removes secret query parameters", async ({ page }) => {
    await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async (repositoryUrl) => {
      const module = await import("/extension/background/skills/git-skill-sources.js");
      const probe = module.inspectGitRepositoryPage(repositoryUrl);
      return { probe, resolved: module.resolveGitRepositoryProbe(repositoryUrl, probe) };
    }, REPOSITORY_URL);

    expect(result.probe.projectId).toBe("3705939");
    expect(result.probe.branch).toBe("main");
    expect(result.probe.revision).toBe("a".repeat(40));
    expect(result.resolved.archiveUrl).toBe(
      "https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?path=&sha=main",
    );
    expect(result.resolved.archiveUrl).not.toMatch(/private_token|spm|must-not-persist/u);
  });

  test("derives the API v3 archive when the download menu is absent", async ({ page }) => {
    await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
    const resolved = await page.evaluate(async (repositoryUrl) => {
      document.querySelector("a[href*='archive.zip']")?.remove();
      const module = await import("/extension/background/skills/git-skill-sources.js");
      return module.resolveGitRepositoryProbe(repositoryUrl, module.inspectGitRepositoryPage(repositoryUrl));
    }, REPOSITORY_URL);

    expect(resolved.archiveUrl).toBe(
      "https://gitlab.example.com/api/v3/projects/3705939/repository/archive.zip?path=&sha=main",
    );
  });

  test("derives a GitHub archive from the page default branch", async ({ page }) => {
    await page.goto("/tests/git-skill-source/github-probe.html", { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async (repositoryUrl) => {
      const module = await import("/extension/background/skills/git-skill-sources.js");
      const probe = module.inspectGitRepositoryPage(repositoryUrl);
      return {
        probe,
        resolved: module.resolveGitRepositoryProbe(repositoryUrl, { ...probe, currentUrl: repositoryUrl }),
      };
    }, GITHUB_REPOSITORY_URL);

    expect(result.probe.branch).toBe("master");
    expect(result.probe.revision).toBe("b".repeat(40));
    expect(result.resolved.archiveUrl).toBe(`${GITHUB_REPOSITORY_URL}/archive/refs/heads/master.zip`);
  });
});

for (const skin of ["sidepanel.css"]) {
  for (const colorScheme of ["light", "dark"]) {
    test.describe(`Git skill sources UI · ${skin} · ${colorScheme}`, () => {
      test.use({ viewport: { width: 390, height: 844 }, colorScheme });

      test("keeps the repository source row compact and contained", async ({ page }) => {
        await page.goto("/tests/git-skill-source/probe.html", { waitUntil: "domcontentloaded" });
        await page.evaluate(async ({ skinName, repositoryUrl }) => {
          document.head.innerHTML = '<meta charset="utf-8">';
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = `/extension/sidepanel/${skinName}`;
          document.head.appendChild(link);
          await new Promise((resolve, reject) => {
            link.addEventListener("load", resolve, { once: true });
            link.addEventListener("error", reject, { once: true });
          });
          const html = await fetch("/extension/sidepanel/sidepanel.html").then(response => response.text());
          const parsed = new DOMParser().parseFromString(html, "text/html");
          const panel = parsed.querySelector("#git-skill-sources-panel");
          document.body.replaceChildren(document.importNode(panel, true));
          document.body.style.width = "100vw";
          document.body.style.height = "100vh";
          document.body.style.margin = "0";
          const module = await import("/extension/capabilities/skills/workspace/git-skill-sources-panel.js");
          const decisionModule = await import("/extension/sidepanel/ui/decision-dialog-feature.js");
          const decisions = decisionModule.createDecisionDialogFeature({ root: document });
          window.__decisionFeature = decisions;
          const source = {
            id: "git-content-supply",
            repositoryUrl,
            browseUrl: `${repositoryUrl}/tree/main/skills/browser`,
            host: "gitlab.example.com",
            namespace: "example-team",
            name: "browser-skills",
            ref: "main",
            subpath: "skills/browser",
            branch: "main",
            revision: "a".repeat(40),
            skillNames: Array.from({ length: 44 }, (_, index) => `skill-${index + 1}`),
            checkedAt: "2026-07-12 23:40:00",
            updatedAt: "2026-07-12 23:40:00",
            missingCount: 0,
            modifiedCount: 0,
          };
          window.__gitSourceRequests = [];
          const feature = module.createGitSkillSourcesPanel({
            root: document,
            request: async type => {
              window.__gitSourceRequests.push(type);
              if (type === "list_git_skill_sources") return { sources: [source] };
              if (type === "check_git_skill_source") {
                return {
                  ok: true,
                  action: "checked",
                  updateAvailable: true,
                  remoteChanged: true,
                  repairAvailable: false,
                  checkedAt: "2026-07-13 00:10:00",
                  source,
                };
              }
              return {};
            },
            confirm: decisions.confirm,
            choose: decisions.choose,
          });
          await feature.open();
        }, { skinName: skin, repositoryUrl: REPOSITORY_URL });

        const metrics = await page.evaluate(() => {
          const panel = document.querySelector("#git-skill-sources-panel");
          const row = panel.querySelector(".git-skill-source-row");
          const title = row.querySelector(".git-skill-source-title a");
          const titleGroup = row.querySelector(".git-skill-source-title");
          const branch = row.querySelector(".git-skill-source-title span");
          const location = row.querySelector(".git-skill-source-location");
          const subpath = row.querySelector(".git-skill-source-subpath");
          const actions = [...row.querySelectorAll(".git-skill-source-action")];
          return {
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth,
            rowColumns: getComputedStyle(row).gridTemplateColumns,
            titleContained: title.getBoundingClientRect().right <= titleGroup.getBoundingClientRect().right + 0.5,
            branchText: branch.textContent,
            locationText: location.textContent,
            subpathText: subpath?.textContent || "",
            actionSizes: actions.map(action => [action.offsetWidth, action.offsetHeight]),
            visibleRows: panel.querySelectorAll(".git-skill-source-row").length,
            background: getComputedStyle(panel).backgroundColor,
          };
        });
        expect(metrics.pageOverflow).toBe(0);
        expect(metrics.panelOverflow).toBe(0);
        expect(metrics.rowColumns).toMatch(/^28px\s+.+\s+54px$/u);
        expect(metrics.titleContained).toBe(true);
        expect(metrics.branchText).toBe("main");
        expect(metrics.locationText).toBe("gitlab.example.com / example-team");
        expect(metrics.subpathText).toBe("目录 skills/browser");
        expect(metrics.actionSizes).toEqual([[26, 26], [26, 26]]);
        expect(metrics.visibleRows).toBe(1);
        expect(metrics.background).not.toBe("rgba(0, 0, 0, 0)");

        await page.locator('[data-git-source-action="check"]').click();
        await expect(page.locator('[data-git-source-action="update"]')).toBeVisible();
        await expect(page.locator(".git-skill-source-check-state")).toHaveText("有更新");
        const checkedMetrics = await page.evaluate(() => ({
          requestTypes: window.__gitSourceRequests,
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panelOverflow: document.querySelector("#git-skill-sources-panel").scrollWidth
            - document.querySelector("#git-skill-sources-panel").clientWidth,
          applyHeight: document.querySelector('[data-git-source-action="update"]').offsetHeight,
        }));
        const requestTypes = checkedMetrics.requestTypes;
        expect(requestTypes).toContain("check_git_skill_source");
        expect(requestTypes).not.toContain("update_git_skill_source");
        expect(checkedMetrics.pageOverflow).toBe(0);
        expect(checkedMetrics.panelOverflow).toBe(0);
        expect(checkedMetrics.applyHeight).toBe(26);

        await page.locator('[data-git-source-action="remove"]').click();
        const removal = await page.evaluate(() => {
          const dialog = document.querySelector("#qz-decision-dialog");
          const panel = dialog.querySelector(".qz-decision-panel");
          const bounds = panel.getBoundingClientRect();
          return {
            visible: dialog.open,
            choices: [...dialog.querySelectorAll("[data-qz-decision-value] strong")].map(element => element.textContent.trim()),
            pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            panelContained: bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth,
            panelCenterY: bounds.top + bounds.height / 2,
            viewportCenterY: document.documentElement.clientHeight / 2,
          };
        });
        expect(removal.visible).toBe(true);
        expect(removal.choices).toEqual(["保留 Skill", "清除未修改项"]);
        expect(removal.pageOverflow).toBe(0);
        expect(removal.panelContained).toBe(true);
        expect(removal.panelCenterY).toBeLessThan(removal.viewportCenterY);
        await page.keyboard.press("Escape");
        await expect(page.locator("#qz-decision-dialog")).not.toBeVisible();

        await page.evaluate(() => {
          window.__decisionResult = "pending";
          void window.__decisionFeature.confirm({
            title: "覆盖本地修改？",
            message: "继续后会以仓库版本覆盖当前修改。",
            confirmLabel: "继续覆盖",
            tone: "danger",
          }).then(result => { window.__decisionResult = result; });
        });
        await expect(page.locator("#qz-decision-dialog")).toBeVisible();
        const confirmation = await page.evaluate(() => {
          const panel = document.querySelector(".qz-decision-panel");
          const style = getComputedStyle(panel);
          return {
            title: document.querySelector("#qz-decision-title")?.textContent,
            message: document.querySelector("#qz-decision-message")?.textContent,
            cancelFocused: document.activeElement?.id === "qz-decision-cancel",
            borderLeft: style.borderLeftColor,
            borderTop: style.borderTopColor,
            confirmClass: document.querySelector("#qz-decision-confirm")?.className,
          };
        });
        expect(confirmation.title).toBe("覆盖本地修改？");
        expect(confirmation.message).toBe("继续后会以仓库版本覆盖当前修改。");
        expect(confirmation.cancelFocused).toBe(true);
        expect(confirmation.borderLeft).toBe(confirmation.borderTop);
        expect(confirmation.confirmClass).toContain("qz-btn--danger");
        await page.locator("#qz-decision-confirm").click();
        await expect.poll(() => page.evaluate(() => window.__decisionResult)).toBe(true);
      });
    });
  }
}
