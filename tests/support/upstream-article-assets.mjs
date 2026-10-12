import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
let assets;

/** Independent upstream comparators; these browser globals are never part of the extension build. */
export function prepareUpstreamArticleAssets() {
  return assets ||= (async () => {
    const directory = mkdtempSync(join(tmpdir(), "qingzhou-upstream-article-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const sources = {
      readability: 'import { Readability } from "@mozilla/readability"; globalThis.Readability = Readability;',
      turndown: 'import TurndownService from "turndown"; globalThis.TurndownService = TurndownService;',
      gfm: 'import * as gfm from "turndown-plugin-gfm"; globalThis.turndownPluginGfm = gfm;',
      marked: 'import { marked } from "marked"; globalThis.marked = marked;',
    };
    return Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, contents]) => {
      const outfile = join(directory, `${name}.js`);
      await build({ absWorkingDir: root, stdin: { contents, resolveDir: root }, outfile, bundle: true, format: "iife", target: "es2022" });
      return [name, outfile];
    })));
  })();
}
