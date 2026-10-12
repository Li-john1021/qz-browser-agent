import { expect, test } from "./fixtures.mjs";

test.beforeEach(async ({ page }) => {
  await page.goto("/__test_health");
  await page.clock.install();
  await page.addStyleTag({ url: "/extension/sidepanel/sidepanel.css" });
  await page.evaluate(async () => {
    const { createMessageActions } = await import("/extension/sidepanel/features/chat/transcript/message-actions.js");
    document.body.innerHTML = '<div id="messages"><div class="msg msg-assistant" data-transcript-key="answer"><div class="msg-content"><div class="copyable-code-block" data-copy-text="const x = 1;\n"><button class="code-copy-btn" title="复制代码">复制</button><pre><code>fallback code</code></pre></div></div></div></div>';
    const root = document.querySelector("#messages");
    const el = root.firstElementChild;
    el.dataset.finalContent = "# 答案\n\n正文  \n";
    const state = { copies: [], downloads: [], feedback: [], revoked: [], fallback: [], fallbackOk: true };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: text => new Promise((resolve, reject) => state.copies.push({ text, resolve, reject })),
    } });
    document.execCommand = () => { state.fallback.push(document.querySelector("textarea").value); return state.fallbackOk; };
    window.chrome ||= {};
    window.chrome.downloads = { download: options => new Promise((resolve, reject) => state.downloads.push({ options, resolve, reject })) };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { state.revoked.push(url); revoke(url); };
    const actions = createMessageActions({ root, downloadFilename: () => "任务-2026-09-19.md",
      onCopy: (message, kind, text) => state.feedback.push({ message: message.dataset.transcriptKey, kind, text }),
    });
    root.addEventListener("click", actions.handleCodeBlockCopyClick);
    actions.sync(el, true);
    window.actionsFixture = { root, el, actions, state };
  });
});

test("copy reads the latest final Markdown and reports whole-answer feedback only after success", async ({ page }) => {
  const copy = page.locator('[data-action="copy-markdown"]');
  await page.evaluate(() => {
    const { el, actions } = window.actionsFixture;
    el.dataset.finalContent = "updated **answer**  \n";
    window.originalToolbar = el.querySelector(".msg-actions"); actions.sync(el, true);
  });
  expect(await page.evaluate(() => window.originalToolbar === window.actionsFixture.el.querySelector(".msg-actions"))).toBe(true);
  await copy.click();
  expect(await page.evaluate(() => window.actionsFixture.state.copies[0].text)).toBe("updated **answer**");
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([]);
  await page.evaluate(() => window.actionsFixture.state.copies[0].resolve());
  await expect(copy).toHaveAttribute("title", "已复制");
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([{ message: "answer", kind: "full", text: undefined }]);
  await page.clock.runFor(1400);
  await expect(copy).toHaveAttribute("title", "复制 Markdown");
});

for (const success of [true, false]) {
  test(`clipboard rejection uses fallback with success=${success}`, async ({ page }) => {
    await page.evaluate(success => { window.actionsFixture.state.fallbackOk = success; }, success);
    await page.locator('[data-action="copy-markdown"]').click();
    await page.evaluate(() => window.actionsFixture.state.copies[0].reject(new Error("clipboard blocked")));
    await expect(page.locator('[data-action="copy-markdown"]')).toHaveAttribute("title", success ? "已复制" : "复制失败");
    expect(await page.evaluate(() => window.actionsFixture.state.fallback)).toEqual(["# 答案\n\n正文"]);
    expect(await page.evaluate(() => window.actionsFixture.state.feedback.length)).toBe(success ? 1 : 0);
    await expect(page.locator("textarea")).toHaveCount(0);
  });
}

for (const cleanup of ["dispose", "reset", "hideAll", "removed", "replace-content"]) {
  test(`${cleanup} revokes late clipboard results and toolbar handlers`, async ({ page }) => {
    await page.locator('[data-action="copy-markdown"]').click();
    const result = await page.evaluate(async cleanup => {
      const { el, actions, state } = window.actionsFixture;
      const button = el.querySelector('[data-action="copy-markdown"]');
      if (cleanup === "dispose") actions.dispose(el);
      if (cleanup === "reset") actions.reset();
      if (cleanup === "hideAll") actions.hideAll();
      if (cleanup === "removed") el.remove();
      if (cleanup === "replace-content") el.dataset.finalContent = "new answer";
      const before = el.innerHTML;
      state.copies[0].reject(new Error("late rejection"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      if (cleanup !== "replace-content") button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return { unchanged: el.innerHTML === before, copied: state.copies.length, feedback: state.feedback, fallback: state.fallback };
    }, cleanup);
    expect(result).toEqual({ unchanged: true, copied: 1, feedback: [], fallback: [] });
  });
}

for (const success of [true, false]) {
  test(`Markdown download preserves bytes and releases the URL after success=${success}`, async ({ page }) => {
    await page.locator('[data-action="download-markdown"]').click();
    const result = await page.evaluate(async () => {
      const { state } = window.actionsFixture;
      const { url, ...options } = state.downloads[0].options;
      const response = await fetch(url);
      return { options, type: response.headers.get("content-type"), text: await response.text() };
    });
    expect(result).toEqual({ options: { filename: "任务-2026-09-19.md", saveAs: true }, type: "text/markdown;charset=utf-8", text: "# 答案\n\n正文" });
    await page.evaluate(success => {
      const call = window.actionsFixture.state.downloads[0];
      if (success) call.resolve(1); else call.reject(new Error("cancelled"));
    }, success);
    await expect(page.locator('[data-action="download-markdown"]')).toHaveAttribute("title", success ? "已下载" : "下载失败");
    await page.clock.runFor(5000);
    expect(await page.evaluate(() => {
      const { state } = window.actionsFixture; return state.revoked;
    })).toHaveLength(1);
  });
}

test("a retired download still releases its resource without touching a new toolbar", async ({ page }) => {
  await page.locator('[data-action="download-markdown"]').click();
  await page.evaluate(async () => {
    const { el, actions, state } = window.actionsFixture;
    actions.sync(el, false); actions.sync(el, true);
    state.downloads[0].resolve(1);
  });
  await expect(page.locator('[data-action="download-markdown"]')).toHaveAttribute("title", "下载当前消息");
  await page.clock.runFor(5000);
  expect(await page.evaluate(() => window.actionsFixture.state.revoked.length)).toBe(1);
});

test("code copy uses the exact payload and reports partial feedback with its own animation", async ({ page }) => {
  await page.locator(".code-copy-btn").click();
  expect(await page.evaluate(() => window.actionsFixture.state.copies[0].text)).toBe("const x = 1;\n");
  await page.evaluate(() => window.actionsFixture.state.copies[0].resolve());
  await expect(page.locator(".copyable-code-block")).toHaveClass(/copy-confirmed/);
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([{ message: "answer", kind: "selection", text: "const x = 1;\n" }]);
  await page.clock.runFor(760);
  await expect(page.locator(".copyable-code-block")).not.toHaveClass(/copy-confirmed/);
});

test("code copy late success is revoked by row disposal", async ({ page }) => {
  await page.locator(".code-copy-btn").click();
  await page.evaluate(() => {
    const { actions, el, state } = window.actionsFixture;
    actions.dispose(el); state.copies[0].resolve();
  });
  await expect(page.locator(".copyable-code-block")).not.toHaveClass(/copy-confirmed/);
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([]);
});

test("empty answers hide the toolbar and generic action flashes restore on reset", async ({ page }) => {
  const result = await page.evaluate(() => {
    const { el, actions } = window.actionsFixture;
    el.dataset.finalContent = ""; el.dataset.content = "";
    const visible = actions.sync(el, true);
    const external = document.createElement("button"); external.title = "导出会话"; document.body.append(external);
    actions.flash(external, "已导出"); actions.flash(external, "已导出"); actions.reset();
    actions.flash(null, "nothing");
    return { visible, toolbars: el.querySelectorAll(".msg-actions").length, title: external.title, className: external.className };
  });
  expect(result).toEqual({ visible: false, toolbars: 0, title: "导出会话", className: "" });
});


test("reset followed by reconcile rebinds retained message DOM exactly once", async ({ page }) => {
  await page.evaluate(() => {
    const { el, actions } = window.actionsFixture;
    actions.reset(); actions.sync(el, true); actions.sync(el, true);
  });
  await page.locator('[data-action="copy-markdown"]').click();
  expect(await page.evaluate(() => window.actionsFixture.state.copies.length)).toBe(1);
  await page.evaluate(() => window.actionsFixture.state.copies[0].resolve());
  await expect(page.locator('[data-action="copy-markdown"]')).toHaveAttribute("title", "已复制");
});

test("code changed during clipboard I/O does not receive feedback for the old payload", async ({ page }) => {
  await page.locator(".code-copy-btn").click();
  await page.evaluate(() => {
    const { el, state } = window.actionsFixture;
    el.querySelector(".copyable-code-block").dataset.copyText = "new code";
    state.copies[0].resolve();
  });
  await expect(page.locator(".copyable-code-block")).not.toHaveClass(/copy-confirmed/);
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([]);
});

test("code content fallback and failed or empty copying keep feedback honest", async ({ page }) => {
  await page.evaluate(() => { delete window.actionsFixture.el.querySelector(".copyable-code-block").dataset.copyText; });
  await page.locator(".code-copy-btn").click();
  expect(await page.evaluate(() => window.actionsFixture.state.copies[0].text)).toBe("fallback code");
  await page.evaluate(() => {
    const { state } = window.actionsFixture; state.fallbackOk = false; state.copies[0].reject(new Error("denied"));
  });
  await expect(page.locator(".code-copy-btn")).toHaveAttribute("title", "复制失败");
  await page.evaluate(() => { window.actionsFixture.el.querySelector("pre").textContent = ""; });
  await page.locator(".code-copy-btn").click();
  await expect(page.locator(".code-copy-btn")).toHaveAttribute("title", "无内容");
  expect(await page.evaluate(() => window.actionsFixture.state.feedback)).toEqual([]);
});


test("an answer cleared before reconcile never copies empty text", async ({ page }) => {
  await page.evaluate(() => { window.actionsFixture.el.dataset.finalContent = ""; });
  await page.locator('[data-action="copy-markdown"]').click();
  await expect(page.locator('[data-action="copy-markdown"]')).toHaveAttribute("title", "无内容");
  expect(await page.evaluate(() => window.actionsFixture.state.copies)).toEqual([]);
});


test("code copy between reset and reconcile cannot revive an aborted toolbar", async ({ page }) => {
  await page.evaluate(() => { window.actionsFixture.actions.reset(); });
  await page.locator(".code-copy-btn").click();
  await page.evaluate(() => {
    const { actions, el, state } = window.actionsFixture;
    state.copies[0].resolve(); actions.sync(el, true);
  });
  await page.locator('[data-action="copy-markdown"]').click();
  expect(await page.evaluate(() => window.actionsFixture.state.copies.length)).toBe(2);
  await page.evaluate(() => window.actionsFixture.state.copies[1].resolve());
  await expect(page.locator('[data-action="copy-markdown"]')).toHaveAttribute("title", "已复制");
});
