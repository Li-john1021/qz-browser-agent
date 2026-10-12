import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const overlays = new Map();

/** Compile the test-only installer for an HTTP overlay or an explicitly isolated extension copy. */
export async function prepareBenchmarkAssets(extensionDir, outputDir, { extensionUrlPrefix = "/extension" } = {}) {
  const key = resolve(extensionDir);
  if (extensionUrlPrefix === "/extension" && !outputDir && overlays.has(key)) return overlays.get(key);
  const directory = outputDir || await mkdtemp(join(tmpdir(), "qingzhou-benchmark-assets-"));
  if (!outputDir) process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  const extensionRoot = join(repositoryRoot, "src");
  await build({
    entryPoints: [join(repositoryRoot, "tests/benchmarks/conversation-render/host.mjs")],
    outfile: join(directory, "benchmark-test-hook.js"), bundle: true, format: "esm", target: "es2022",
    plugins: [{ name: "fixture-extension-imports", setup(builder) {
      builder.onResolve({ filter: /^\./ }, args => {
        const path = resolve(args.resolveDir, args.path);
        if (!path.startsWith(`${extensionRoot}${sep}`)) return;
        return { path: `${extensionUrlPrefix}/${relative(extensionRoot, path).replaceAll(sep, "/").replace(/\.ts$/, ".js")}`, external: true };
      });
    } }],
  });
  const html = await readFile(join(key, "sidepanel/sidepanel.html"), "utf8");
  await writeFile(join(directory, "sidepanel.html"), html.replace("</head>", '<script type="module" src="./benchmark-test-hook.js"></script>\n</head>'));
  if (extensionUrlPrefix === "/extension") overlays.set(key, directory);
  return directory;
}

export function benchmarkAsset(pathname, extensionDir) {
  const directory = overlays.get(resolve(extensionDir));
  if (!directory) return null;
  if (pathname === "/extension/sidepanel/sidepanel.html") return join(directory, "sidepanel.html");
  if (pathname === "/extension/sidepanel/benchmark-test-hook.js") return join(directory, "benchmark-test-hook.js");
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 && !(process.argv.length === 5 && process.argv[4] === "--extension")) {
    throw new Error("Usage: benchmark-assets.mjs <extension-directory> <output-directory> [--extension]");
  }
  await prepareBenchmarkAssets(process.argv[2], process.argv[3], { extensionUrlPrefix: process.argv[4] ? "" : "/extension" });
}
