#!/usr/bin/env node

import { build, formatMessages, version as esbuildVersion } from "esbuild";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeSourceMapPath, originalSourceMapPath, refreshDependencyProvenance } from "./vendor/assets.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSION_DIR = resolve(REPO_ROOT, "src");
const ENTRY_POINTS = Object.freeze([
  Object.freeze({ name: "background", path: "background/service-worker.js" }),
  Object.freeze({ name: "sidepanel", path: "sidepanel/sidepanel.js" }),
]);
const PANEL_CHUNK = /^chunk-[\w.-]+\.js(?:\.map)?$/u;

export async function bundleExtension({ extensionDir, metafilePath = "", allowSource = false, preservedInputs, debugMaps = false } = {}) {
  if (!extensionDir) throw new Error("extensionDir is required");
  const root = await realpath(resolve(String(extensionDir)));
  const sourceRoot = await realpath(SOURCE_EXTENSION_DIR);
  if (!allowSource && root === sourceRoot) {
    throw new Error("refusing to bundle the source extension in place; use a staging copy");
  }

  await validateExtensionRoot(root);
  preservedInputs ??= await readRuntimeModuleGraph(root, "offscreen.js");
  const builds = [];
  for (const entry of ENTRY_POINTS) {
    builds.push(await buildEntry(root, entry, debugMaps));
  }

  const capturedInputs = new Set();
  const outputs = builds.flatMap(item => item.outputs);
  for (const item of builds) {
    for (const input of item.inputs) capturedInputs.add(input);
  }

  const entryPaths = new Set(ENTRY_POINTS.map(entry => entry.path));
  const retained = new Set(preservedInputs.map(path => normalizeInputPath(root, path)));
  const removableInputs = [...capturedInputs]
    .filter(path => !entryPaths.has(path))
    .filter(path => !retained.has(path))
    .filter(path => isOwnedJavaScript(path))
    .sort();

  for (const path of removableInputs) {
    await rm(resolve(root, path));
    await rm(resolve(root, `${path}.map`), { force: true });
  }
  // The chunk-* prefix is reserved for the bundler, including obsolete hashes from prior builds.
  for (const name of await readdir(resolve(root, "sidepanel"))) {
    if (PANEL_CHUNK.test(name)) await rm(resolve(root, "sidepanel", name), { force: true });
  }
  for (const item of outputs) {
    const outputPath = resolve(root, item.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, item.contents);
    if (item.map) await writeFile(`${outputPath}.map`, item.map);
    else await rm(`${outputPath}.map`, { force: true });
  }
  await Promise.all(["background", "sidepanel", "shared", "products", "deps"].map(path => pruneEmptyDirectories(resolve(root, path))));

  const summary = {
    enabled: true,
    debugMaps,
    tool: `esbuild@${esbuildVersion}`,
    format: "esm",
    entries: builds.map(item => ({ name: item.name, ...describeOutput(item.outputs.find(output => output.output === item.output)) })),
    chunks: outputs.filter(item => !entryPaths.has(item.output)).map(describeOutput),
    inputFiles: capturedInputs.size,
    removedFiles: removableInputs.length,
    preservedFiles: [...capturedInputs].filter(path => retained.has(path) && !entryPaths.has(path)).length,
    outputFiles: outputs.length,
    outputBytes: outputs.reduce((total, item) => total + item.contents.byteLength, 0),
  };

  if (metafilePath) {
    const target = resolve(metafilePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify({ summary, builds: builds.map(item => item.metafile) }, null, 2)}\n`);
  }
  await refreshDependencyProvenance({ extensionDir: root, bundling: summary, transform: summary.tool });
  return summary;
}

/** One graph validator owns dependency retention for both compile and standalone bundle paths. */
export async function readRuntimeModuleGraph(root, entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
    platform: "browser", format: "esm", target: "chrome114",
    external: [resolve(root, "vendor/*")], logLevel: "silent",
  });
  if (result.warnings.length) {
    const messages = await formatMessages(result.warnings, { kind: "warning", color: false });
    throw new Error(`esbuild warnings for ${entry}:\n${messages.join("\n")}`);
  }
  const inputs = Object.keys(result.metafile.inputs).map(path => normalizeInputPath(root, path));
  for (const output of Object.values(result.metafile.outputs)) {
    for (const item of output.imports.filter(item => item.external)) {
      const path = resolve(root, item.path);
      if (!isPathInside(resolve(root, "vendor"), path) || !(await lstat(path)).isFile()) throw new Error(`unexpected external module: ${item.path}`);
    }
  }
  return inputs;
}

async function buildEntry(root, entry, debugMaps) {
  const entryPath = resolve(root, entry.path);
  const outputPath = resolve(root, entry.path);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPath],
    // MV3 Background stays a static bundle; DOM pages can load local ESM chunks on demand.
    ...(entry.name === "sidepanel" ? {
      outdir: dirname(outputPath), entryNames: "[name]",
      // Keep chunks beside the entry: external vendor URLs use the output directory as their base.
      chunkNames: "chunk-[name]-[hash]", splitting: true,
    } : { outfile: outputPath }),
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
    target: "chrome114",
    charset: "utf8",
    legalComments: "none",
    sourcemap: debugMaps ? "linked" : false,
    sourcesContent: true,
    treeShaking: false,
    logLevel: "silent",
    external: [resolve(root, "vendor/*")],
  });

  if (result.warnings.length) {
    const messages = await formatMessages(result.warnings, { kind: "warning", color: false });
    throw new Error(`esbuild warnings for ${entry.path}:\n${messages.join("\n")}`);
  }
  const javascript = result.outputFiles.filter(file => file.path.endsWith(".js"));
  if (!javascript.some(file => file.path === outputPath)
      || result.outputFiles.length !== javascript.length * (debugMaps ? 2 : 1)) {
    throw new Error(`${entry.path} produced unexpected outputs`);
  }

  const inputs = Object.keys(result.metafile.inputs)
    .map(path => normalizeInputPath(root, path))
    .sort();
  const outputs = [];
  for (const file of javascript) {
    const output = normalizeInputPath(root, file.path);
    if (output !== entry.path && (entry.name !== "sidepanel" || dirname(output) !== "sidepanel" || !PANEL_CHUNK.test(basename(output)))) {
      throw new Error(`${entry.path} produced an unexpected chunk: ${output}`);
    }
    const details = result.metafile.outputs[output];
    const externalImports = [];
    for (const imported of details.imports) {
      // Internal paths identify metafile outputs; external URLs are relative to their output file.
      const target = resolve(imported.external ? dirname(file.path) : root, imported.path);
      if (imported.external) {
        if (!isPathInside(resolve(root, "vendor"), target) || !(await lstat(target)).isFile()) {
          throw new Error(`${output} retained an unexpected external import: ${imported.path}`);
        }
        externalImports.push(toPosix(relative(dirname(file.path), target)));
      } else if (!javascript.some(candidate => candidate.path === target)) {
        throw new Error(`${output} references a missing chunk: ${imported.path}`);
      }
    }
    const map = result.outputFiles.find(candidate => candidate.path === `${file.path}.map`);
    if (debugMaps && !map) throw new Error(`missing bundle source map: ${output}`);
    outputs.push({ output, contents: file.contents,
      map: map ? stableDebugSourceMap(map.text, root, dirname(file.path)) : null,
      inputs: Object.keys(details.inputs).map(path => normalizeInputPath(root, path)).sort(),
      externalImports: externalImports.sort(),
    });
  }

  return {
    name: entry.name,
    output: entry.path,
    inputs,
    outputs,
    metafile: result.metafile,
  };
}

function describeOutput(item) {
  return { output: item.output, inputFiles: item.inputs.length, inputs: item.inputs,
    outputBytes: item.contents.byteLength, externalImports: item.externalImports };
}

/** Canonical source URLs keep release diagnostics independent of staging and checkout paths. */
export function stableDebugSourceMap(contents, sourceRoot, mapDirectory) {
  const map = JSON.parse(contents);
  map.sources = map.sources.map(path => {
    if (/^qingzhou:\/\/(?:extension|npm)\//.test(path)) return path;
    const absolute = originalSourceMapPath(path, mapDirectory, map.sourceRoot || "");
    const modules = resolve(REPO_ROOT, "node_modules");
    if (isPathInside(modules, absolute)) return `qingzhou://npm/${encodeSourceMapPath(relative(modules, absolute))}`;
    if (!isPathInside(sourceRoot, absolute)) throw new Error(`debug source escaped extension root: ${path}`);
    return `qingzhou://extension/${encodeSourceMapPath(relative(sourceRoot, absolute))}`;
  });
  delete map.sourceRoot;
  if (map.file) map.file = basename(map.file);
  return `${JSON.stringify(map)}\n`;
}

async function validateExtensionRoot(root) {
  const manifestPath = resolve(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) throw new Error(`${manifestPath} is not a Manifest V3 extension`);
  if (manifest.background?.service_worker !== ENTRY_POINTS[0].path) {
    throw new Error(`unexpected background entry: ${manifest.background?.service_worker || "missing"}`);
  }
  const sidepanelHtml = await readFile(resolve(root, "sidepanel/sidepanel.html"), "utf8");
  if (!/<script\b[^>]*\bsrc=["']sidepanel\.js["'][^>]*\btype=["']module["'][^>]*>/i.test(sidepanelHtml)
      && !/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']sidepanel\.js["'][^>]*>/i.test(sidepanelHtml)) {
    throw new Error("sidepanel/sidepanel.html does not load sidepanel.js as an ES module");
  }
  for (const entry of ENTRY_POINTS) {
    const info = await stat(resolve(root, entry.path));
    if (!info.isFile()) throw new Error(`${entry.path} is not a file`);
  }
}

function normalizeInputPath(root, input) {
  const absolute = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!isPathInside(root, absolute)) throw new Error(`bundle input escaped extension root: ${input}`);
  return toPosix(relative(root, absolute));
}

function isOwnedJavaScript(path) {
  return /\.(?:js|mjs|ts)$/.test(path)
    && !path.startsWith("vendor/");
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toPosix(path) {
  return path.split(sep).join("/");
}

async function pruneEmptyDirectories(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await pruneEmptyDirectories(resolve(root, entry.name));
  }
  const remaining = await readdir(root);
  if (!remaining.length) {
    await rmdir(root);
    return true;
  }
  return false;
}

function parseArgs(argv) {
  const options = { extensionDir: "", metafilePath: "", allowSource: false, debugMaps: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension-dir") options.extensionDir = argv[++index] || "";
    else if (arg.startsWith("--extension-dir=")) options.extensionDir = arg.slice("--extension-dir=".length);
    else if (arg === "--metafile") options.metafilePath = argv[++index] || "";
    else if (arg.startsWith("--metafile=")) options.metafilePath = arg.slice("--metafile=".length);
    else if (arg === "--allow-source") options.allowSource = true;
    else if (arg === "--debug-maps") options.debugMaps = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const summary = await bundleExtension(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
