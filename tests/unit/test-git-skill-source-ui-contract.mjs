import { assertClassTokens } from "../support/html-contracts.mjs";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("src/capabilities/skills/ui.html", "utf8");
const ui = readFileSync("src/capabilities/skills/workspace/git-skill-sources-panel.ts", "utf8");
const decision = readFileSync("src/sidepanel/ui/decision-dialog-feature.ts", "utf8");
const skins = ["sidepanel.css"].map(name => ({
  name,
  css: [readStylesheetSource(new URL(`../../src/sidepanel/${name}`, import.meta.url)), readFileSync("src/capabilities/skills/ui.css", "utf8")].join("\n"),
}));

assert.match(html, /id="btn-import-skills-git"[^>]*>Git 仓库<\/button>/u, "Skill import should expose Git repositories in the existing menu");
assert.match(html, /id="git-skill-sources-panel"[^>]+aria-label="Git 仓库来源"/u, "Git sources should own one workbench subview");
assert.match(html, /id="git-skill-source-url"[^>]+class="[^"]*\bqz-field\b/u, "repository URL should use the shared field primitive");
assert.match(html, /id="btn-bind-git-skill-source"[^>]+class="[^"]*\bqz-btn\b[^"]*\bqz-btn--primary\b/u, "binding should use the shared primary command");
assert.match(html, /class="[^"]*\bgit-skill-source-support\b[^"]*"[^>]*>支持 GitHub 与 GitLab，可粘贴仓库或目录页<\/p>/u, "supported platforms and directory URLs should be explicit");
assert.match(ui, /source\.browseUrl \|\| source\.repositoryUrl/u, "subdirectory sources should open their selected tree page");
assert.doesNotMatch(html, /git-skill-source-(?:modal|card)/u, "Git sources should remain an unframed workbench list");

assert.match(ui, /request\("list_git_skill_sources"/u, "source view should read Background-owned bindings");
assert.match(ui, /request\("bind_git_skill_source"/u, "source view should bind through Background API");
assert.match(ui, /request\("check_git_skill_source"/u, "refresh should check through a read-only Background action");
assert.match(ui, /request\("update_git_skill_source"/u, "source view should update through Background API");
assert.match(ui, /request\("remove_git_skill_source"/u, "source view should unbind through Background API");
assert.doesNotMatch(ui, /chrome\.storage|localStorage/u, "source view must not write persistence directly");
assert.match(ui, /class="qz-icon-btn qz-icon-btn--sm git-skill-source-action/u, "row actions should use shared icon buttons");
assert.match(ui, /data-git-source-action="check"[\s\S]+title="\$\{escapeHtmlAttribute\(t\("checkForUpdates"\)\)\}"/u, "refresh icon should expose its read-only command name");
assert.match(ui, /data-git-source-action="update"[\s\S]+>\$\{checked\.repairAvailable \? t\("restore"\) : t\("update"\)\}<\/button>/u, "an explicit apply command should appear only after checking");
assert.match(ui, /data-git-source-action="remove"[\s\S]+title="\$\{escapeHtmlAttribute\(t\("disconnectSource"\)\)\}"/u, "unlink icon should expose its command name");
assert.match(ui, /m18\.84 12\.25 1\.72-1\.71[\s\S]+x1="19" x2="22" y1="16" y2="16"/u, "unlink should use the Lucide Unlink geometry");
assert.match(ui, /chooseAction\(\{[\s\S]+label:\s*t\("keepSkills"\)[\s\S]+label:\s*t\("removeUnchangedItems"\)/u, "unbind should use the shared choice dialog for both outcomes");
assert.match(ui, /label:\s*t\("removeUnchangedItems"\)[\s\S]+tone:\s*"danger"/u, "only the destructive cleanup choice should receive danger semantics");
assert.match(ui, /deleteUnmodifiedSkills/u, "cleanup must preserve locally modified Skills");
assert.match(ui, /toast\(message,\s*\{[\s\S]*title,[\s\S]*actionLabel:[\s\S]*t\("retry"\)[\s\S]*onAction:\s*retry/u, "repository errors should use the structured shared Toast with a real retry action");
assert.match(decision, /createElement\("dialog"\)/u, "short decisions should use the browser modal top layer");
assert.match(decision, /className = `qz-btn qz-btn--ghost qz-decision-option/u, "choice rows should reuse the shared command primitive");

for (const skin of skins) {
  const panel = extractCssRule(skin.css, ".git-skill-sources-panel");
  const row = extractCssRule(skin.css, ".git-skill-source-row");
  const title = extractCssRule(skin.css, ".git-skill-source-title a");
  const issue = extractCssRule(skin.css, ".git-skill-source-meta em");
  const subpath = extractCssRule(skin.css, ".git-skill-source-subpath");
  const dialog = extractCssRule(skin.css, ".qz-decision-dialog");
  const dialogOpen = extractCssRule(skin.css, ".qz-decision-dialog[open]");
  const decisionPanel = extractCssRule(skin.css, ".qz-decision-panel");
  assertClassTokens(html, "git-skill-sources-panel", ["qz:flex", "qz:flex-col", "qz:flex-1", "qz:min-h-0"], `${skin.name} should use the workbench viewport`);
  assertClassTokens(html, "git-skill-sources-panel", ["qz:overflow-hidden"], `${skin.name} should keep one owned scroll surface`);
  assert.match(row, /grid-template-columns:\s*28px minmax\(0,\s*1fr\) auto/u, `${skin.name} should keep source rows stable`);
  assert.match(title, /text-overflow:\s*ellipsis/u, `${skin.name} should contain long repository names`);
  assert.match(issue, /color:\s*var\(--orange\)/u, `${skin.name} should reserve one signal color for actionable drift`);
  assert.match(subpath, /text-overflow:\s*ellipsis/u, `${skin.name} should keep long selected directories contained`);
  assert.match(dialog, /padding:\s*12px 12px clamp\(36px,\s*7vh,\s*64px\)/u, `${skin.name} should lift short decisions slightly above the physical center`);
  assert.match(dialogOpen, /place-items:\s*center/u, `${skin.name} should keep decisions in the visual center`);
  assert.match(decisionPanel, /background:\s*var\(--modal-card-surface\)/u, `${skin.name} decisions should reuse the existing modal material`);
  assert.match(decisionPanel, /box-shadow:\s*var\(--modal-card-shadow\)/u, `${skin.name} decisions should reuse the existing modal elevation`);
  assert.doesNotMatch(decisionPanel, /border-left\s*:/u, `${skin.name} decisions must not introduce a colored left rail`);
  assert.doesNotMatch(decisionPanel, /#[\da-f]{3,8}|rgb\(/iu, `${skin.name} decisions must not introduce a parallel color system`);
  assert.doesNotMatch(panel, /#[\da-f]{3,8}|rgb\(/iu, `${skin.name} Git panel should consume design tokens only`);
}

console.log("Git skill source UI contract tests passed");

function extractCssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule ${selector}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`);
}
