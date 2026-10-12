import { t, tHtml } from "../../i18n/index.js";
import { createImageAssetUrls, type ImageAssetUrlOptions } from "../../ui/image-asset-urls.js";
import { escapeHtml, escapeHtmlAttribute as escapeAttr } from "../../ui/ui-utils.js";
import { record } from "../renderer-input.js";
import { basename, formatBytes, firstNonEmpty } from "../generic-result-renderer.js";
import { createToolView, isStaticRendererProjection, planRenderer, RendererRegistry, morphRendererChildren } from "../renderer-host.js";
import type { RendererDefinition, ToolView } from "../renderer-host.js";

interface ImageCard { src: string; assetId: string; title: unknown; subtitle: string; meta: unknown[]; method: unknown }
/** A grid owns its image URLs; discarded projections and static exports never load assets. */
export function createImageGridRenderer(options: ImageAssetUrlOptions = {}) {
  const previewUrl = (value: string) => /^(?:https?:|data:image\/|blob:)/i.test(value) ? value : "";

  function data(view: ToolView) {
    const result = record(view.result);
    const all = normalizeImageGridItems(result.items);
    const rows = all.slice(0, Math.max(1, Number(result.maxItems) || 60));
    return { rows, omitted: all.length - rows.length };
  }

  function project(view: ToolView, document: Document, staticOutput: boolean, urlFor: (id: string) => string | null | undefined = () => undefined) {
    const { rows, omitted } = data(view);
    const section = document.createElement("div");
    section.className = "tool-image-grid-section";
    section.innerHTML = `
      <div class="tool-image-grid-head">
        <div class="tool-image-grid-title">${escapeHtml(view.title || t("images"))}</div>
        <div class="tool-image-grid-meta"><span>${tHtml("imageTotal", { count: rows.length })}</span>${omitted ? `<span>${tHtml("moreImages", { count: omitted })}</span>` : ""}</div>
      </div>
      <div class="tool-image-grid-scroll" data-tool-scroll-surface="images"><div class="tool-image-grid">${rows.map(item => {
        const inlineImage = /^data:image\//i.test(item.src);
        const src = staticOutput ? (inlineImage ? item.src : "") : previewUrl(item.src) || urlFor(item.assetId) || "";
        const source = inlineImage ? item.assetId : item.src || item.assetId;
        const placeholder = staticOutput ? item.title : urlFor(item.assetId) !== undefined ? t("missing") : item.assetId ? t("loading") : t("noPreview");
        return `<div class="tool-image-grid-card" title="${escapeAttr(item.title || item.subtitle || item.assetId)}" data-gallery-item="${escapeAttr(JSON.stringify(toolImageGalleryItem(item)))}" data-tool-image-asset-id="${escapeAttr(item.assetId)}">
          <div class="tool-image-grid-thumb">${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(item.title)}" loading="lazy">` : `<span class="tool-image-grid-placeholder">${escapeHtml(placeholder)}</span>`}</div>
          ${staticOutput && source ? `<div class="tool-image-grid-source">${escapeHtml(source)}</div>` : ""}
        </div>`;
      }).join("")}</div></div>`;
    return section;
  }

  const definition: RendererDefinition = {
    id: "image-grid",
    renderStatic(view, { document }) { return project(view, document, true); },
    mount(container, view, { signal, document }) {
      const urls = createImageAssetUrls(options);
      const pending = new Map<string, object>();
      let wanted = new Set<string>();
      let disposed = false;
      const update = (next: ToolView): undefined => {
        wanted = new Set(data(next).rows.filter(item => item.assetId && !previewUrl(item.src)).map(item => item.assetId));
        urls.retain(wanted);
        for (const id of pending.keys()) if (!wanted.has(id)) pending.delete(id);
        const projection = document.createElement("div");
        projection.append(project(next, document, false, urls.peek));
        morphRendererChildren(container, projection);
        for (const id of wanted) {
          if (urls.peek(id) !== undefined || pending.has(id)) continue;
          const token = {};
          pending.set(id, token);
          urls.acquire(id).then(url => {
            if (!signal.aborted && !disposed && pending.get(id) === token && wanted.has(id)) refresh(id, url);
          }).finally(() => { if (pending.get(id) === token) pending.delete(id); });
        }
      };
      function refresh(id: string, url: string | null) {
        for (const slot of container.querySelectorAll<HTMLElement>("[data-tool-image-asset-id]")) {
          if (slot.dataset.toolImageAssetId !== id) continue;
          const thumb = slot.querySelector(".tool-image-grid-thumb");
          if (!thumb) continue;
          if (url) {
            const img = document.createElement("img");
            img.src = url; img.alt = slot.title; img.loading = "lazy";
            thumb.replaceChildren(img);
          } else {
            const text = document.createElement("span");
            text.className = "tool-image-grid-placeholder"; text.textContent = t("missing");
            thumb.replaceChildren(text);
          }
        }
      }
      update(view);
      return { update, dispose() {
        disposed = true;
        urls.dispose(); pending.clear();
      } };
    },
  };
  const registry = new RendererRegistry(definition);

  function appendImageGrid(parent: HTMLElement, title: unknown, items: unknown, { maxItems = 60 } = {}) {
    if (!normalizeImageGridItems(items).length) return false;
    const section = parent.ownerDocument.createElement("div");
    section.style.display = "contents";
    planRenderer(section, registry, createToolView({ id: "image-grid", rendererId: "image-grid", title: String(title || t("images")), result: { items, maxItems } }), isStaticRendererProjection());
    parent.appendChild(section);
    return true;
  }

function normalizeImageGridItems(items: unknown) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => normalizeImageGridItem(item, index))
    .filter((item): item is ImageCard => item !== null);
}

function normalizeImageGridItem(value: unknown, index = 0): ImageCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = record(value);
  const src = String(firstNonEmpty([item.currentSrc, item.src, item.url, item.imageUrl, item.previewUrl, item.thumbnailUrl]));
  const assetId = String(item.assetId || item.id || "").trim();
  const width = item.width ?? item.naturalWidth ?? item.sourceWidth;
  const height = item.height ?? item.naturalHeight ?? item.sourceHeight;
  const title = firstNonEmpty([item.alt, item.title, item.name, basename(src), assetId, t("imageNumber", { number: index + 1 })]);
  const meta = [
    width != null && height != null ? `${width} x ${height}` : "",
    item.mimeType || item.type || "",
    item.bytes ? formatBytes(item.bytes) : "",
    item.status && item.status !== "ready" ? item.status : "",
  ].filter(Boolean);
  if (!src && !assetId) return null;
  return {
    src,
    assetId,
    title,
    subtitle: summarizeImageGridSource(src || item.pageUrl || assetId),
    meta,
    method: item.method || item.captureMethod || item.source || "",
  };
}

function toolImageGalleryItem(item: ImageCard) {
  return {
    assetId: item.assetId || "",
    src: item.src || "",
    title: item.title || item.subtitle || item.assetId || t("images"),
    fields: [
      [t("source"), item.src || item.subtitle || ""],
      [t("information"), Array.isArray(item.meta) ? item.meta.join(" · ") : ""],
      [t("acquisitionMethod"), item.method || ""],
    ].filter(([, value]) => value !== undefined && value !== null && value !== ""),
  };
}

function summarizeImageGridSource(value: unknown = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return `${url.hostname}${url.pathname}`;
  } catch(_err) {
    return text;
  }
}

  return { definition, appendImageGrid };
}
