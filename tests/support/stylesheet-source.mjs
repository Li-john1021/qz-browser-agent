import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Source contracts inspect declarations without depending on the compiler's formatting.
 * Browser and build tests separately verify the actual compiled stylesheet. */
export function readStylesheetSource(file, ancestors = []) {
  const path = file instanceof URL ? fileURLToPath(file) : resolve(file);
  if (ancestors.includes(path)) throw new Error(`Circular stylesheet import: ${[...ancestors, path].join(" -> ")}`);
  return readFileSync(path, "utf8").replace(
    /^@import\s+["'](\.[^"']+)["'](?:\s+layer\([\w.-]+\))?\s*;\s*$/gmu,
    (_, relative) => readStylesheetSource(resolve(dirname(path), relative), [...ancestors, path]),
  );
}
