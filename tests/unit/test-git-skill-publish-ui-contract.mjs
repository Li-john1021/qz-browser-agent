import { assertClassTokens } from "../support/html-contracts.mjs";
import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("src/capabilities/skills/ui.html", "utf8");
const feature = readFileSync("src/capabilities/skills/workspace/skills-feature.ts", "utf8");
const transport = readFileSync("src/background/transports/sidepanel.ts", "utf8");
const worker = readFileSync("src/background/service-worker.ts", "utf8");
const skins = ["sidepanel.css"].map(name => ({
  name,
  css: [readStylesheetSource(new URL(`../../src/sidepanel/${name}`, import.meta.url)), readFileSync("src/capabilities/skills/ui.css", "utf8")].join("\n"),
}));

const publishButtonIndex = html.indexOf('id="btn-publish-skill-git"');
const saveButtonIndex = html.indexOf('id="btn-save-skill-edit-top"');
assert.ok(publishButtonIndex >= 0 && publishButtonIndex < saveButtonIndex, "Git publish command should sit immediately before Save");
assert.match(html, /id="btn-publish-skill-git"[^>]+class="[^"]*\bqz-btn\b[^>]*>[\s\S]*?<circle cx="12" cy="12" r="3"[\s\S]*?<span[^>]*>提交 Git<\/span>/u, "publish should use the shared button and Lucide Git Commit geometry");
assert.match(html, /id="skill-git-publish-confirm"[^>]+role="dialog"[^>]+aria-modal="true"/u, "publish confirmation should be modal and accessible");
const backdropTag = html.match(/<button[^>]+class="([^"]*\bskill-git-publish-backdrop\b[^"]*)"[^>]*>/u);
assert.ok(backdropTag, "publish confirmation should expose a dismissible backdrop button");
assert.match(backdropTag[1], /\bqz-btn\b/u, "modal backdrop should remain inside the shared button system");
assert.match(html, /远端多出的文件不会删除。全部文件在一次 commit 中原子提交/u, "non-deletion and atomic semantics should be explicit");

assert.match(feature, /request\("inspect_git_skill_publish_target"/u, "Side Panel should discover the target through Background API");
assert.match(feature, /request\("publish_skill_to_git"/u, "Side Panel should publish through Background API");
assert.doesNotMatch(feature, /api\/v3\/projects|repository\/commits/u, "Side Panel must not know the Code API endpoint");
assert.match(feature, /isSkillDraftDirty\(\)[\s\S]+t\("saveTheSkillFirst"\)/u, "dirty Skills must be saved before publishing");
assert.match(transport, /inspect_git_skill_publish_target: \{ method: "skills\./u, "transport should expose target inspection");
assert.match(transport, /publish_skill_to_git: \{ method: "skills\./u, "transport should expose publishing");
assert.match(worker, /createGitSkillPublisherService/u, "service worker should own the publisher service");

for (const skin of skins) {
  const button = extractCssRule(skin.css, ".skill-detail-header .skill-git-publish-btn");
  const backdrop = extractCssRule(skin.css, ".skill-git-publish-backdrop");
  const sheet = extractCssRule(skin.css, ".skill-git-publish-sheet");
  const path = extractCssRule(skin.css, ".skill-git-publish-target code");
  assert.match(button, /flex:\s*none/u, `${skin.name} should keep the Git command stable`);
  assertClassTokens(html, "skill-git-publish-confirm", ["qz:absolute"], `${skin.name} should keep confirmation inside the workbench`);
  assertClassTokens(html, "skill-git-publish-backdrop", ["qz:w-full", "qz:h-full"], `${skin.name} should cover the complete confirmation surface`);
  assert.match(backdrop, /--qz-control-bg-hover:\s*var\(--modal-backdrop\)/u, `${skin.name} should keep the backdrop stable on hover`);
  assert.match(sheet, /var\(--modal-card-surface\)/u, `${skin.name} should consume the shared modal surface`);
  assert.match(path, /text-overflow:\s*ellipsis/u, `${skin.name} should contain long target paths`);
  assert.doesNotMatch(sheet, /#[\da-f]{3,8}|rgb\(/iu, `${skin.name} should use design tokens only`);
}

console.log("Git skill publish UI contract tests passed");

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
