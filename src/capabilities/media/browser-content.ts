import { t } from "./i18n.js";
import * as presentation from "#sdk/sidepanel/presentation";
import { record } from "#sdk/sidepanel/presentation";
import type { ProfileHelpers } from "#sdk/sidepanel/components";
import { createImageGridRenderer } from "#sdk/sidepanel/components";
type Data = Record<string, unknown>;

export function createImageProfiles(helpers: ProfileHelpers) {
  const { pageDisplayTarget, appendDataRowsTable } = helpers;

const { appendImageGrid } = createImageGridRenderer();

function appendImageProfile(parent: HTMLElement, toolName: string, args: Data, result: unknown) {
  const data = record(result);
  if (toolName === "list_images") {
    presentation.appendCompactLine(parent, {
      title: t("imageCandidatesListed"),
      subtitle: data.pageTitle || data.pageUrl || args.selector || t("currentPage"),
      meta: [
        data.count != null ? t("images", { count: String(data.count) }) : "",
        args.selector ? `selector ${args.selector}` : "",
        pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
      ].filter(Boolean),
    });
    appendImageGrid(parent, t("imageCandidates"), data.images, { maxItems: 80 });
    if (data.note) presentation.appendNoteSection(parent, t("notice"), presentation.summarizeValue(data.note, 220));
    return true;
  }

  if (toolName === "collect_images") {
    presentation.appendCompactLine(parent, {
      title: data.table ? t("collection", { name: String(data.table) }) : t("imagesCollected"),
      subtitle: "",
      meta: [
        data.collected != null ? t("collected", { count: String(data.collected) }) : "",
        data.failed ? t("failed", { count: String(data.failed) }) : "",
        data.inserted != null ? t("added", { count: String(data.inserted) }) : "",
        data.updated != null ? t("updated", { count: String(data.updated) }) : "",
        data.totalRows != null ? t("collectionImages", { count: String(data.totalRows) }) : "",
        data.source ? `source ${data.source}` : "",
      ].filter(Boolean),
    });
    appendImageGrid(parent, t("collectedImages"), data.images || data.sample, { maxItems: 60 });
    if (Array.isArray(data.failures) && data.failures.length) {
      appendDataRowsTable(parent, t("failureExamples"), data.failures);
    }
    return true;
  }

  const detail = record(data._imageDetail);
  const source = presentation.firstNonEmpty([detail.src, data.src, data.url, args.url, data.target, args.target, data.selector, args.selector]);
  const size = imageSizeText(detail) || imageSizeText(data.clip) || imageSizeText(data);
  const title = toolName === "screenshot"
    ? (data.target || args.target || data.selector || args.selector ? t("elementScreenshotTitle") : t("pageScreenshotCaptured"))
    : (detail.alt || detail.title || presentation.basename(source || t("imageRead")));

  presentation.appendCompactLine(parent, {
    title,
    subtitle: source || "",
    meta: [
      data.method || data.screenshotMethod,
      pageDisplayTarget(args, data, { maxLength: 36, fallbackToTabId: false }),
      data.index != null ? `#${data.index}` : "",
      size,
      detail.mimeType || data.mimeType,
      detail.resized || data.resized ? t("resized") : "",
      data.clipped ? t("cropped") : "",
    ].filter(Boolean),
  });

  const fields = {
    method: data.method || data.screenshotMethod,
    detail: detail.detail || data.detail,
    src: detail.src || data.src || data.url || args.url,
    target: data.target || args.target,
    selector: data.selector || args.selector,
    size,
    naturalSize: imageNaturalSizeText(detail),
    mimeType: detail.mimeType || data.mimeType,
    bytes: detail.bytes ? presentation.formatBytes(detail.bytes) : (data.bytes ? presentation.formatBytes(data.bytes) : ""),
    clipped: data.clipped,
  };
  presentation.appendKeyValueSection(parent, t("imageDetails"), fields, { compact: true });
  if (data.note) presentation.appendNoteSection(parent, t("notice"), presentation.summarizeValue(data.note, 260));
  return true;
}

function imageSizeText(input: unknown = {}) {
  const value = record(input);
  const width = value.width ?? value.renderedWidth ?? value.naturalWidth;
  const height = value.height ?? value.renderedHeight ?? value.naturalHeight;
  return width != null && height != null ? `${width} x ${height}` : "";
}

function imageNaturalSizeText(input: unknown = {}) {
  const value = record(input);
  const width = value.naturalWidth;
  const height = value.naturalHeight;
  return width != null && height != null ? `${width} x ${height}` : "";
}

  return { renderImage: appendImageProfile, appendImageGrid: appendImageGrid };
}
