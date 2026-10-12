#!/usr/bin/env node
import { generateModelsDevIndex } from "./models-dev-assets.mjs";
import { globSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCapabilityCatalogs } from "./capability-catalog.mjs";
import { validateExtensionBoundaries } from "./extension-boundaries.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Editor project references are also the typecheck inventory; no second context list. */
export function typecheckProjects(root = ROOT) {
  root = realpathSync(root);
  const untyped = globSync("src/**/*.{js,mjs,cjs,jsx}", { cwd: root, exclude: ["src/vendor/**"] });
  if (untyped.length) throw new Error(`First-party extension code requires a declared TypeScript runtime context: ${untyped.join(", ")}`);
  const uncovered = new Set(globSync("src/**/*.{ts,tsx}", { cwd: root, exclude: ["src/vendor/**"] }));
  const graphs = [validateExtensionBoundaries(resolve(root, "src")),
    validateExtensionBoundaries(resolve(root, "src"), { directory: resolve(root, "tests/fixtures/capabilities") })];
  for (const { declarations } of graphs) for (const path of declarations) uncovered.delete(relative(root, path));
  const { references } = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8"));
  if (!references?.length) throw new Error("tsconfig.json must declare TypeScript runtime contexts in references");
  const projects = references.map(({ path }) => {
    const config = resolve(root, path);
    const directory = dirname(config);
    const { include, exclude = [] } = JSON.parse(readFileSync(config, "utf8"));
    const files = new Set(globSync(include, { cwd: directory, exclude }).map(file => relative(root, resolve(directory, file))));
    for (const context of ["background", "sidepanel", "shared"]) {
      if (!include.some(pattern => pattern.endsWith(`/capabilities/${context}-roots.ts`))) continue;
      for (const graph of graphs) for (const path of graph.contexts[context]) files.add(relative(root, path));
    }
    for (const file of files) uncovered.delete(file);
    return { config, files: [...files].sort() };
  });
  if (uncovered.size) throw new Error(`TypeScript sources lack a runtime context: ${[...uncovered].join(", ")}`);
  return projects;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generateCapabilityCatalogs(ROOT);
  generateModelsDevIndex(ROOT);
  for (const { config, files } of typecheckProjects()) {
    if (!files.length) continue; // A public product may omit a deployment-specific context.
    console.log(`Typechecking ${relative(ROOT, config)} (${files.length} TypeScript files)`);
    const result = spawnSync(process.execPath, [resolve(ROOT, "node_modules/typescript/bin/tsc"), "-p", config], {
      cwd: ROOT, stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
