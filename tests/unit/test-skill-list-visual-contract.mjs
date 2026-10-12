import { assertClassTokens } from "../support/html-contracts.mjs";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const css = ["src/sidepanel/sidepanel.css", "src/capabilities/skills/ui.css"].map(path => readStylesheetSource(join(root, path))).join("\n");
const html = ["src/sidepanel/sidepanel.html", "src/capabilities/skills/ui.html", "src/capabilities/sessions/ui.html"].map(path => readFileSync(join(root, path), "utf8")).join("\n");
const js = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/skills/workspace/skills-feature.ts"), "utf8"), { mode: "transform" });

const siteBadgeRule = extractCssRule(css, ".skill-scope-badge.site");
const skillContentRule = extractCssRule(css, ".skill-content");
const skillContentInlineCodeRule = extractCssRule(css, ".skill-content code");
const skillContentPreRule = extractCssRule(css, ".skill-content pre");
const skillContentCopyablePreRule = extractCssRule(css, ".skill-content .copyable-code-block pre");
const skillContentPreCodeRule = extractCssRule(css, ".skill-content pre code");
const skillResourceRowsRule = extractCssRule(css, ".skill-resource-list-row,\n.skill-mcp-list-row");
const skillResourceTypeIconRule = extractCssRule(css, ".skill-list-type-icon svg");
const skillMarkdownEditorCodeRule = extractCssRule(css, ".markdown-editor textarea,\n.markdown-editor pre");
const skillResourceCodeSurfaceRule = extractCssRule(css, ".skill-resource-code-editor");
const skillResourceEditorCodeRule = extractCssRule(css, ".skill-resource-edit-content,\n.skill-resource-edit-highlight");
const skillConfigScopeRowRule = extractCssRule(css, ".skill-config-scope-row");
const exportSkillButton = extractElementById(html, "btn-export-skill");
const deleteSkillButton = extractElementById(html, "btn-delete-skill");
const saveSkillButton = extractElementById(html, "btn-save-skill-edit-top");

assert.match(html, /data-skill-filter="mine"[^>]*aria-pressed="true"[^>]*>我的<\/button>/, "Skill list should default to the user's own skills");
assert.match(html, /data-skill-filter="builtin"[^>]*aria-pressed="false"[^>]*>内置<\/button>/, "builtin skills should have one separate source view");
assert.match(html, /class="[^"]*\bqz-list-toolbar\b[^"]*\bsessions-list-toolbar\b[^\"]*"[\s\S]*id="sessions-search"[^>]+\bqz-list-toolbar-search\b/, "Session lists should consume the shared two-level toolbar");
assert.match(html, /class="[^"]*\bqz-list-toolbar\b[^"]*\bskills-toolbar\b[^\"]*"[\s\S]*id="skills-search"[^>]+\bqz-list-toolbar-search\b/, "Skill lists should consume the same shared two-level toolbar");
assert.match(html, /id="btn-import-session"[^>]+\bqz-list-toolbar-action\b/, "Session import should consume the shared list action geometry");
assert.match(html, /id="btn-import-skills"[^>]+\bqz-list-toolbar-action\b[\s\S]*id="btn-export-skills"[^>]+\bqz-list-toolbar-action\b/, "Skill package actions should consume the shared list action geometry");
assert.match(html, /id="btn-import-skills"[\s\S]*M4 22h14[\s\S]*<span[^>]*>导入<\/span>/, "Skill import should reuse the Session import icon");
assert.match(html, /id="btn-export-skills"[\s\S]*M12 3v12[\s\S]*<span[^>]*>导出<\/span>/, "Skill export should use the existing download icon");
assert.doesNotMatch(html, /id="skills-status"/, "transient Skill feedback should not occupy a third toolbar row");
assert.doesNotMatch(css, /\.skills-status\b/, "removed toolbar feedback should not leave a local visual system behind");
assert.match(js, /function setSkillsStatus\([^)]*\) \{[\s\S]*?showToast\(text, \{[\s\S]*?key: "skills-status"/, "Skill operations should reuse the shared Toast feedback surface");
assert.doesNotMatch(css, /\.skill-filter-btn\s*\{/, "Skill source tabs should not override the shared list-tab visual contract");
assert.match(extractCssRule(css, ".qz-list-toolbar-tab"), /cursor:\s*pointer/, "all shared Session and Skill list tabs should expose pointer affordance");
assert.match(extractCssRule(css, ".skills-toolbar"), /border-bottom:\s*0/, "Skill and Session list headers should both remain borderless");
assert.doesNotMatch(html, /data-skill-filter="(?:resident|global|site)"/, "scope metadata should not clutter the primary Skill navigation");

assert.doesNotMatch(js, /skills-section-title">当前站点|当前任务命中|skill-active-badge/, "skills page should stay global and not show site hit state");
assert.doesNotMatch(css, /\.skill-card\.active\b/, "skills page should not keep a special matched-card visual state");
assert.doesNotMatch(js, /renderSkillCard\(skill,\s*\{\s*active/, "skills list should not render matched skill cards");

assert.match(siteBadgeRule, /color:\s*var\(--text-secondary\)/, "site scope badge should stay neutral");
assert.doesNotMatch(siteBadgeRule, /var\(--green\)|var\(--success-border\)/, "site scope badge should not use AI-ish green emphasis");

assertClassTokens(html, "skill-content", ["qz:min-w-0"], "skill content should be shrinkable inside the detail pane");
assert.match(skillContentRule, /overflow-wrap:\s*anywhere/, "skill content should not let long prose overflow");
assert.match(skillContentInlineCodeRule, /display:\s*inline/, "skill inline code should remain inline");
assert.match(skillContentInlineCodeRule, /white-space:\s*break-spaces/, "skill inline code should wrap like chat inline code");
assert.match(skillContentInlineCodeRule, /box-decoration-break:\s*clone/, "skill inline code wraps should keep elegant segmented pills");
assert.match(skillContentPreRule, /overflow-x:\s*auto/, "skill pre blocks should scroll horizontally instead of clipping text");
assert.match(skillContentPreRule, /scrollbar-gutter:\s*stable/, "skill pre blocks should reserve scrollbar space cleanly");
assert.match(skillContentCopyablePreRule, /max-height:\s*var\(--code-block-max-height\)/, "copyable skill code blocks should keep chat-like height limits");
assert.match(skillContentPreCodeRule, /white-space:\s*pre/, "skill code blocks should preserve code whitespace");
assert.match(skillContentPreCodeRule, /overflow-wrap:\s*normal/, "skill code blocks should not fragment code tokens");
assert.doesNotMatch(js, /SKILL_RESOURCE_DENSE_THRESHOLD|SKILL_RESOURCE_PICKER_COMPACT_WIDTH|shouldUseSkillResourceDensePicker|installSkillResourcePickerLayoutObserver/, "resource editor should no longer maintain tab/dense switching paths");
assert.doesNotMatch(css, /\.skill-resource-edit-tabs|\.skill-resource-tab\b|\.skill-resource-edit-shell\.dense/, "resource editor should not restore obsolete tab/dense variants");
assert.doesNotMatch(js, /className\s*=\s*"skill-resource-select"/, "resource editor should use the workbench list instead of a dropdown");
assert.match(html, /class="[^"]*\bqz-segment\b[^"]*\bskill-workbench-tabs\b[^\"]*"[^>]+role="tablist"/, "skill detail should expose the unified segmented content/resources/MCP workbench");
assert.match(html, /class="[^"]*\bskill-context-action-slot\b[^"]*"[^>]*>[\s\S]*id="btn-edit-skill"[\s\S]*id="btn-preview-skill"[\s\S]*id="btn-add-skill-resource"[\s\S]*id="btn-add-skill-mcp"[\s\S]*?<\/span>/, "skill header should expose one stable contextual action slot");
assert.doesNotMatch(html, /id="skill-detail-scope"/, "scope labels should not clutter the Skill detail title bar");
assert.doesNotMatch(js, /#skill-detail-scope/, "Skill state updates should not restore a scope label in the title bar");
assert.doesNotMatch(css, /\.skill-detail-scope\b/, "the removed title-bar scope label should not leave dead styling behind");
assert.match(html, /id="btn-preview-skill"\s+class="[^"]*\bqz-icon-btn\b[^"]*\bhidden\b"[^>]+aria-pressed="true"/, "skill content should default to preview mode with an edit command visible");
assert.match(html, /id="btn-skill-actions"[^>]+class="[^"]*\bqz-icon-btn\b[^>]+aria-haspopup="menu"[^>]+aria-controls="skill-actions-menu"/, "skill header should expose one shared overflow trigger");
assert.match(html, /id="skill-actions-menu"[^>]+class="[^"]*\bqz-popover\b[^"]*\bqz-menu\b[^>]+role="menu"/, "Skill overflow should reuse the shared popover and menu primitives");
assert.doesNotMatch(html, /skill-workbench-toolbar|skill-workbench-context|skill-content-mode/, "skill panels should begin directly below the primary tabs without duplicate narrow toolbars");
assert.match(html, /id="skill-body-text"[^>]+wrap="soft"/, "body editing should hide frontmatter and wrap within the side panel");
assert.match(html, /id="skill-settings-view"/, "skill workbench should expose structured frontmatter configuration");
assert.doesNotMatch(html, /skill-config-(?:allowed-tools|compatibility|license)/, "advanced runtime metadata should pass through without cluttering basic settings");
assert.match(html, /id="skill-source-view"/, "skill workbench should retain an advanced full-source editor");
assert.match(html, /id="skill-body-highlight"\s+class="hljs language-markdown"/, "body editor should use the shared highlight.js surface");
assert.match(html, /id="skill-editor-highlight"\s+class="hljs language-markdown"/, "full source editor should use the shared highlight.js surface");
assert.match(css, /--syntax-keyword:/, "light and dark themes should expose one semantic syntax token set");
assert.doesNotMatch(css, /--(?:js|json)-(?:keyword|string|number|literal|function|comment)/, "legacy per-language syntax palettes should be removed");
assert.doesNotMatch(css, /\.md-(?:heading|yaml|code|list|link|quote|strong)/, "legacy hand-written Markdown token styles should be removed");
assert.match(
  extractCssRule(css, ".markdown-editor .hljs-strong"),
  /color:\s*var\(--text-primary\)/,
  "the product skin should make Markdown strong text distinct without changing glyph metrics",
);
assert.match(
  extractCssRule(css, ".markdown-editor .hljs-link"),
  /color:\s*var\(--syntax-title\)/,
  "the product skin should expose Markdown links through the shared syntax palette",
);
assert.match(
  extractCssRule(css, ".skill-content a"),
  /color:\s*var\(--accent\)/,
  "the product skin should not fall back to browser-default blue links in Skill previews",
);
assert.doesNotMatch(js, /function\s+highlightMarkdown(?:BodyLine)?\b|highlightYamlFrontmatterLine/, "Skill editors should not keep a hand-written Markdown/YAML highlighter");
assert.match(js, /highlightMarkdownDocument\(value/, "full SKILL.md should compose YAML and Markdown through the shared highlighter");
assert.doesNotMatch(html, /skill-save-state-dot|id="skill-save-state"/, "save state should live in the save button without a separate dot");
assert.match(html, /id="skill-actions-menu"[\s\S]*id="btn-skill-settings"[\s\S]*id="btn-export-skill"[\s\S]*role="separator"[\s\S]*id="btn-delete-skill"/, "low-frequency Skill management actions should share the overflow menu with danger last");
assertClassTokens(html, "skill-workbench-tabs", ["qz:h-11"], "skill workbench tabs preserve their 44px visual weight");
assertClassTokens(html, "skill-workbench-panel", ["qz:absolute"], "skill sections should share one stable workbench viewport");
assertClassTokens(html, "skill-content-preview", ["qz:overflow-y-auto"], "skill preview should own its scroll surface");
assert.match(skillMarkdownEditorCodeRule, /padding:\s*16px/, "body and full-source editors should share the workbench gutter");
assert.match(skillResourceCodeSurfaceRule, /background:\s*var\(--bg-primary\)/, "resource code should use the same editor surface as markdown");
assert.match(skillResourceEditorCodeRule, /padding:\s*14px 16px 38px/, "resource code should align to the same left and right gutter");
assertClassTokens(html, "skill-config-identity-grid", ["qz:grid-cols-2"], "basic identity fields should share one compact row");
assert.match(skillConfigScopeRowRule, /grid-template-columns:\s*minmax\(72px,\s*min-content\) minmax\(0,\s*1fr\)/, "scope labels keep a compact minimum width and expand for longer translations");
assert.match(
  extractCssRule(readStylesheetSource(join(root, "src/capabilities/skills/ui.css")), "@media (max-width: 380px)"),
  /\.skill-config-scope-row\s*,\s*\.skill-config-scope-fields label\s*\{[^}]*grid-template-columns:\s*minmax\(56px,\s*min-content\) minmax\(0,\s*1fr\)/,
  "narrow panels use a smaller label minimum while preserving room for longer translations",
);
assert.match(css, /--switch-width:\s*30px/, "shared switches should keep side-panel density");
assert.match(html, /id="skill-config-enabled"\s+class="qz-switch"/, "skill enabled state should use the shared neutral switch");
assert.match(skillResourceRowsRule, /grid-template-columns:\s*32px minmax\(0,\s*1fr\) auto 16px/, "resource and MCP rows should remain scan-friendly at side-panel widths");
assert.match(skillResourceTypeIconRule, /width:\s*17px/, "resource type icons should use one stable icon size");
assert.match(skillResourceTypeIconRule, /stroke-linecap:\s*round/, "resource type icons should share the Lucide line treatment");
assert.match(js, /function skillResourceTypeIcon\b/, "resource types should render semantic icons instead of punctuation marks");
assert.match(js, /skill-list-type-icon" aria-hidden="true"><span class="skill-list-type-label">MCP<\/span>/, "MCP resources should reuse the compact type-label typography");
assert.match(js, /M4 12\.15V4/, "script resources should use the file-code icon");
assert.match(js, /M8 3H7a2 2 0 0 0-2 2v5/, "JSON resources should use the spaced braces icon");
assert.doesNotMatch(js, /skillResourceTypeMark|return "<>"|return "\{\}"/, "resource types should not be represented by cramped text glyphs");
assert.match(js, /data-skill-resource-action="open"/, "resource rows should open a detail editor");
assert.match(js, /data-skill-resource-action="back"/, "resource detail should return to the complete list");
assert.doesNotMatch(js, /skill-resource-edit-path/, "resource detail should not keep a separate path field");
assert.match(js, /addEventListener\("dblclick"[\s\S]*beginSkillResourceRename/, "resource names should enter inline rename on double click");
assert.match(js, /event\.key === "Enter"[\s\S]*commitRename\(\)/, "Enter should commit an inline resource rename");
assert.match(js, /event\.key === "Escape"[\s\S]*restoreName\(\)/, "Escape should cancel an inline resource rename");
assert.match(js, /activeSkillResourceIndex\s*=\s*-1/, "resource navigation should start at the complete list");
assert.match(js, /if \(next === "content"\) \{\s*setSkillEditMode\(false\)/, "clicking Content should always return to preview mode");
assert.match(js, /syncSkillSourceFromStructuredEditors\(\)/, "structured fields should synchronize into full SKILL.md before save");
assert.match(js, /syncSkillStructuredEditorsFromSource/, "full source should synchronize back into structured fields");
assert.match(exportSkillButton, /class="[^"]*\bqz-menu-item\b/, "skill export should reuse the shared menu item primitive");
assert.match(exportSkillButton, /<span[^>]*>导出 Skill<\/span>/, "skill export menu item should have a visible label");
assert.match(exportSkillButton, /M12 3v12/, "skill export should use the direct download icon");
assert.match(deleteSkillButton, /class="[^"]*\bqz-menu-item\b[^"]*\bskill-actions-menu-danger\b/, "skill delete should remain a shared danger menu item");
assert.match(deleteSkillButton, /<span[^>]*>删除 Skill<\/span>/, "skill delete menu item should have an explicit visible label");
assert.match(deleteSkillButton, /viewBox="0 0 24 24"/, "skill detail delete button should use the standard 24px icon shape");
assert.match(deleteSkillButton, /M4 7h16/, "skill detail delete button should render a trash-can lid");
assert.match(deleteSkillButton, /M6 7l1 14h10l1-14/, "skill detail delete button should render a trash-can body");
assert.doesNotMatch(deleteSkillButton, /M4 4l8 8|M12 4l-8 8/, "skill detail delete button should not look like a close button");
assert.match(saveSkillButton, /class="skill-save-icon skill-save-icon-save"/, "dirty Skill state should use a semantic save icon class");
assert.match(saveSkillButton, /viewBox="0 0 24 24"/, "Skill save should use the standard Lucide viewport");
assert.match(saveSkillButton, /M15\.2 3a2 2 0 0 1 1\.4\.6/, "Skill save should use the Lucide save silhouette");

assert.match(extractCssRule(css, ".skill-editor"), /overflow-y:\s*auto/, "standalone editors own vertical scrolling");
assert.match(extractCssRule(css, ".skill-workbench-panel .skill-editor"), /overflow:\s*hidden/, "workbench containment overrides the standalone scroll policy");
assert.doesNotMatch(html.match(/id="skill-editor"[^>]*class="([^"]*)"/u)?.[1] || "", /qz:overflow/u, "unconditional utilities must not mask workbench scroll containment");
assert.match(css, /@media \(max-width: 380px\)\s*\{\s*\.skill-settings-scroll\s*\{[^}]*padding-right:\s*10px;[^}]*padding-left:\s*10px;/u, "only narrow Skill settings reduce their horizontal padding");
assert.doesNotMatch(html.match(/class="([^"\n]*\bskill-settings-scroll\b[^"\n]*)"/u)?.[1] || "", /qz:p[rlx]-/u, "wide Skill settings retain their component padding");

console.log("skill list visual contract tests passed");

function extractElementById(source, id) {
  const pattern = new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?<\\/button>`);
  const match = source.match(pattern);
  assert.ok(match, `missing element #${id}`);
  return match[0];
}

function extractCssRule(source, selector) {
  const start = source.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule ${selector}`);
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated CSS rule ${selector}`);
}
