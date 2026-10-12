import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const core = readStylesheetSource(new URL("../../src/sidepanel/sidepanel.css", import.meta.url));
const owners = {
  page: [".tool-article-body", ".tool-details-read_dom"],
  skills: [".tool-skill-resource-head", ".chat-search-hit.skill-search-active", ".resource-ref-pill.skill"],
  documents: [".tool-details-save_file"],
  accessibility: [".tool-details-get_ax_tree", ".tool-ax-actions-table"],
  diagnostics: [".tool-console-list"],
  data: [".tool-data-summary", ".resource-ref-pill.data"],
  sessions: [".tool-session-prompt", ".case-toast.in-artifacts"],
};

test("capability presentation rules belong to their own resource, while shared primitives stay in the skin", () => {
  for (const [owner, selectors] of Object.entries(owners)) {
    const css = read(`src/capabilities/${owner}/ui.css`);
    for (const selector of selectors) {
      assert.ok(css.includes(selector), `${owner} owns ${selector}`);
      assert.ok(!core.includes(selector), `framework skin must not own ${selector}`);
    }
  }
  for (const selector of [".tool-data-table", ".tool-tree-panel", ".tool-diff-card", ".tool-image-grid",
    ".tool-screenshot", "@keyframes tool-image-action-before-frame"]) {
    assert.ok(core.includes(selector), `${selector} is a reusable framework primitive`);
  }
});

test("every existing resource scroll surface opts into the generic control", () => {
  const classes = new Set(["tab-panel", "sessions-list", "automation-list-scroll", "data-preview", "skills-list",
    "git-skill-sources-list", "skill-content", "skill-content-preview", "skill-editor",
    "skill-settings-scroll", "skill-resource-edit-list", "skill-mcp-edit-list", "skill-mcp-edit-item"]);
  const seen = new Set();
  const sources = [
    ...["data", "diagnostics", "sessions", "skills"].map(name => `src/capabilities/${name}/ui.html`),
    "src/capabilities/skills/workspace/skills-feature.ts",
    "src/capabilities/sessions/automations/automations-feature.ts",
  ];
  for (const source of sources) {
    for (const [, value] of read(source).matchAll(/class="([^"]*)"/g)) {
      const items = value.split(/\s+/);
      for (const item of items.filter(name => classes.has(name))) {
        seen.add(item);
        assert.ok(items.includes("qz-scroll"), `${source}: ${item} must opt into resource scrollbars`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...classes].sort());
  assert.match(core, /\.qz-scroll:not\(\.qz-scroll--native\)\s*\{\s*scrollbar-width:\s*thin;/);
  assert.doesNotMatch(core, /\.(?:data-preview|skills-list|skill-content|skill-editor|skill-settings-scroll)\b/);
});
