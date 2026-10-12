import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { providers } from "@opencode-ai/models/snapshot";
import { createModelsDevProviderIndex } from "../src/shared/models/models-dev-providers.ts";

export const modelsDevAssetPath = "vendor/models-dev/providers.json";
export const modelsDevAsset = JSON.stringify(providers);
const index = createModelsDevProviderIndex(providers);
const indexSource = `// Generated from the locked models.dev snapshot.\nexport const providerIds: readonly string[] = ${JSON.stringify(Object.keys(providers))};\nexport default ${JSON.stringify(index)} as const;\n`;

export function generateModelsDevIndex(root) {
  const destination = resolve(root, "dist/generated/models-dev.ts");
  if (existsSync(destination) && readFileSync(destination, "utf8") === indexSource) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, indexSource);
  renameSync(temporary, destination);
}

/** Embed only provider routes; the complete model directory is a local JSON asset. */
export function modelsDevIndexPlugin(sourceDir) {
  const path = resolve(sourceDir, "shared/models/models-dev-provider-index.generated.ts");
  return {
    name: "models-dev-provider-index",
    setup(build) {
      build.onResolve({ filter: /^#models-dev$/ }, () => ({ path }));
      build.onLoad({ filter: /models-dev-provider-index\.generated\.ts$/ }, () => ({ contents: indexSource, loader: "ts" }));
    },
  };
}
