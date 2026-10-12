import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExtensionBoundaries } from "../../scripts/extension-boundaries.mjs";
import { capabilityUiAssets } from "../../scripts/capability-catalog.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const graph = validateExtensionBoundaries(join(root, "src"));
const resources = [...(await capabilityUiAssets(join(root, "src"))).resources]
  .map(path => relative(root, path).split(sep).join("/"));
const capabilityStylePaths = resources.filter(path => path.startsWith("src/capabilities/") && path.endsWith("/ui.css"));
const css = ["src/sidepanel/sidepanel.css", ...capabilityStylePaths]
  .map(path => readStylesheetSource(join(root, path))).join("\n");
const buttonSources = [
  "src/sidepanel/sidepanel.html",
  ...listSidepanelSourceFiles("src/sidepanel"),
  ...[...graph.contexts.sidepanel].map(path => relative(root, path).split(sep).join("/")),
  ...resources.filter(path => path.endsWith(".html")),
];

const tokens = {
  "control-height-xs": "22px",
  "control-height-sm": "28px",
  "control-height-md": "32px",
  "control-height-lg": "38px",
  "control-padding-xs": "7px",
  "control-padding-sm": "10px",
  "control-padding-md": "12px",
  "control-padding-lg": "14px",
  "control-disabled-opacity": "0.42",
};

for (const [name, value] of Object.entries(tokens)) {
  assert.match(css, new RegExp(`--${name}:\\s*${value.replace(".", "\\.")}\\s*;`, "u"), `${name} must stay on the shared scale`);
}

for (const primitive of [
  ".qz-btn",
  ".qz-icon-btn",
  ".qz-btn--primary",
  ".qz-btn--secondary",
  ".qz-btn--ghost",
  ".qz-btn--danger",
  ".qz-btn--inline",
  ".qz-btn--xs",
  ".qz-btn--sm",
  ".qz-btn--lg",
  ".qz-icon-btn--xs",
  ".qz-icon-btn--sm",
  ".qz-icon-btn--md",
  ".qz-icon-btn--secondary",
  ".qz-icon-btn--danger",
]) {
  assert.match(css, new RegExp(`${primitive.replaceAll(".", "\\.")}\\b`, "u"), `${primitive} must be public`);
}

const independentButtonClasses = new Set([
  // Tabs, segmented controls and filter chips.
  "tab-btn",
  "sessions-mode-btn",
  "settings-tab",
  "skill-workbench-tab",
  "skill-filter-btn",
  "skill-config-scope-btn",
  "slash-filter-btn",
  // Structural rows, cards and menus.
  "onboarding-action",
  "data-import-file-trigger",
  "skills-import-menu-item",
  "skill-actions-menu-item",
  "skill-source-link",
  "model-suggestion-item",
  "slash-item",
  "session-artifact-chip",
  "data-table-select",
  "data-table-menu-item",
  "data-image-select-toggle",
  "data-image-open",
  "data-download-import",
  "skill-mcp-list-row",
  "skill-resource-list-row",
  "automation-filter-btn",
  "automation-artifact-line",
  "automation-artifact-row",
  "session-tree-toggle",
  "tool-summary",
  "tool-tree-toggle",
  "thinking-group-summary",
  "tool-family-row",
  "tool-family-batch",
  "tool-timeline-step",
  "data-image-gallery-thumb",
  // The composer send affordance deliberately keeps its own interaction model.
  "send-btn",
]);

const independentBoundaryClasses = new Set([
  "tab-btn",
  "sessions-mode-btn",
  "settings-tab",
  "skill-workbench-tab",
  "skill-filter-btn",
  "skill-config-scope-btn",
  "session-artifact-chip",
  "tool-summary",
  "thinking-group-summary",
  "tool-family-row",
  "tool-family-batch",
  "tool-timeline-step",
]);

const classAttribute = tag => {
  const match = tag.match(/class\s*=\s*(["'`])([\s\S]*?)\1/u);
  return match?.[2]?.trim() || "";
};

const classTokens = value => value.split(/\s+/u).filter(Boolean).map(token => token.split("${", 1)[0]);
const isPrimitive = value => classTokens(value).some(token => token === "qz-btn" || token === "qz-icon-btn");

const audit = [];
for (const relativePath of buttonSources) {
  const source = readFileSync(join(root, relativePath), "utf8");
  for (const match of source.matchAll(/<button\b[^>]*>/gu)) {
    const classes = classAttribute(match[0]);
    const line = source.slice(0, match.index).split("\n").length;
    const tokensForButton = classTokens(classes);
    const independent = tokensForButton.find(token => independentButtonClasses.has(token));
    const fieldSelect = tokensForButton.includes("qz-field") && tokensForButton.includes("qz-select");
    audit.push({ relativePath, line, classes, primitive: isPrimitive(classes), independent, fieldSelect });

    if (fieldSelect) {
      assert.match(match[0], /\btype=["']button["']/u, `${relativePath}:${line} field selectors must not submit a form`);
      assert.match(match[0], /\baria-haspopup=["'](?:dialog|listbox)["']/u, `${relativePath}:${line} field selectors must declare their selection popup`);
    }

    assert.notEqual(classes, "", `${relativePath}:${line} button must declare its UI role`);
    assert.ok(
      isPrimitive(classes) || independent || fieldSelect,
      `${relativePath}:${line} conventional button must use qz-btn/qz-icon-btn; got "${classes}"`,
    );

    for (const boundaryClass of tokensForButton.filter(token => independentBoundaryClasses.has(token))) {
      assert.equal(
        isPrimitive(classes),
        false,
        `${relativePath}:${line} ${boundaryClass} belongs to the independent chip/tab system`,
      );
    }
  }
}

assert.ok(audit.length >= 170, "button audit must cover all literal sidepanel controls");
assert.ok(audit.filter(item => item.primitive).length >= 110, "conventional controls must explicitly consume the shared primitives");
assert.ok(audit.filter(item => item.independent).length >= 50, "independent controls must remain deliberately classified");

const markdownFeatureJs = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/markdown-feature.ts"), "utf8"));
const genericResultRendererJs = readFileSync(join(root, "src/sidepanel/tools/generic-result-renderer.ts"), "utf8");
const sessionExportFeatureJs = readFileSync(join(root, "src/sidepanel/features/export/session-export-feature.ts"), "utf8") + readFileSync(join(root, "src/sidepanel/features/export/session-export-runtime.ts"), "utf8");
const uiUtilsSource = readFileSync(join(root, "src/sidepanel/ui/ui-utils.ts"), "utf8");
assert.match(
  uiUtilsSource,
  /createElement\("button"\)[\s\S]{0,180}className\s*=\s*"qz-icon-btn qz-icon-btn--xs code-copy-btn"/u,
  "the shared code-copy factory must use the icon primitive",
);
for (const [name, source] of [["markdown feature", markdownFeatureJs], ["generic result renderer", genericResultRendererJs]]) {
  assert.match(source, /const button = createCodeCopyButton\(/u, `${name} should use the shared code-copy factory`);
}
assert.match(
  sessionExportFeatureJs,
  /createElement\("button"\)[\s\S]{0,180}className\s*=\s*"qz-icon-btn qz-icon-btn--md image-lightbox-close"/u,
  "exported-session lightbox close button must use the icon primitive",
);
assert.match(
  sessionExportFeatureJs,
  /id="qingzhou-session-cta" class="qz-btn qz-btn--primary qz-btn--xs session-export-cta"/u,
  "exported-session continuation action must use the text button primitive",
);

for (const movingControl of [
  /\.qz-btn[^{}]*(?::hover|:active)[^{}]*\{[^{}]*transform\s*:/gu,
  /\.qz-icon-btn[^{}]*(?::hover|:active)[^{}]*\{[^{}]*transform\s*:/gu,
]) {
  assert.equal(movingControl.test(css), false, `command controls must not shift under pointer interaction: ${movingControl}`);
}

console.log(`button design system contract tests passed (${audit.filter(item => item.primitive).length} conventional, ${audit.filter(item => item.independent).length} independent)`);

function listSidepanelSourceFiles(relativeDirectory) {
  const absoluteDirectory = join(root, relativeDirectory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (entry.name === "vendor") continue;
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listSidepanelSourceFiles(relativePath));
    else if (entry.isFile() && /\.(?:html|js|ts)$/.test(entry.name)) files.push(relativePath);
  }
  return files.sort();
}
