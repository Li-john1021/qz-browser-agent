import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_ROOT = resolve(PROJECT_ROOT, "src");
const localSourceCache = new Map();
const localScriptCache = new Map();

export function createBrowserV8CoverageCollector({
  coverageDir = process.env.NODE_V8_COVERAGE || "",
  workerIndex = 0,
  extensionDir = process.env.QINGZHOU_TEST_EXTENSION_DIR || resolve(PROJECT_ROOT, "dist/extension"),
} = {}) {
  const scripts = new Map();
  const enabled = Boolean(coverageDir);

  return {
    enabled,
    merge(entries = []) {
      if (!enabled) return;
      for (const entry of entries) mergeEntry(scripts, entry, extensionDir);
    },
    async flush() {
      if (!enabled || !scripts.size) return;
      mkdirSync(coverageDir, { recursive: true });
      const sourceMaps = {};
      const result = [...scripts.values()].map(({ functionKeys: _functionKeys, sourceMap, ...entry }) => {
        if (sourceMap) sourceMaps[entry.url] = sourceMap;
        return entry;
      });
      const file = resolve(
        coverageDir,
        `coverage-browser-${process.pid}-${workerIndex}-${Date.now()}.json`,
      );
      await writeFile(file, JSON.stringify({ result, "source-map-cache": sourceMaps, timestamp: Date.now() }), "utf8");
    },
  };
}

export async function collectPageV8Coverage(page, collector, use) {
  if (!collector.enabled) {
    await use();
    return;
  }

  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
  try {
    await use();
  } finally {
    const entries = await page.coverage.stopJSCoverage().catch(() => []);
    collector.merge(entries);
  }
}

function mergeEntry(scripts, entry, extensionDir) {
  const local = localExtensionScript(entry?.url, entry?.source, extensionDir);
  if (!local || !Array.isArray(entry.functions)) return;
  const { url, sourceMap } = local;

  let script = scripts.get(url);
  if (!script) {
    script = {
      scriptId: String(scripts.size + 1),
      url,
      functions: [],
      functionKeys: new Map(),
      sourceMap,
    };
    scripts.set(url, script);
  }

  for (const candidate of entry.functions) {
    const ranges = Array.isArray(candidate.ranges) ? candidate.ranges : [];
    if (!ranges.length) continue;
    const key = JSON.stringify([
      candidate.functionName || "",
      Boolean(candidate.isBlockCoverage),
      ranges.map(range => [range.startOffset, range.endOffset]),
    ]);
    const existing = script.functionKeys.get(key);
    if (existing) {
      existing.ranges.forEach((range, index) => {
        range.count += Number(ranges[index]?.count || 0);
      });
      continue;
    }
    const value = {
      functionName: candidate.functionName || "",
      isBlockCoverage: Boolean(candidate.isBlockCoverage),
      ranges: ranges.map(range => ({
        startOffset: Number(range.startOffset),
        endOffset: Number(range.endOffset),
        count: Number(range.count || 0),
      })),
    };
    script.functions.push(value);
    script.functionKeys.set(key, value);
  }
}

function localExtensionScript(value, source, extensionDir) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const relativePath = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    if (!relativePath.startsWith("extension/") || !relativePath.endsWith(".js")) return "";
    if (/^extension\/(?:vendor|deps)\//.test(relativePath)) return "";
    const root = resolve(extensionDir);
    const file = resolve(root, relativePath.slice("extension/".length));
    if (!file.startsWith(`${root}${sep}`)) return null;
    if (!existsSync(file)) return "";
    if (typeof source !== "string" || source !== localSource(file)) return "";
    // The runner's compiled build is immutable; validate bytes before reusing its map.
    if (localScriptCache.has(file)) return localScriptCache.get(file);
    const original = resolve(SOURCE_ROOT, relativePath.slice("extension/".length));
    // Unchanged JS shares the source URL, so Node and browser ranges still merge.
    if (existsSync(original) && source === localSource(original)) return { url: pathToFileURL(original).href };
    const mapPath = `${file}.map`;
    if (!existsSync(mapPath)) return null;
    const data = JSON.parse(readFileSync(mapPath, "utf8"));
    const sources = data.sources.map(name => new URL(name, pathToFileURL(mapPath)).href);
    const paths = sources.map(name => fileURLToPath(name));
    // Classic entry maps include their npm inputs; c8 filters these after remapping.
    if (!paths.some(path => path.startsWith(`${SOURCE_ROOT}${sep}`))
      || paths.some(path => !path.startsWith(`${SOURCE_ROOT}${sep}`) && !path.startsWith(`${PROJECT_ROOT}${sep}node_modules${sep}`))) return null;
    const script = {
      url: pathToFileURL(file).href,
      sourceMap: { data: { ...data, sources }, lineLengths: source.split("\n").map(line => line.length) },
    };
    localScriptCache.set(file, script);
    return script;
  } catch (_error) {
    return "";
  }
}

function localSource(file) {
  if (!localSourceCache.has(file)) localSourceCache.set(file, readFileSync(file, "utf8"));
  return localSourceCache.get(file);
}
