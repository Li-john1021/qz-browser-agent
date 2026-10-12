import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SOURCE_LANGUAGES = new Map([
  ...[".js", ".mjs", ".cjs", ".jsx"].map(ext => [ext, "JavaScript"]),
  ...[".ts", ".mts", ".cts", ".tsx"].map(ext => [ext, "TypeScript"]),
  [".py", "Python"], [".css", "CSS"], [".html", "HTML"],
  [".md", "Markdown"], [".json", "JSON"], [".toml", "TOML"],
  [".yaml", "YAML"], [".yml", "YAML"], [".sh", "Shell"],
]);
const EXCLUDED_PARTS = new Set([
  "vendor", "node_modules", "dist", "target", "_metadata", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".cache",
]);

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, ...options });
}

function sourceLanguage(filename) {
  if (filename.split("/").some(part => EXCLUDED_PARTS.has(part))
    || filename.startsWith("tests/results/") || filename.startsWith("test-results/")
    || /(?:^|\/)(?:package-lock|npm-shrinkwrap)\.json$/.test(filename)) return null;
  return SOURCE_LANGUAGES.get(path.posix.extname(filename)) || null;
}

function sourceScope(filename, language) {
  const directory = filename.split("/")[0];
  if (language === "Markdown") return "docs";
  // Keep historical extension/ and current src/ in one comparison scope.
  if (directory === "src" || directory === "extension") return "extension";
  if (["services", "scripts", "tests", "examples", "docs"].includes(directory)) return directory;
  return "other";
}

export function countLines(content) {
  if (!content) return { physicalLines: 0, nonBlankLines: 0 };
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return { physicalLines: lines.length, nonBlankLines: lines.filter(line => line.trim()).length };
}

function describeFile(filename, bytes) {
  const language = sourceLanguage(filename);
  return {
    path: filename,
    scope: sourceScope(filename, language),
    language,
    declaration: /\.d\.[cm]?ts$/.test(filename),
    bytes: bytes.length,
    ...countLines(bytes.toString("utf8")),
  };
}

function readRevision(root, ref) {
  const revision = git(root, ["rev-parse", "--verify", `${ref}^{commit}`], { encoding: "utf8" }).trim();
  const entries = git(root, ["ls-tree", "-rz", "--full-tree", revision], { encoding: "utf8" })
    .split("\0").filter(Boolean).map(entry => {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      return { mode, type, oid, path: entry.slice(tab + 1) };
    }).filter(entry => entry.type === "blob" && sourceLanguage(entry.path));
  for (const entry of entries) {
    if (entry.mode === "120000") throw new Error(`Source symlink cannot be inventoried: ${entry.path}`);
  }
  if (!entries.length) return { revision, files: [] };
  const blobs = git(root, ["cat-file", "--batch"], { input: entries.map(entry => entry.oid).join("\n") + "\n" });
  let offset = 0;
  const files = entries.map(entry => {
    const end = blobs.indexOf(10, offset);
    const [oid, type, size] = blobs.subarray(offset, end).toString("utf8").split(" ");
    if (oid !== entry.oid || type !== "blob") throw new Error(`Could not read ${entry.path} at ${revision}`);
    offset = end + 1;
    const content = blobs.subarray(offset, offset + Number(size));
    offset += Number(size) + 1;
    return describeFile(entry.path, content);
  });
  return { revision, files };
}

function readWorktree(root) {
  // Git's exclude rules keep local credentials, virtual environments and build
  // output out; --others includes new source before it is staged.
  const filenames = new Set(git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0").filter(filename => filename && sourceLanguage(filename)));
  const files = [];
  for (const filename of filenames) {
    const absolute = path.join(root, filename);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) {
      if (error.code === "ENOENT") continue; // Tracked file deleted in the worktree.
      throw error;
    }
    if (!stat.isFile()) throw new Error(`Source must be a regular file: ${filename}`);
    files.push(describeFile(filename, readFileSync(absolute)));
  }
  return { revision: "worktree", files };
}

function total(files) {
  return files.reduce((sum, file) => ({
    files: sum.files + 1,
    physicalLines: sum.physicalLines + file.physicalLines,
    nonBlankLines: sum.nonBlankLines + file.nonBlankLines,
    bytes: sum.bytes + file.bytes,
  }), { files: 0, physicalLines: 0, nonBlankLines: 0, bytes: 0 });
}

export function inventorySource({ root = ROOT, ref } = {}) {
  const inventory = ref ? readRevision(root, ref) : readWorktree(root);
  inventory.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const groups = Map.groupBy(inventory.files, file => `${file.scope}/${file.language}`);
  const jsTs = inventory.files.filter(file => ["JavaScript", "TypeScript"].includes(file.language));
  return {
    revision: inventory.revision,
    totals: {
      extensionJsTs: total(jsTs.filter(file => file.scope === "extension")),
      productionJsTs: total(jsTs.filter(file => ["extension", "services"].includes(file.scope))),
      unclassifiedJsTs: total(jsTs.filter(file => file.scope === "other")),
      declarations: total(jsTs.filter(file => file.declaration)),
    },
    groups: Object.fromEntries([...groups].map(([key, files]) => [key, total(files)]).sort(([a], [b]) => a < b ? -1 : 1)),
    files: inventory.files,
  };
}

export function compareInventory(current, baseline) {
  return Object.fromEntries(Object.entries(current.totals).map(([key, value]) => [key,
    Object.fromEntries(Object.entries(value).map(([metric, count]) => [metric, count - baseline.totals[key][metric]])),
  ]));
}

function main(args) {
  let ref, baselineRef;
  let json = false;
  let checkReduction = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--check-reduction") checkReduction = true;
    else if (arg === "--ref" || arg === "--baseline") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a Git revision`);
      if (arg === "--ref") ref = value;
      else baselineRef = value;
    } else if (arg === "--help") {
      console.log("Usage: node scripts/source-inventory.mjs [--ref COMMIT] [--baseline COMMIT] [--json] [--check-reduction]");
      return;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (checkReduction && !baselineRef) throw new Error("--check-reduction requires --baseline");
  const current = inventorySource({ ref });
  const baseline = baselineRef ? inventorySource({ ref: baselineRef }) : null;
  const delta = baseline ? compareInventory(current, baseline) : null;
  const reduced = delta && current.totals.unclassifiedJsTs.files === 0
    && ["extensionJsTs", "productionJsTs"].every(key => delta[key].physicalLines < 0);
  const report = {
    formatVersion: 1,
    counting: "Physical and non-blank lines both include comments and embedded code. Type declarations count as TypeScript. Vendor, generated output and lockfiles are excluded. Production lives in src/ (historically extension/) and services/; unclassified JS/TS blocks the reduction gate. Review scope changes and public feature cuts separately.",
    current,
    ...(baseline ? { baseline, delta } : {}),
  };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Source inventory: ${current.revision}`);
    console.table(current.groups);
    console.table(current.totals);
    if (delta) {
      console.log(`Change from ${baseline.revision}:`);
      console.table(delta);
    }
    console.log(report.counting);
  }
  if (checkReduction && !reduced) {
    console.error("Both extension and all production JS/TS physical lines must decrease, with no unclassified JS/TS remaining.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
