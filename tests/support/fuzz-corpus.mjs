import { readFileSync } from "node:fs";
import { extname, resolve, basename } from "node:path";
import { parseExportHtmlFixture } from "../benchmarks/conversation-render/tools/export-html-fixture.mjs";

/** Private exports are opt-in data; never execute the scripts embedded in HTML. */
export function loadFuzzCorpus(root, manifest, defaults) {
  const paths = manifest ? JSON.parse(readFileSync(resolve(root, manifest), "utf8")) : defaults;
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !path.trim())) {
    throw new Error("Fuzz corpus must be a non-empty JSON array of fixture paths");
  }
  return paths.map(path => {
    const source = readFileSync(resolve(root, path), "utf8");
    const value = /\.html?$/i.test(extname(path)) ? parseExportHtmlFixture(source) : JSON.parse(source);
    const transcript = value.transcript || value.conversation?.entries;
    if (!Array.isArray(transcript) || !transcript.some(entry => entry?.type === "tool")) {
      throw new Error(`Fuzz fixture has no tool entries: ${path}`);
    }
    return { name: value.name || basename(path), path, transcript };
  });
}
