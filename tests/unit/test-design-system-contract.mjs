import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExtensionBoundaries } from "../../scripts/extension-boundaries.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const graph = validateExtensionBoundaries(join(root, "src"));
const capabilityEntries = graph.entries;
const capabilityDirectories = [...new Set([...capabilityEntries.renderers, ...capabilityEntries.ui]
  .map(entry => relative(root, dirname(entry))))];
const sidepanelCss = ["src/sidepanel/sidepanel.css", ...capabilityDirectories.map(path => `${path}/ui.css`)
  .filter(path => existsSync(join(root, path)))].map(path => readStylesheetSource(join(root, path))).join("\n");
const product = JSON.parse(read("src/products/manifest.json")).defaultProduct;
const sidepanelSources = [...new Set([
  ...["src/sidepanel", `src/products/${product}/sidepanel`].flatMap(listSidepanelSources),
  ...[...graph.contexts.sidepanel].map(path => relative(root, path)),
  ...capabilityDirectories.map(path => `${path}/ui.html`).filter(path => existsSync(join(root, path))),
])].map(path => [path, read(path)]);
const productStyles = sidepanelSources.flatMap(([, source]) =>
  [...source.matchAll(/<style>([\s\S]*?)<\/style>/gu)].map(match => match[1])).join("\n");

for (const token of [
  "field-height-sm",
  "field-height-md",
  "field-height-lg",
  "field-border",
  "field-border-focus",
  "field-focus-ring",
  "choice-size-md",
  "choice-border",
  "choice-border-hover",
  "switch-width",
  "popover-border",
  "popover-shadow",
  "menu-item-min-height",
  "toast-viewport-top",
  "toast-inline-margin",
  "toast-max-width",
  "toast-min-height",
]) {
  assert.match(sidepanelCss, new RegExp(`--${token}:`, "u"), `missing shared token --${token}`);
}

for (const primitive of [
  "qz-field",
  "qz-field--sm",
  "qz-field--lg",
  "qz-field--mono",
  "qz-field--bare",
  "qz-field-label",
  "qz-field-hint",
  "qz-select",
  "qz-checkbox",
  "qz-radio",
  "qz-switch",
  "qz-popover",
  "qz-menu",
  "qz-menu-item",
  "qz-decision-dialog",
  "qz-combobox",
  "qz-chiphead",
  "qz-pill",
  "qz-tree-toggle",
  "qz-segment",
  "qz-segment-item",
]) {
  assert.match(sidepanelCss, new RegExp(`\\.${primitive}\\b`, "u"), `.${primitive} must remain public`);
}

assert.match(
  sidepanelCss,
  /\.qz-menu-item\s*\{[^}]*background:\s*transparent;/u,
  "shared menu items should inherit their owning surface instead of imposing a modal background",
);

assert.match(
  sidepanelCss,
  /\.qz-field\[type="search"\]::-webkit-search-cancel-button\s*\{[^}]*width:\s*var\(--control-icon-md\);[^}]*background-color:\s*var\(--control-text\);[^}]*mask:[^;]*var\(--control-icon-xs\)[^;]*no-repeat;/u,
  "search fields must replace Chrome's accent-colored clear control with a token-sized neutral icon and a larger hit target",
);
assert.match(
  sidepanelCss,
  /\.qz-field\[type="search"\]::-webkit-search-cancel-button:hover\s*\{[^}]*background-color:\s*var\(--control-text-hover\);/u,
  "the shared search clear control should use the standard neutral hover state",
);
assert.match(
  sidepanelCss,
  /\.qz-checkbox,[\s\S]*?\.qz-radio\s*\{[^}]*border:\s*1px solid var\(--qz-choice-border, var\(--choice-border\)\);/u,
  "checkboxes and radios should share the perceptually stronger choice-control border",
);
assert.match(
  sidepanelCss,
  /\.qz-checkbox:not\(:disabled\):not\(:checked\):not\(:indeterminate\):hover,[\s\S]*?border-color:\s*var\(--qz-choice-border-hover, var\(--choice-border-hover\)\);/u,
  "unchecked choice controls should share the choice-control hover state",
);

const editorTextareaIds = new Set(["skill-body-text", "skill-editor-text", "input"]);
for (const [path, source] of sidepanelSources) {
  for (const match of source.matchAll(/<(input|select|textarea)\b[^>]*>/gu)) {
    const tag = match[0];
    const line = source.slice(0, match.index).split("\n").length;
    const name = match[1];
    const id = attribute(tag, "id");
    const type = attribute(tag, "type");
    const classes = attribute(tag, "class");
    const location = `${path}:${line}`;

    // Native value adapters have no visual surface. Ignore only a real hidden attribute,
    // not aria-hidden, a class name or the word "hidden" inside an attribute value.
    const hidden = /\shidden(?:\s|=|>)/u.test(tag.replace(/"[^"]*"|'[^']*'/gu, '""'));
    if (type === "file" || type === "hidden" || hidden) continue;
    if (tag.includes("${inputType") && tag.includes("qz-radio") && tag.includes("qz-checkbox")) continue;
    if (name === "textarea" && editorTextareaIds.has(id)) continue;
    if (type === "checkbox") {
      assert.match(classes, /\bqz-(?:checkbox|switch)\b/u, `${location} checkbox must use qz-checkbox or qz-switch`);
      continue;
    }
    if (type === "radio") {
      assert.match(classes, /\bqz-radio\b/u, `${location} radio must use qz-radio`);
      continue;
    }
    assert.match(classes, /\bqz-field\b/u, `${location} field must use qz-field`);
    if (name === "select") assert.match(classes, /\bqz-select\b/u, `${location} select must use qz-select`);
  }
}

const identityContracts = [
  ["tool-summary", "qz-chiphead"],
  ["thinking-group-summary", "qz-chiphead"],
  ["tool-family-row", "qz-pill"],
  ["tool-family-batch", "qz-pill"],
  ["tool-timeline-step", "qz-pill"],
  ["session-artifact-chip", "qz-pill"],
  ["tool-tree-toggle", "qz-tree-toggle"],
  ["session-tree-toggle", "qz-tree-toggle"],
  ["tab-btn", "qz-segment-item"],
  ["sessions-mode-btn", "qz-segment-item"],
  ["settings-tab", "qz-segment-item"],
  ["skill-workbench-tab", "qz-segment-item"],
];
const combinedSidepanelSource = sidepanelSources.map(([, source]) => source).join("\n");
for (const [component, identity] of identityContracts) {
  assert.match(
    combinedSidepanelSource,
    new RegExp(`(?:class=["']|className\\s*=\\s*["'])[^"']*\\b${identity}\\b[^"']*\\b${component}\\b`, "u"),
    `${component} must declare its independent ${identity} identity`,
  );
}

assert.doesNotMatch(combinedSidepanelSource, /showQzToast|qz-feedback|qz-toast/u, "sidepanel must not create a second toast system");
assert.equal([...sidepanelCss.matchAll(/\.case-toast\s*\{/gu)].length, 1, "sidepanel must keep one shared toast surface");
assert.doesNotMatch(combinedSidepanelSource, /skill-editor-toast|showSkillEditorToast|hideSkillEditorToast/u, "Feature code must not create a local Toast surface or timer");
assert.match(read("src/sidepanel/ui/toast-feature.ts"), /case-toast-action[\s\S]*case-toast-close/u, "the shared Toast must own actions and dismissal");
assert.doesNotMatch(sidepanelCss, /--feedback-/u, "short decisions must reuse the existing modal token family");
const decisionDialogSource = read("src/sidepanel/ui/decision-dialog-feature.ts");
const workspaceComposition = read("src/sidepanel/features/app/workspace-composition.js");
const dataGridColumnsSource = read("src/capabilities/data/workspace/data-grid-columns.js");
assert.match(decisionDialogSource, /hideToast\(\);/u, "opening a decision must dismiss the shared toast instead of stacking feedback");
assert.match(decisionDialogSource, /class="qz-field qz-field--sm"/u, "short text decisions should reuse the shared field primitive");
assert.match(workspaceComposition, /createDecisionDialogFeature\(\{[\s\S]*hideToast:\s*chat\.toast\.hide/u, "decision behavior should be composed with the existing toast instance");
assert.match(workspaceComposition, /showToast:\s*chat\.toast\.show,\s*hideToast:\s*chat\.toast\.hide,\s*dialogs:\s*decisions/u, "capabilities must receive the existing shared toast and decision ports");
assert.match(read("src/capabilities/skills/ui.ts"), /createSkillsFeature\(\{[\s\S]*showToast:\s*qz\.showToast,\s*hideToast:\s*qz\.hideToast/u, "Skill feedback must use the complete shared Toast instance");
assert.match(read("src/capabilities/data/ui.ts"), /createDataFeature\(\{[\s\S]*requestText:\s*qz\.dialogs\.requestText/u, "Data input decisions should use the shared dialog instance");
assert.doesNotMatch(dataGridColumnsSource, /\bprompt\s*\(/u, "Data fields must not open the browser-native prompt dialog");
assert.match(dataGridColumnsSource, /await requestText\(\{[\s\S]*title:\s*t\("addColumn"\)/u, "Data fields should request text through the shared decision dialog");
assert.doesNotMatch(combinedSidepanelSource, /\b(?:window|globalThis)\.(?:alert|confirm|prompt)\s*\(/u, "Sidepanel must not call browser-native dialogs");
assert.match(
  sidepanelCss,
  /#messages\[data-chat-state="landing"\]\s*\{[^}]*overflow-y:\s*hidden;[^}]*scrollbar-gutter:\s*auto;/u,
  "the landing state must disable message scrolling and its reserved scrollbar gutter",
);
assert.match(
  sidepanelCss,
  /\.welcome\s*\{[^}]*overflow-y:\s*auto;/u,
  "the landing surface must allow longer localized suggestions to remain reachable",
);

for (const legacy of ["field-input", "primary-btn", "secondary-btn", "run-btn", "cleanup-toggle"]) {
  assert.equal(hasClassToken(combinedSidepanelSource, legacy), false, `sidepanel source contains legacy design class ${legacy}`);
  assert.doesNotMatch(sidepanelCss, new RegExp(`\\.${legacy}\\b`, "u"), `sidepanel CSS contains legacy design class ${legacy}`);
}
assert.equal(sidepanelCss.includes("--mono-font"), false, "sidepanel CSS contains legacy --mono-font token");

const sidepanelClassNames = cssClassNames(`${sidepanelCss}\n${productStyles}`);
const unreferencedSidepanel = sidepanelClassNames.filter(name => !combinedSidepanelSource.includes(name));
assert.deepEqual(
  unreferencedSidepanel.filter(name => !isGeneratedOrExternalClass(name)),
  [],
  "sidepanel CSS contains an unclassified unused class",
);

console.log("design system contract tests passed");

function read(relativePath) {
  const path = existsSync(join(root, relativePath)) ? relativePath : relativePath.replace(/\.js$/, ".ts");
  return readFileSync(join(root, path), "utf8");
}

function listSidepanelSources(relativeDirectory) {
  const files = [];
  for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listSidepanelSources(relativePath));
    else if (entry.isFile() && /\.(?:html|js|ts)$/.test(entry.name) && !/\.(?:min\.js|d\.ts)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u"));
  return match?.[1] ?? match?.[2] ?? "";
}

function cssClassNames(css) {
  return [...new Set([...css.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/gu)].map(match => match[1]))].sort();
}

function hasClassToken(source, className) {
  for (const match of source.matchAll(/class\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    if ((match[1] ?? match[2] ?? "").split(/\s+/u).includes(className)) return true;
  }
  return false;
}

function isGeneratedOrExternalClass(name) {
  return name === "qz-field--lg"
    || name.endsWith("_")
    || name.startsWith("hljs-")
    || name.startsWith("tabulator-")
    || name.startsWith("tool-console-row-")
    || name.startsWith("tool-details-")
    || name.startsWith("tool-timeline-summary-");
}
