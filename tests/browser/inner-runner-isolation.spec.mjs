import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "./fixtures.mjs";
import { ensureTestExtension } from "../support/extension-build.mjs";

test("inner scripts run in an opaque Worker without extension or storage access", async () => {
  const extension = await ensureTestExtension();
  const profile = await mkdtemp(join(tmpdir(), "qz-inner-isolation-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: chromium.executablePath(),
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(new URL("/offscreen.html", worker.url()).href);
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const frame = document.createElement("iframe");
      frame.src = "runner-sandbox.html";
      const timer = setTimeout(() => finish(new Error("sandbox response timed out")), 10_000);
      function finish(error, result) {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        frame.remove();
        if (error) reject(error);
        else resolve(result);
      }
      function receive(event) {
        if (event.source !== frame.contentWindow || event.data?.source !== "qz-inner-runner-sandbox") return;
        if (event.data.type === "ready") {
          frame.contentWindow.postMessage({
            source: "qz-inner-runner-host", type: "execute", requestId: "isolation",
            scriptSource: `
              let storageError = "";
              try { indexedDB.open("extension-private"); } catch (error) { storageError = error.name; }
              return { origin: self.origin, extensionAccess: Boolean(globalThis.chrome?.runtime),
                documentAccess: typeof document, storageError, value: 6 * 7 };
            `,
          }, "*");
        } else if (event.data.type === "result") finish(null, event.data.result);
      }
      window.addEventListener("message", receive);
      document.body.append(frame);
    }));
    expect(result.ok, result.error).toBe(true);
    expect(result.result).toEqual({
      origin: "null", extensionAccess: false, documentAccess: "undefined", storageError: "SecurityError", value: 42,
    });
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
