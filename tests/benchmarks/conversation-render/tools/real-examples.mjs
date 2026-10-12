import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Private exports are opt-in; the checked-in stub never counts as a real sample. */
export function discoverRealExamples(directory) {
  const files = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith(".")
      && entry.name !== "stub.json" && /\.(?:html?|json)$/i.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(name => join(directory, name));
  if (!files.length) {
    throw new Error("No real examples found. Add exported session HTML or transcript JSON files to tests/benchmarks/conversation-render/real_examples/; see its README.md.");
  }
  return files;
}
