import { t } from "./i18n.js";
import { highlightCode } from "#sdk/sidepanel/dom";
import { codeLanguageForFilename, createCopyableCodeBlock, summarizeValue } from "#sdk/sidepanel/presentation";
type Data = Record<string, unknown>;

export function appendSaveFileContentPreview(parent: HTMLElement, args: Data = {}, { streaming = false } = {}) {
  const content = saveFileContentText(args);
  if (content == null) return false;
  const section = document.createElement("div");
  section.className = "tool-detail-section tool-file-content-section";

  const labelEl = document.createElement("div");
  labelEl.className = "tool-detail-label";
  labelEl.textContent = streaming ? t("generatingFileContent") : t("fileContent");

  const pre = document.createElement("pre");
  const language = codeLanguageForFilename(args.filename || "");
  const highlighted = highlightCode(content, language, { autoDetect: !language && content.length <= 20000 });
  pre.className = "code-block tool-file-content-block hljs";
  pre.dataset.toolScrollSurface = "file-content";
  pre.dataset.toolStreamSurface = "20";
  if (highlighted.language) pre.classList.add(`language-${highlighted.language}`);
  pre.innerHTML = highlighted.html;

  section.append(labelEl, createCopyableCodeBlock(pre, content));
  parent.appendChild(section);
  return true;
}

export function saveFileContentText(args: Data = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (!Object.prototype.hasOwnProperty.call(args, "content")) return null;
  if (typeof args.content === "string") return args.content;
  if (args.content == null) return null;
  return summarizeValue(args.content, 1000000);
}

