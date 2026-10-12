import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderApiReference } from "../../scripts/docs-api.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("API reference covers all extension contracts deterministically without implementation or local paths", () => {
  const first = renderApiReference();
  assert.equal(renderApiReference(), first);
  assert.deepEqual([...first.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
    "Tool", "Renderer", "Embedded Skill", "Side Panel UI", "Model Provider", "Context Source", "Lifecycle Observer", "Document Codec",
  ]);
  for (const declaration of ["ToolDefinition", "RegisterTool", "ToolView", "RendererDefinition", "UiExtensionAPI", "RendererExtensionAPI", "ToolExtensionAPI", "UiPage", "UiSettingsSection", "ProviderAdapter",
    "ProviderContribution", "RuntimeConfig", "ContextSource", "LifecycleObserver", "DocumentCodec", "SkillDefinition", "SkillExtensionAPI", "SkillHostExtensionAPI", "SettingsForm", "SettingsFormState", "SettingsFormOptions"]) {
    assert.match(first, new RegExp(`export interface ${declaration}\\b`));
  }
  for (const declaration of ["createProviderRegistry", "createContextSources", "createLifecycleObservers", "createDocumentCodecs", "createSettingsForm"]) {
    assert.match(first, new RegExp(`export const ${declaration}:`), "the compiler must infer the public registration signature");
  }
  assert.match(first, /A title makes the result a bounded text capsule/);
  assert.match(first, /Registration order, not response timing/);
  assert.match(first, /registerRenderer\(renderer: RendererDefinition\): void;/);
  assert.match(first, /registerSettings\(section: UiSettingsSection\): void;/);
  assert.doesNotMatch(first, /file:\/\/|new Map\(|new WeakMap\(|throw new Error\(|withDeadline\(/);
  assert.doesNotMatch(first, /interface ActiveForm|const owns|let revision/);
  assert.equal(first.includes(root.replace(/\/$/, "")), false);
  assert.doesNotMatch(first, /(?:[A-Z]:\\|\/Users\/|\/home\/)/);
  for (const [, target] of first.matchAll(/\]\(([^)]+)\)/g)) {
    const path = resolve(root, "dist/docs", target.split("#")[0]);
    assert.doesNotThrow(() => readFileSync(path), `generated link resolves: ${target}`);
  }
});

test("changed source types, field documentation and inferred return types flow into the generated reference", () => {
  const contractFile = resolve(root, "src/sdk/background/context.ts");
  const runtimeFile = resolve(root, "src/background/context-sources.ts");
  const contract = readFileSync(contractFile, "utf8")
    .replace("export interface ContextSource {", `export interface ContextSource {
  /** A field description from the compiler's input. */
  readonly docsProbe?: "compiler-source-proof";`);
  const runtime = readFileSync(runtimeFile, "utf8")
    .replace("  const definitions = sources.map", '  const implementationMarker = "do-not-publish-runtime-body";\n  const definitions = sources.map')
    .replace("return { values, sources:", 'return { docsResult: "inferred-return-proof" as const, values, sources:');
  const sources = new Map([[contractFile, contract], [runtimeFile, runtime]]);
  const markdown = renderApiReference({ fileSystem: { readFile: path => sources.get(resolve(path)) } });
  assert.match(markdown, /readonly docsProbe\?: "compiler-source-proof"/);
  assert.match(markdown, /A field description from the compiler's input/);
  assert.match(markdown, /docsResult: "inferred-return-proof"/);
  assert.doesNotMatch(markdown, /implementationMarker|do-not-publish-runtime-body|sources\.map/);
});
