import { chromium } from "playwright";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

for (const watchNetwork of [false, true]) test(`tab navigation commits before reading (watchNetwork=${watchNetwork})`, async () => {
  test.setTimeout(60_000);
  const held = new Map(), counts = new Map();
  const server = createServer((req, res) => {
    const path = req.url;
    counts.set(path, (counts.get(path) || 0) + 1);
    if (path === "/redirect") { res.writeHead(302, { Location: `http://localhost:${server.address().port}/landed` }); res.end(); return; }
    if (path === "/fail") { req.socket.destroy(); return; }
    if (path.startsWith("/busy-open-")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<title>Busy renderer</title><script>fetch('/started${path}');const until=Date.now()+8000;while(Date.now()<until){}</script>`);
      return;
    }
    const finish = () => {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(`<title>Navigation fixture</title><article>Document ${path} generation ${counts.get(path)}</article>`);
    };
    if (held.has(path)) held.get(path).push({ res, finish });
    else if (path === "/stream") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write('<!doctype html><title>Streaming</title><article>New document</article><img src="/image">');
      res.end();
    } else finish();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-navigation-"));
  let browser;
  try {
    const extension = join(directory, "extension");
    await cp(await ensureTestExtension(), extension, { recursive: true });
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(manifest.permissions).not.toContain("webNavigation");
    await writeFile(join(extension, "navigation-test-worker.js"), `import "./${manifest.background.service_worker}";
      import { createToolRuntime } from "./background/tools/runtime.js";
      globalThis.navigationTestRuntime = createToolRuntime;`);
    manifest.background.service_worker = "navigation-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
        "--no-proxy-server", "--host-resolver-rules=MAP localhost 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    await worker.evaluate(() => {
      const owned = new Set();
      globalThis.navigationAttachCount = 0;
      const attach = chrome.debugger.attach.bind(chrome.debugger);
      chrome.debugger.attach = (...args) => { navigationAttachCount++; return attach(...args); };
      const runtime = navigationTestRuntime({
        windowTarget: { resolveForNewTab: async () => (await chrome.windows.getAll())[0].id },
        sessions: {
          isRunCurrent: () => true,
          resolveTargetTab: async ({ tabId }) => owned.has(tabId)
            ? { ok: true, tabId, tab: await chrome.tabs.get(tabId), ownedByCurrentTask: true }
            : { ok: false, code: "SESSION_TAB_FOREIGN" },
          updateWorkingTab: async ({ tab }) => { owned.add(tab.id); },
        },
      });
      globalThis.navigationCall = async (name, args) => {
        globalThis.navigationAbort = new AbortController();
        try { return await runtime.execute(name, args, navigationAbort.signal, { sessionId: "navigation", runId: "run" }); }
        catch (error) { return { code: error.code, error: error.message }; }
      };
    });
    const call = (name, args) => worker.evaluate(({ name, args }) => navigationCall(name, args), { name, args });
    const release = path => { for (const entry of held.get(path) || []) entry.finish(); held.delete(path); };
    const slow = async (name, args, path) => {
      held.set(path, []);
      let done = false;
      const pending = call(name, { ...args, watchNetwork }).then(result => { done = true; return result; });
      await expect.poll(() => held.get(path).length).toBeGreaterThan(0);
      expect(done, `${name} must wait while response headers are held: ${done ? JSON.stringify(await pending) : "pending"}`).toBe(false);
      release(path);
      const result = await pending;
      expect(result, JSON.stringify(result)).not.toHaveProperty("error");
      return result;
    };
    const opened = await slow("open_tab", { url: `${origin}/article` }, "/article");
    const tabId = opened.id;
    const article = () => call("read_article", { tabId, limit: 1200 });
    expect((await article()).text).toContain("Document /article generation 1");
    if (!watchNetwork) {
      expect(await worker.evaluate(() => navigationAttachCount), "ordinary navigation must not attach a debugger just to wait").toBe(0);
    } else expect(JSON.stringify(await call("network_recent", { tabId }))).toContain("/article");
    await slow("navigate", { tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 1");
    await slow("navigate", { tabId, url: `${origin}/next` }, "/next");
    expect((await article()).text).toContain("Document /next generation 2");
    const redirected = await slow("navigate", { tabId, url: `${origin}/redirect` }, "/landed");
    expect(redirected._pageUrl).toBe(`http://localhost:${server.address().port}/landed`);
    expect((await article()).text).toContain("Document /landed generation 1");
    for (let i = 0; i < 2; i++) {
      const fragment = await call("navigate", { tabId, url: `${redirected._pageUrl}#section`, timeout: 2 });
      expect(fragment, `fragment attempt ${i}: ${JSON.stringify(fragment)}`).not.toHaveProperty("error");
      expect(fragment._pageUrl).toBe(`${redirected._pageUrl}#section`);
    }

    // A held image must not prevent the navigation tool from returning at commit.
    held.set("/image", []);
    expect(await call("navigate", { tabId, url: `${origin}/stream` })).not.toHaveProperty("error");
    expect((await worker.evaluate(tabId => chrome.tabs.get(tabId), tabId)).status).toBe("loading");
    await expect.poll(() => held.get("/image").length).toBeGreaterThan(0);
    release("/image");

    expect((await call("navigate", { tabId, url: `${origin}/fail` })).code).toBe("NAVIGATION_FAILED");
    expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: { blockedDomains: ["localhost"] } }));
    expect((await call("navigate", { tabId, url: `${origin}/redirect` })).code).toBe("SECURITY_GUARDRAIL_BLOCKED");
    await worker.evaluate(() => chrome.storage.local.set({ securityGuardrails: {} }));
    expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    for (const outcome of ["cancel", "timeout", "close"]) {
      const path = `/${outcome}`;
      held.set(path, []);
      const pending = call("navigate", { tabId, url: `${origin}${path}`, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => held.get(path).length).toBeGreaterThan(0);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      if (outcome === "close") await worker.evaluate(tabId => chrome.tabs.remove(tabId), tabId);
      expect((await pending).code).toBe({ cancel: "OPERATION_ABORTED", timeout: "TOOL_TIMEOUT", close: "SESSION_TAB_UNAVAILABLE" }[outcome]);
      release(path);
      if (outcome !== "close") expect(await call("navigate", { tabId, url: `${origin}/recovered` })).not.toHaveProperty("error");
    }
    const before = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
    held.set("/open-timeout", []);
    expect((await call("open_tab", { url: `${origin}/open-timeout`, watchNetwork, timeout: 1 })).code).toBe("TOOL_TIMEOUT");
    await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({})).length)).toBe(before);
    release("/open-timeout");

    // A pending Chrome script cannot hold open_tab cleanup hostage after timeout/stop.
    for (const outcome of ["timeout", "cancel"]) {
      const path = `/busy-open-${outcome}`;
      const pending = call("open_tab", { url: `${origin}${path}`, watchNetwork, timeout: outcome === "timeout" ? 1 : 5 });
      await expect.poll(() => counts.get(`/started${path}`) || 0).toBe(1);
      if (outcome === "cancel") await worker.evaluate(() => navigationAbort.abort());
      expect((await pending).code).toBe(outcome === "timeout" ? "TOOL_TIMEOUT" : "OPERATION_ABORTED");
      await expect.poll(() => worker.evaluate(async () => (await chrome.tabs.query({})).length), { timeout: 1500 }).toBe(before);
    }

    const busyTab = await call("open_tab", { url: `${origin}/old-busy`, watchNetwork });
    expect(busyTab).not.toHaveProperty("error");
    for (let generation = 1; generation <= 2; generation++) {
      await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, func: () => {
        setTimeout(() => { fetch("/old-busy-start"); const until = Date.now() + 4000; while (Date.now() < until) {} }, 300);
      } }), busyTab.id);
      await expect.poll(() => counts.get("/old-busy-start") || 0).toBe(generation);
      held.set("/busy-target", []);
      const pending = call("navigate", { tabId: busyTab.id, url: `${origin}/busy-target`, timeout: 10 });
      // The request must start while the old renderer is still busy, including same-URL reload.
      await expect.poll(() => held.get("/busy-target").length, { timeout: 1500 }).toBeGreaterThan(0);
      release("/busy-target");
      expect(await pending).not.toHaveProperty("error");
      expect((await call("read_article", { tabId: busyTab.id, limit: 1200 })).text).toContain(`Document /busy-target generation ${generation}`);
    }
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
