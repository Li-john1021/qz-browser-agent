import { t } from "../../i18n/index.js";
import * as presentation from "../generic-result-renderer.js";
import { appendHtmlSection, escapeHtml } from "../../ui/ui-utils.js";
import { record } from "../renderer-input.js";
import { prefixLines } from "./text-utils.js";
type Data = Record<string, unknown>;
const CHANGE_PREVIEW_CHAR_LIMIT = 50000;

/** Shared patch presentation for declarative IR and file/resource editors. */
export function appendChanges(parent: HTMLElement, changes: unknown[], { title = t("changes") } = {}) {
  const items = (Array.isArray(changes) ? changes : []).map(record)
    .map(change => ({ change, preview: changePreview(change) }))
    .filter(item => item.preview.trim())
    .slice(0, 6);
  if (!items.length) return;
  appendHtmlSection(parent, "tool-diff-section", `
    <div class="tool-detail-label">${escapeHtml(title)}</div>
    ${items.map(({ change, preview }, index) => {
      const clipped = presentation.clipDisplayText(preview, CHANGE_PREVIEW_CHAR_LIMIT);
      return `
      <div class="tool-diff-card">
        <div class="tool-diff-title">
          <span>${escapeHtml(changeTitle(change))}</span>
          ${change.firstChangedLine ? `<em>L${escapeHtml(String(change.firstChangedLine))}</em>` : ""}
        </div>
        <pre class="tool-diff-block" data-tool-scroll-surface="diff-${index}" data-tool-stream-surface="30">${renderPatchPreview(clipped)}</pre>
      </div>
    `;
    }).join("")}
  `);
}

function changeTitle(change: Data = {}) {
  const action = change.kind || change.action || "";
  const prefix = action ? `${presentation.fieldLabel(action)} · ` : "";
  if (change.path) return `${prefix}${change.path}`;
  if (change.resource) return `${prefix}${change.resource}`;
  if (change.file) return `${prefix}${change.file}`;
  if (change.field === "content") return "content";
  return `${prefix}${change.field || "content"}`;
}

function renderPatchPreview(patchPreview: unknown) {
  return String(patchPreview || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => {
      const cls = line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "remove"
          : line.startsWith("@@")
            ? "hunk"
            : "context";
      return `<span class="tool-diff-line ${cls}">${escapeHtml(line || " ")}</span>`;
    })
    .join("");
}

export function changePreview(change: Data = {}) {
  if (typeof change.patchPreview === "string" && change.patchPreview.trim()) return change.patchPreview;
  if (typeof change.diff === "string" && change.diff.trim()) return change.diff;
  if (typeof change.patch === "string" && change.patch.trim()) return change.patch;

  const before = presentation.firstNonEmpty([change.before, change.oldText, change.find, change.search, change.from]);
  const after = presentation.firstNonEmpty([change.after, change.newText, change.replace, change.replacement, change.to]);
  if (before || after) {
    return [
      before ? prefixLines(before, "- ") : "",
      after ? prefixLines(after, "+ ") : "",
    ].filter(Boolean).join("\n");
  }

  const content = presentation.firstNonEmpty([change.content, change.appendContent, change.prependContent, change.replaceContent, change.text]);
  if (!content) return "";
  const prefix = change.kind === "append" || change.kind === "prepend" || change.kind === "create" ? "+ " : "  ";
  return prefixLines(content, prefix);
}
