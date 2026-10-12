import { expect, test, testAssetUrl } from "./fixtures.mjs";
import { readFileSync } from "node:fs";

const shellHtml = `<!doctype html><style>.hidden { display:none }</style>
<button id="btn-settings">设置</button>
<div id="settings-panel" class="hidden"><div class="settings-backdrop"></div><div class="settings-content">
<button id="btn-close-settings">关闭</button><div class="settings-tabs" role="tablist"></div>
<div id="settings-save-state"><div id="settings-save-status"></div><div id="settings-version-muted"></div><button id="btn-save-settings">保存</button></div>
</div></div>`;
const settingsHtml = readFileSync(new URL("../../src/capabilities/settings/ui.html", import.meta.url), "utf8");

test.beforeEach(async ({ page }) => {
  await page.route("**/settings-shell-test", route => route.fulfill({ contentType: "text/html", body: shellHtml + settingsHtml }));
  await page.goto(testAssetUrl("/settings-shell-test"));
  await page.evaluate(async () => {
    const { createSettingsShell } = await import("/extension/sidepanel/capability-host/settings-shell.js");
    const errors = [], sections = [], calls = [];
    const shell = createSettingsShell(document, error => errors.push(String(error)));
    let changed;
    shell.connect({ getSettingsSections: () => [...sections].sort((a, b) => (a.order || 0) - (b.order || 0)), subscribeChanges(listener) { changed = listener; return () => { changed = null; }; } });
    window.fixture = {
      shell, sections, errors, calls, changed: () => changed?.(),
      add(id, extra = {}) {
        const element = document.createElement("div");
        element.textContent = `${id} 独立表单`;
        const section = { id, title: id, element, save() { calls.push(id); }, ...extra };
        sections.push(section); changed?.(); return section;
      },
    };
  });
});

test("late contributions determine the initial ordered section without replacing a later user selection", async ({ page }) => {
  await page.evaluate(() => {
    window.fixture.add("late-order", { order: 90 });
    window.fixture.add("first-order", { order: 10 });
  });
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-panel-first-order")).toBeVisible();
  await page.locator("#settings-tab-late-order").click();
  await page.evaluate(() => window.fixture.add("new-first-order", { order: 0 }));
  await expect(page.locator("#settings-panel-late-order")).toBeVisible();
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-panel-late-order")).toBeVisible();
});

test("an explicit section wins over contribution order on the first open", async ({ page }) => {
  await page.evaluate(() => {
    window.fixture.add("first-order", { order: 10 });
    window.fixture.add("requested", { order: 90 });
    window.fixture.shell.open("requested");
  });
  await expect(page.locator("#settings-panel-requested")).toBeVisible();
});

for (const direction of ["ltr", "rtl"]) {
  test(`keyboard navigation follows display order and ${direction} direction after late registration`, async ({ page }) => {
    await page.evaluate(direction => {
      document.documentElement.dir = direction;
      window.fixture.add("last", { order: 90 });
      window.fixture.add("first", { order: 10 });
      window.fixture.add("middle", { order: 50 });
    }, direction);
    await page.locator("#btn-settings").click();
    const forward = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
    await page.locator("#settings-tab-first").focus();
    for (const [key, id] of [[forward, "middle"], [forward, "last"], [forward, "first"], [backward, "last"], ["Home", "first"], ["End", "last"]]) {
      await page.keyboard.press(key);
      await expect(page.locator(`#settings-tab-${id}`)).toBeFocused();
      await expect(page.locator(`#settings-tab-${id}`)).toHaveAttribute("aria-selected", "true");
      await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    }
  });
}

test("hidden and removed focused tabs pass focus to an available section", async ({ page }) => {
  await page.evaluate(() => {
    window.fixture.add("alpha", { activate({ signal }) { window.fixture.activation = signal; } });
    window.fixture.add("beta");
    window.fixture.add("gamma");
  });
  await page.locator("#btn-settings").click();
  await page.locator("#settings-tab-alpha").focus();
  await page.evaluate(() => { window.fixture.sections[0].visible = () => false; window.fixture.changed(); });
  await expect(page.locator("#settings-tab-beta")).toBeFocused();
  await expect(page.locator("#settings-panel-beta")).toBeVisible();
  expect(await page.evaluate(() => window.fixture.activation.aborted)).toBe(true);
  await page.evaluate(() => { window.fixture.sections.splice(1, 1); window.fixture.changed(); });
  await expect(page.locator("#settings-tab-gamma")).toBeFocused();
  await expect(page.locator("#settings-panel-gamma")).toBeVisible();
});

test("an ordinary settings refresh preserves form focus and selection", async ({ page }) => {
  await page.evaluate(() => {
    const section = window.fixture.add("alpha");
    const input = document.createElement("input");
    input.id = "draft-field";
    input.value = "preserved draft";
    section.element.appendChild(input);
    window.fixture.add("beta");
  });
  await page.locator("#btn-settings").click();
  await page.locator("#draft-field").focus();
  await page.evaluate(() => {
    document.querySelector("#draft-field").setSelectionRange(2, 8);
    window.fixture.changed();
  });
  await expect(page.locator("#draft-field")).toBeFocused();
  await expect(page.locator("#draft-field")).toHaveValue("preserved draft");
  expect(await page.locator("#draft-field").evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 8]);
});

test("hiding every section clears the old panel and restores navigation when a section returns", async ({ page }) => {
  await page.evaluate(() => window.fixture.add("alpha"));
  await page.locator("#btn-settings").click();
  await page.locator("#settings-tab-alpha").focus();
  await page.evaluate(() => { window.fixture.sections[0].visible = () => false; window.fixture.changed(); });
  await expect(page.locator("#settings-panel-alpha")).toBeHidden();
  await expect(page.locator('[role="tab"]:visible')).toHaveCount(0);
  await expect(page.locator("#btn-close-settings")).toBeFocused();
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.shell.currentSection())).toBe("");
  await page.evaluate(() => { window.fixture.sections[0].visible = () => true; window.fixture.changed(); });
  await expect(page.locator("#settings-panel-alpha")).toBeVisible();
  await expect(page.locator("#settings-tab-alpha")).toHaveAttribute("aria-selected", "true");
});

test("independent sections work without the built-in settings package and use dynamic navigation", async ({ page }) => {
  await page.evaluate(() => {
    const { shell, add } = window.fixture;
    add("alpha"); add("beta"); add("gamma"); add("delta", { order: 10, visible: () => false });
    shell.setState("alpha", { text: "Alpha 草稿", saveLabel: "保存 Alpha" });
    shell.setState("beta", { text: "Beta 草稿", saveLabel: "保存 Beta" });
  });
  await page.locator("#btn-settings").click();
  await expect(page.locator('[role="tab"]:visible')).toHaveCount(3);
  await expect(page.locator("#settings-save-status")).toHaveText("Alpha 草稿");
  await page.locator("#settings-tab-alpha").press("ArrowRight");
  await expect(page.locator("#settings-panel-beta")).toBeVisible();
  await expect(page.locator("#settings-save-status")).toHaveText("Beta 草稿");
  await page.locator("#btn-save-settings").click();
  await expect(page.locator("#settings-save-status")).toHaveText("已保存");
  expect(await page.evaluate(() => window.fixture.calls)).toEqual(["beta"]);
  await page.evaluate(() => { window.fixture.sections[3].visible = () => true; window.fixture.changed(); });
  await expect(page.locator('[role="tab"]:visible')).toHaveCount(4);
  await page.locator("#settings-tab-beta").press("End");
  await expect(page.locator("#settings-panel-delta")).toBeVisible();
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await expect(page.locator("#settings-panel-delta")).toBeVisible();
});

test("switching or closing cancels old saves and keeps newer errors and busy state isolated", async ({ page }) => {
  await page.evaluate(() => {
    window.fixture.pending = [];
    const save = ({ signal }) => new Promise((resolve, reject) => window.fixture.pending.push({ signal, resolve, reject }));
    window.fixture.add("alpha", { save }); window.fixture.add("beta", { save });
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  await page.locator("#settings-tab-beta").click();
  await page.evaluate(() => window.fixture.pending[0].reject(new Error("stale Alpha failure")));
  await expect(page.locator("#settings-save-status")).not.toContainText("Alpha failure");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await page.locator("#btn-save-settings").click();
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => window.fixture.pending[1].resolve());
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.pending.map(item => item.signal.aborted))).toEqual([true, true, false]);
  await page.evaluate(() => window.fixture.pending[2].reject(new Error("current Beta failure")));
  await expect(page.locator("#settings-save-status")).toHaveText("current Beta failure");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  expect(await page.evaluate(() => window.fixture.errors)).toEqual(["Error: current Beta failure"]);
});

test("removing a section aborts its activation and leaves the remaining contribution usable", async ({ page }) => {
  await page.evaluate(() => {
    window.fixture.add("alpha", { activate({ signal }) { window.fixture.activation = signal; }, deactivate() { window.fixture.calls.push("alpha closed"); } });
    window.fixture.add("beta");
  });
  await page.locator("#btn-settings").click();
  await page.evaluate(() => { window.fixture.sections.splice(0, 1); window.fixture.changed(); });
  await expect(page.locator("#settings-tab-alpha")).toHaveCount(0);
  await expect(page.locator("#settings-panel-beta")).toBeVisible();
  expect(await page.evaluate(() => window.fixture.activation.aborted)).toBe(true);
  await page.locator("#btn-save-settings").click();
  expect(await page.evaluate(() => window.fixture.calls)).toEqual(["alpha closed", "beta"]);
});

test("independent contributions share one ordered tab without replacing their focused drafts", async ({ page }) => {
  await page.evaluate(() => {
    const { add, shell } = window.fixture;
    window.fixture.activations = [];
    const tab = { id: "preferences", title: "Preferences", order: 20 };
    for (const [id, order] of [["advanced-options", 30], ["locale", 10]]) {
      const section = add(id, { order, tab, activate({ signal }) { window.fixture.activations.push({ id, signal }); } });
      section.element.dataset.contribution = id;
      const input = document.createElement("input");
      input.id = `${id}-draft`;
      input.value = `${id} draft`;
      section.element.append(input);
    }
    add("model-options", { order: 99, tab: { id: "models", title: "Models", order: 10 } });
    shell.open("locale");
  });
  await expect(page.locator('[role="tab"]')).toHaveText(["Models", "Preferences"]);
  await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
  await expect(page.locator('[role="tabpanel"]:visible #locale-draft')).toBeVisible();
  await expect(page.locator('[role="tabpanel"]:visible #advanced-options-draft')).toBeVisible();
  expect(await page.evaluate(() => window.fixture.shell.currentSection())).toBe("preferences");
  expect(await page.locator('[role="tabpanel"]:visible [data-contribution]').evaluateAll(elements => elements.map(element => element.dataset.contribution))).toEqual(["locale", "advanced-options"]);

  await page.locator("#locale-draft").fill("unsaved language choice");
  await page.locator("#locale-draft").focus();
  await page.evaluate(() => {
    document.querySelector("#locale-draft").setSelectionRange(2, 8);
    window.fixture.changed();
    const section = window.fixture.add("new-option", { order: 50, tab: { id: "preferences", title: "Preferences", order: 20 } });
    section.element.dataset.contribution = "new-option";
  });
  await expect(page.locator("#locale-draft")).toBeFocused();
  await expect(page.locator("#locale-draft")).toHaveValue("unsaved language choice");
  expect(await page.locator("#locale-draft").evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 8]);
  expect(await page.evaluate(() => window.fixture.activations.map(({ id, signal }) => [id, signal.aborted]))).toEqual([["locale", false], ["advanced-options", false]]);
  await expect(page.locator('[role="tab"]')).toHaveCount(2);
  await page.locator("#settings-tab-preferences").press("ArrowLeft");
  await expect(page.locator("#settings-tab-models")).toBeFocused();
  await expect(page.locator("#locale-draft")).toBeHidden();
});

for (const action of ["close", "switch"]) {
  test(`a member that synchronously ${action === "close" ? "closes" : "switches"} settings prevents stale sibling activation`, async ({ page }) => {
    await page.evaluate(action => {
      const { add, shell } = window.fixture;
      const tab = { id: "preferences", title: "Preferences", order: 10 };
      window.fixture.activations = [];
      window.fixture.redirect = true;
      add("language", { tab, order: 10, activate({ signal }) {
        window.fixture.activations.push({ id: "language", signal });
        if (!window.fixture.redirect) return;
        if (action === "close") shell.close();
        else shell.open("model");
      } });
      add("advanced", { tab, order: 20, activate({ signal }) {
        window.fixture.activations.push({ id: "advanced", signal });
      } });
      add("model", { order: 30, activate({ signal }) {
        window.fixture.activations.push({ id: "model", signal });
      } });
      shell.open("language");
    }, action);
    expect(await page.evaluate(() => window.fixture.activations.map(({ id, signal }) => [id, signal.aborted])))
      .toEqual(action === "close" ? [["language", true]] : [["language", true], ["model", false]]);
    expect(await page.evaluate(() => window.fixture.shell.currentSection())).toBe(action === "close" ? "" : "model");
    if (action === "close") await expect(page.locator("#settings-panel")).toBeHidden();
    else await expect(page.locator("#settings-panel-model")).toBeVisible();

    await page.evaluate(() => {
      window.fixture.shell.close();
      window.fixture.redirect = false;
      window.fixture.shell.open("language");
    });
    await expect(page.locator("#settings-panel-language")).toBeVisible();
    await expect(page.locator("#settings-panel-advanced")).toBeVisible();
    expect(await page.evaluate(() => window.fixture.activations.slice(-2).map(({ id, signal }) => [id, signal.aborted])))
      .toEqual([["language", false], ["advanced", false]]);
  });
}

test("a shared save preserves a failed contribution and retries only its remaining changes", async ({ page }) => {
  await page.evaluate(() => {
    const { add, shell, calls } = window.fixture;
    const tab = { id: "preferences", title: "Preferences" };
    window.fixture.pending = {};
    window.fixture.languageAttempts = 0;
    window.fixture.afterSaves = [];
    add("language", { tab, order: 10, async save() {
      calls.push("language");
      if (++window.fixture.languageAttempts === 1) {
        await new Promise((resolve, reject) => { window.fixture.pending.language = { resolve, reject }; });
      }
      shell.setState("language", { text: "Language saved", tone: "saved", disabled: true });
    }, afterSave() { window.fixture.afterSaves.push("language"); } });
    add("advanced", { tab, order: 20, async save() {
      calls.push("advanced");
      await new Promise(resolve => { window.fixture.pending.advanced = { resolve }; });
      shell.setState("advanced", { text: "Advanced saved", tone: "saved", disabled: true });
    }, afterSave() { window.fixture.afterSaves.push("advanced"); } });
    shell.setState("language", { text: "Language changed", tone: "dirty", disabled: false });
    shell.setState("advanced", { text: "Advanced changed", tone: "dirty", disabled: false });
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  await expect.poll(() => page.evaluate(() => window.fixture.calls)).toEqual(["language", "advanced"]);
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await page.evaluate(() => window.fixture.pending.language.reject(new Error("Language could not be saved")));
  await page.evaluate(() => window.fixture.pending.advanced.resolve());
  await expect(page.locator("#settings-save-status")).toContainText("Language could not be saved");
  await expect(page.locator("#settings-save-status")).toHaveAttribute("data-tone", "error");
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
  await page.locator("#btn-save-settings").click();
  await expect(page.locator("#settings-save-status")).toContainText("Language saved");
  await expect(page.locator("#settings-save-status")).not.toContainText("could not");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.calls)).toEqual(["language", "advanced", "language"]);
  await expect.poll(() => page.evaluate(() => window.fixture.afterSaves)).toEqual(["language", "advanced"]);
  expect(await page.evaluate(() => window.fixture.errors)).toEqual(["Error: Language could not be saved"]);
  await expect(page.locator("#settings-panel")).toBeVisible();
});

async function openDeferredSaveGroup(page) {
  await page.evaluate(() => {
    const { add, shell } = window.fixture;
    const tab = { id: "preferences", title: "Preferences" };
    Object.assign(window.fixture, { pending: {}, afterSaves: [], completedSaves: [], nextState: {} });
    for (const [id, order] of [["language", 10], ["advanced", 20]]) {
      add(id, {
        tab, order,
        async save({ signal }) {
          window.fixture.calls.push(id);
          try {
            const result = await new Promise((resolve, reject) => { window.fixture.pending[id] = { resolve, reject, signal }; });
            if (result === false) return false;
            shell.setState(id, window.fixture.nextState[id] || { text: `${id} saved`, tone: "saved", disabled: true });
            return true;
          } finally { window.fixture.completedSaves.push(id); }
        },
        afterSave({ signal, refresh }) { window.fixture.afterSaves.push({ id, aborted: signal.aborted, refresh }); },
      });
      shell.setState(id, { text: `${id} changed`, tone: "dirty", disabled: false });
    }
    add("other", { order: 30 });
    shell.open("preferences");
  });
}

test("afterSave waits for the entire tab to finish before notifying its live members", async ({ page }) => {
  await openDeferredSaveGroup(page);
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => window.fixture.pending.language.resolve());
  await expect(page.locator("#settings-save-status")).toContainText("language saved");
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
  await page.evaluate(() => window.fixture.pending.advanced.resolve());
  await expect.poll(() => page.evaluate(() => window.fixture.afterSaves)).toEqual([
    { id: "language", aborted: false, refresh: false },
    { id: "advanced", aborted: false, refresh: false },
  ]);
  expect(await page.evaluate(() => window.fixture.completedSaves)).toEqual(["language", "advanced"]);
});

for (const failure of ["false", "throw", "error status"]) {
  test(`afterSave is suppressed when a member reports ${failure}`, async ({ page }) => {
    await openDeferredSaveGroup(page);
    await page.locator("#btn-save-settings").click();
    await page.evaluate(failure => {
      const { pending, nextState } = window.fixture;
      pending.language.resolve();
      if (failure === "throw") pending.advanced.reject(new Error("Advanced save failed"));
      else if (failure === "false") pending.advanced.resolve(false);
      else {
        nextState.advanced = { text: "Advanced save failed", tone: "error", disabled: false };
        pending.advanced.resolve();
      }
    }, failure);
    await expect(page.locator("#settings-save-status")).toHaveAttribute("data-tone", "error");
    await expect(page.locator("#btn-save-settings")).toBeEnabled();
    expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
  });
}

for (const interruption of ["close", "switch", "remove", "replace"]) {
  test(`afterSave ignores a pending group after ${interruption}`, async ({ page }) => {
    await openDeferredSaveGroup(page);
    await page.locator("#btn-save-settings").click();
    await page.evaluate(interruption => {
      const { shell, sections, changed, pending, add } = window.fixture;
      if (interruption === "close") { shell.close(); shell.open("preferences"); }
      else if (interruption === "switch") { shell.open("other"); shell.open("preferences"); }
      else {
        sections.splice(sections.findIndex(section => section.id === "advanced"), 1);
        changed();
        if (interruption === "replace") add("advanced", {
          tab: { id: "preferences", title: "Preferences" }, order: 20,
          afterSave() { window.fixture.afterSaves.push({ id: "replacement" }); },
        });
      }
      pending.language.resolve();
      pending.advanced.resolve();
    }, interruption);
    await expect.poll(() => page.evaluate(() => window.fixture.completedSaves.length)).toBe(2);
    expect(await page.evaluate(() => window.fixture.pending.advanced.signal.aborted)).toBe(true);
    expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
  });
}

for (const remaining of ["dirty", "busy"]) {
  test(`afterSave preserves a member that became ${remaining} while its sibling was saving`, async ({ page }) => {
    await openDeferredSaveGroup(page);
    await page.locator("#btn-save-settings").click();
    await page.evaluate(() => window.fixture.pending.language.resolve());
    await expect(page.locator("#settings-save-status")).toContainText("language saved");
    await page.evaluate(remaining => {
      window.fixture.shell.setState("language", {
        text: "New language work", tone: remaining === "dirty" ? "dirty" : "muted",
        disabled: remaining === "busy", busy: remaining === "busy",
      });
      window.fixture.pending.advanced.resolve();
    }, remaining);
    await expect.poll(() => page.evaluate(() => window.fixture.completedSaves.length)).toBe(2);
    await expect(page.locator("#settings-save-status")).toContainText("New language work");
    expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
  });
}

test("an unchanged disabled validation error does not block another member's afterSave", async ({ page }) => {
  await openDeferredSaveGroup(page);
  await page.evaluate(() => window.fixture.shell.setState("advanced", {
    text: "Configure a model first", tone: "error", disabled: true,
  }));
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => window.fixture.pending.language.resolve());
  await expect.poll(() => page.evaluate(() => window.fixture.afterSaves.map(({ id }) => id))).toEqual(["language", "advanced"]);
  expect(await page.evaluate(() => window.fixture.calls)).toEqual(["language"]);
});

test("a new disabled validation error suppresses afterSave even when that member was not saved", async ({ page }) => {
  await openDeferredSaveGroup(page);
  await page.evaluate(() => window.fixture.shell.setState("advanced", {
    text: "Advanced saved", tone: "saved", disabled: true,
  }));
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => {
    window.fixture.shell.setState("advanced", { text: "New invalid draft", tone: "error", disabled: true });
    window.fixture.pending.language.resolve();
  });
  await expect.poll(() => page.evaluate(() => window.fixture.completedSaves.length)).toBe(1);
  expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([]);
});

test("an afterSave callback that closes settings prevents later stale callbacks", async ({ page }) => {
  await openDeferredSaveGroup(page);
  await page.evaluate(() => {
    window.fixture.sections.find(section => section.id === "language").afterSave = () => {
      window.fixture.afterSaves.push({ id: "language" });
      window.fixture.shell.close();
    };
  });
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => { window.fixture.pending.language.resolve(); window.fixture.pending.advanced.resolve(); });
  await expect(page.locator("#settings-panel")).toBeHidden();
  expect(await page.evaluate(() => window.fixture.afterSaves)).toEqual([{ id: "language" }]);
});

test("removing one grouped contribution cancels only its work and leaves its sibling save usable", async ({ page }) => {
  await page.evaluate(() => {
    const tab = { id: "preferences", title: "Preferences" };
    window.fixture.pending = {};
    window.fixture.activations = [];
    for (const id of ["language", "advanced"]) {
      const section = window.fixture.add(id, {
        tab,
        order: id === "language" ? 10 : 20,
        activate({ signal }) { window.fixture.activations.push({ id, signal }); },
        deactivate() { window.fixture.calls.push(`${id} closed`); },
        save({ signal }) {
          window.fixture.calls.push(`${id} saved`);
          return new Promise((resolve, reject) => { window.fixture.pending[id] = { signal, resolve, reject }; });
        },
      });
      section.element.dataset.contribution = id;
    }
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => {
    window.fixture.sections.splice(0, 1);
    window.fixture.changed();
    window.fixture.pending.language.reject(new Error("Removed language failure"));
  });
  expect(await page.evaluate(() => window.fixture.activations.map(({ id, signal }) => [id, signal.aborted]))).toEqual([["language", true], ["advanced", false]]);
  await expect(page.locator('[data-contribution="language"]')).toHaveCount(0);
  await expect(page.locator('[role="tab"]:visible')).toHaveText(["Preferences"]);
  await expect(page.locator('[role="tabpanel"]:visible [data-contribution="advanced"]')).toBeVisible();
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await page.evaluate(() => window.fixture.pending.advanced.resolve());
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await expect(page.locator("#settings-save-status")).not.toContainText("Removed language failure");
  await page.locator("#btn-save-settings").click();
  await page.evaluate(() => window.fixture.pending.advanced.resolve());
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  expect(await page.evaluate(() => window.fixture.calls)).toEqual(["language saved", "advanced saved", "language closed", "advanced saved"]);
  expect(await page.evaluate(() => window.fixture.errors)).toEqual([]);
});

test("closing a grouped tab cancels every member and ignores their late save results after reopening", async ({ page }) => {
  await page.evaluate(() => {
    const tab = { id: "preferences", title: "Preferences" };
    window.fixture.pending = [];
    for (const id of ["language", "advanced"]) {
      window.fixture.add(id, { tab, order: id === "language" ? 10 : 20, save({ signal }) {
        return new Promise((resolve, reject) => window.fixture.pending.push({ id, signal, resolve, reject }));
      } });
    }
  });
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  await page.locator("#btn-close-settings").click();
  await page.locator("#btn-settings").click();
  await page.locator("#btn-save-settings").click();
  expect(await page.evaluate(() => window.fixture.pending.map(({ signal }) => signal.aborted))).toEqual([true, true, false, false]);
  await page.evaluate(() => {
    window.fixture.pending[0].reject(new Error("Old language failure"));
    window.fixture.pending[1].resolve();
  });
  await expect(page.locator("#btn-save-settings")).toBeDisabled();
  await expect(page.locator("#settings-save-status")).not.toContainText("Old language failure");
  await page.evaluate(() => { window.fixture.pending[2].resolve(); window.fixture.pending[3].resolve(); });
  await expect(page.locator("#btn-save-settings")).toBeEnabled();
  await expect(page.locator("#settings-save-status")).toHaveText("已保存");
  expect(await page.evaluate(() => window.fixture.errors)).toEqual([]);
});

test("the built-in settings package mounts, disposes and remounts through the same public UI contract", async ({ page }) => {
  await page.evaluate(async () => {
    const { default: capability } = await import("/extension/capabilities/settings/ui.js");
    const { createSidepanelUiRuntime } = await import("/extension/sidepanel/capability-host/runtime.js");
    const { createWorkspaceExtensions } = await import("/extension/sidepanel/features/app/workspace-extensions.js");
    const { createProductSettings } = await import("/extension/sidepanel/product/settings.js");
    document.body.insertAdjacentHTML("beforeend", '<main id="messages"><div id="welcome"></div></main><textarea id="input"></textarea><div data-ui-slot="composer-notices"></div><div data-ui-slot="composer-meta"></div>');
    const { shell, calls } = window.fixture;
    const runtime = createSidepanelUiRuntime({ host: {
      root: document, settings: shell.port, extensions: createWorkspaceExtensions(),
      providers: { createSettings: createProductSettings },
      request: async () => ({}), send: message => calls.push(message.type),
      getRunContext: () => ({}), getCurrentSessionId: () => null, navigate: () => true,
      showToast() {}, setDebugMode() {}, dialogs: { confirm: async () => false },
      chat: { messages: document.querySelector("#messages"), input: document.querySelector("#input"),
        welcomeHTML: '<div id="welcome"></div>', setInput() {}, showWelcome() {}, focus() {} },
    } });
    shell.connect(runtime);
    await runtime.mountAll([{ id: "settings", setup: capability }]);
    Object.assign(window.fixture, { runtime, capability });
  });
  await page.locator("#btn-settings").click();
  await expect(page.locator("#cfg-provider-trigger")).toBeVisible();
  await expect(page.locator('[role="tab"]:visible')).toHaveCount(2);
  await page.evaluate(async () => { window.fixture.shell.close(); await window.fixture.runtime.unmount("settings"); });
  await expect(page.locator("#cfg-provider")).toHaveCount(0);
  await expect(page.locator("#model-preset-switcher")).toHaveCount(0);
  await expect(page.locator("#gpt-connect-hint")).toHaveCount(0);
  await page.evaluate(() => window.fixture.runtime.mountAll([{ id: "settings", setup: window.fixture.capability }]));
  await page.locator("#btn-settings").click();
  await expect(page.locator("#cfg-provider-trigger")).toBeVisible();
  await expect(page.locator("#cfg-provider")).toHaveCount(1);
  expect(await page.evaluate(() => window.fixture.calls.filter(type => type === "get_config"))).toHaveLength(2);
});
