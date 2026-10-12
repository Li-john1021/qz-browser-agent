import { chromium } from "playwright";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./fixtures.mjs";
import { buildExtension } from "../../scripts/build-extension.mjs";

test("an independently discovered capability replaces a tool in the real MV3 host", async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), "qingzhou-tool-replacement-"));
  let browser;
  try {
    const sourceDir = join(directory, "src");
    await cp("src", sourceDir, { recursive: true });
    // Sort before tabs deliberately; no host or existing capability source is edited.
    const capability = join(sourceDir, "capabilities/aaa-replacement");
    await mkdir(capability);
    await writeFile(join(capability, "index.ts"), 'export { default as tools } from "./tools.js";\n');
    await writeFile(join(capability, "tools.ts"), `import type { ToolExtension } from "#sdk/background";
      export default (qz => qz.registerTool({
        name: "list_tabs", replaces: "tabs/list_tabs", description: "Replacement tab discovery",
        parameters: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
        execute: ({ marker }) => ({ marker, tabs: [], count: 0 }),
      })) satisfies ToolExtension;`);
    const { outputDir } = await buildExtension({ sourceDir, outputDir: join(directory, "extension"), mode: "development" });
    // MV3 forbids dynamic import in workers. A test-only entry exposes the real host module
    // via static imports; all compiled production modules remain byte-for-byte unchanged.
    const manifestPath = join(outputDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(join(outputDir, "replacement-test-worker.js"),
      `import "./${manifest.background.service_worker}";
       import * as tools from "./background/tools/runtime.js";
       globalThis.replacementTestTools = tools;`);
    manifest.background.service_worker = "replacement-test-worker.js";
    await writeFile(manifestPath, JSON.stringify(manifest));
    browser = await chromium.launchPersistentContext(join(directory, "profile"), {
      headless: true, executablePath: chromium.executablePath(), ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${outputDir}`, `--load-extension=${outputDir}`,
        "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    // The real worker imports the same generated catalog used by its Agent runtime.
    const observed = await worker.evaluate(async () => {
      const tools = globalThis.replacementTestTools;
      const runtime = tools.createToolRuntime();
      const context = { sessionId: "replacement-test", runId: "replacement-run" };
      let invalid;
      try { await runtime.execute("list_tabs", {}, undefined, context); }
      catch (error) { invalid = error.code; }
      return {
        schemas: tools.getToolSchemas().filter(tool => tool.function.name === "list_tabs"), invalid,
        result: await runtime.execute("list_tabs", { marker: "custom implementation" }, undefined, context),
      };
    });
    expect(observed.schemas).toHaveLength(1);
    expect(observed.schemas[0].function.description).toBe("Replacement tab discovery");
    expect(observed.schemas[0].function.parameters.required).toEqual(["marker"]);
    expect(observed.invalid).toBe("MISSING_REQUIRED_ARGUMENTS");
    expect(observed.result).toMatchObject({ marker: "custom implementation", tabs: [], count: 0 });
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
