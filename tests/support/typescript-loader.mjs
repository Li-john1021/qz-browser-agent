import { generateModelsDevIndex } from "../../scripts/models-dev-assets.mjs";
import { generateMcpSdkForTests } from "../../scripts/vendor/assets.mjs";
import "tsx";
import "./default-locale.mjs";
import { fileURLToPath } from "node:url";
import { generateCapabilityCatalogs } from "../../scripts/capability-catalog.mjs";
generateCapabilityCatalogs(fileURLToPath(new URL("../../", import.meta.url)));
generateModelsDevIndex(fileURLToPath(new URL("../../", import.meta.url)));
await generateMcpSdkForTests();

// Node CLI --import is not inherited by child processes. Use the same locked
// loader for every Node descendant of either test orchestrator.
for (const module of ["tsx", "./default-locale.mjs"]) {
  const flag = `--import=${import.meta.resolve(module)}`;
  if (!(process.env.NODE_OPTIONS || "").includes(flag)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} ${flag}`.trim();
  }
}
