import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import {
  INTERNAL_CANDIDATE_KEYS,
  instrumentArticleExtractorSource,
} from "./instrument-extractor.mjs";
import { instrumentContentScriptSource } from "./instrument-content-script.mjs";
import { analyzeMarkdown } from "./markdown-quality.mjs";
import { normalizeSnapshotText } from "./corpus-diversity-audit.mjs";
import { resolveCaptureSettlePolicy } from "./capture-settle-policy.mjs";
import { ensureTestExtension } from "../../support/extension-build.mjs";
import { prepareUpstreamArticleAssets } from "../../support/upstream-article-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const defaultResults = join(root, "tests/results/article-extraction");
const INTERNAL_CANDIDATE_MAX_CHUNKS = 4;
const INTERNAL_CANDIDATE_CONTENT_CAP = INTERNAL_CANDIDATE_MAX_CHUNKS * 20_000;
const captureSettlePolicy = resolveCaptureSettlePolicy(name => option(name, ""));

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function repeatedOption(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(String(process.argv[index + 1] || ""));
  }
  return values;
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function loadHumanGold(labelsDir, corpusDir, manifestPath, manifest) {
  const labelManifestPath = join(labelsDir, "manifest.json");
  const labelsPath = join(labelsDir, "labels");
  if (!existsSync(labelManifestPath)) throw new Error(`gold labels have no manifest.json: ${labelsDir}`);
  if (!existsSync(labelsPath)) throw new Error(`gold labels have no labels directory: ${labelsDir}`);
  const labelManifest = json(labelManifestPath);
  const corpusBytes = readFileSync(manifestPath);
  if (labelManifest.schema !== "qingzhou.article-extraction-manual-label-set.v1") {
    throw new Error(`unsupported gold label schema: ${labelManifest.schema || "missing"}`);
  }
  if (labelManifest.method !== "human-reviewed-frozen-dom") {
    throw new Error(`gold labels are not human-reviewed-frozen-dom: ${labelManifest.method || "missing"}`);
  }
  if (labelManifest.pendingHumanReview !== 0) {
    throw new Error(`gold labels still have ${labelManifest.pendingHumanReview ?? "unknown"} pending human reviews`);
  }
  if (labelManifest.corpusDigest !== sha256(corpusBytes)) {
    throw new Error("gold label corpus digest does not match the frozen corpus");
  }
  if (!Array.isArray(manifest.samples)) throw new Error("corpus manifest has no samples array");
  if (labelManifest.samples !== manifest.samples.length) {
    throw new Error(`gold label sample count ${labelManifest.samples} does not match corpus sample count ${manifest.samples.length}`);
  }

  const samplesById = new Map();
  for (const sample of manifest.samples) {
    if (!sample.id || samplesById.has(sample.id)) throw new Error(`corpus has an invalid or duplicate sample id: ${sample.id || "missing"}`);
    samplesById.set(sample.id, sample);
  }
  const expectedFiles = new Set(manifest.samples.map(sample => `${sample.id}.json`));
  const actualFiles = readdirSync(labelsPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
    .map(entry => entry.name);
  const missing = [...expectedFiles].filter(name => !actualFiles.includes(name));
  const unknown = actualFiles.filter(name => !expectedFiles.has(name));
  if (missing.length || unknown.length) {
    throw new Error(`gold label ids do not match corpus ids (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`);
  }

  const labelsById = new Map();
  for (const sample of manifest.samples) {
    const snapshot = corpusAssetPath(corpusDir, sample.snapshot, `corpus sample ${sample.id} snapshot`);
    if (sha256(readFileSync(snapshot)) !== sample.inputSha256) {
      throw new Error(`corpus sample ${sample.id} snapshot does not match inputSha256`);
    }
    if (sample.screenshot) {
      const screenshot = corpusAssetPath(corpusDir, sample.screenshot, `corpus sample ${sample.id} screenshot`);
      const expectedScreenshotSha = basename(sample.screenshot, extname(sample.screenshot)).toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expectedScreenshotSha)
        || sha256(readFileSync(screenshot)) !== expectedScreenshotSha) {
        throw new Error(`corpus sample ${sample.id} screenshot is not the content-addressed review image`);
      }
    }
    const label = json(join(labelsPath, `${sample.id}.json`));
    if (label.schema !== "qingzhou.article-extraction-manual-label.v1") {
      throw new Error(`${sample.id} has unsupported gold label schema: ${label.schema || "missing"}`);
    }
    if (label.sampleId !== sample.id) throw new Error(`${sample.id} gold label has mismatched sampleId: ${label.sampleId || "missing"}`);
    if (label.inputSha256 !== sample.inputSha256) throw new Error(`${sample.id} gold label does not match inputSha256`);
    if (!["extract", "exclude"].includes(label.status)) throw new Error(`${sample.id} gold label has unresolved status: ${label.status || "missing"}`);
    if (label.reference?.method !== "human-reviewed-frozen-dom") {
      throw new Error(`${sample.id} reference is not human-reviewed-frozen-dom`);
    }
    if (label.review?.status !== "approved" || label.review?.domReviewed !== true) {
      throw new Error(`${sample.id} gold label is not approved after DOM review`);
    }
    if (Boolean(label.review?.screenshotReviewed) !== Boolean(sample.screenshot)) {
      throw new Error(`${sample.id} screenshot review state does not match the corpus`);
    }
    labelsById.set(sample.id, label);
  }
  const status = Object.fromEntries(["extract", "exclude"].map(value => [
    value,
    [...labelsById.values()].filter(label => label.status === value).length,
  ]));
  if (labelManifest.status?.extract !== status.extract || labelManifest.status?.exclude !== status.exclude) {
    throw new Error("gold label status summary does not match its labels");
  }

  const splitById = new Map();
  const provenanceBaseTarget = Number(manifest.provenance?.sources?.find(source => source.role === "base")?.target);
  if (Number.isInteger(provenanceBaseTarget)
    && provenanceBaseTarget >= 0
    && provenanceBaseTarget <= manifest.samples.length) {
    manifest.samples.forEach((sample, index) => (
      splitById.set(sample.id, index < provenanceBaseTarget ? "base" : "increment")
    ));
  } else {
    const numericIds = manifest.samples.map(sample => /^core-(\d+)$/.exec(sample.id));
    if (!numericIds.every(Boolean)) {
      throw new Error("gold corpus cannot be split into base and increment shards");
    }
    manifest.samples.forEach((sample, index) => {
      splitById.set(sample.id, Number(numericIds[index][1]) <= 300 ? "base" : "increment");
    });
  }
  return { labelsDir, manifest: labelManifest, labelsById, splitById, status };
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm$|from$|source$|src$|track|share_|timestamp$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.href;
  } catch (_error) {
    return "";
  }
}

function withBase(html, url) {
  const base = `<base href="${String(url).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${base}`);
  return html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}<head>${base}</head>`);
}

function sanitizeSnapshotHtml(html) {
  let value = String(html || "")
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (match, attributes) => (
      /\btype\s*=\s*["']application\/ld\+json(?:;[^"']*)?["']/i.test(attributes) ? match : ""
    ))
    .replace(/<script\b[^>]*\/\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel\s*=\s*["'][^"']*(?:stylesheet|preload|modulepreload|prefetch)[^"']*["'][^>]*>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, "")
    .replace(/<(?:iframe|embed)\b[^>]*\/?>/gi, "")
    .replace(/<object\b[^>]*>/gi, "")
    .replace(/<\/object\s*>/gi, "")
    .replace(/<param\b[^>]*\/?>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<meta\b[^>]*(?:charset\s*=|http-equiv\s*=\s*["']?content-type)[^>]*>/gi, "");
  if (/<head(?:\s[^>]*)?>/i.test(value)) {
    value = value.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<meta charset="utf-8">`);
  }
  return value;
}

function sameHost(url, hosts) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some(value => host === value || host.endsWith(`.${value}`));
  } catch (_error) {
    return false;
  }
}

function matchesDetail(url, patterns) {
  let probe = "";
  try {
    const parsed = new URL(url);
    probe = `${parsed.pathname}${parsed.search}`;
  } catch (_error) {
    return false;
  }
  return patterns.some(pattern => {
    try {
      return new RegExp(pattern, "i").test(probe);
    } catch (_error) {
      return false;
    }
  });
}

function evenlySample(items, limit) {
  if (items.length <= limit) return items;
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    selected.push(items[Math.floor(index * (items.length - 1) / Math.max(1, limit - 1))]);
  }
  return selected;
}

async function settle(page, type) {
  if (type !== "detail") {
    await page.evaluate(() => scrollTo(0, Math.min(document.documentElement.scrollHeight, innerHeight * 1.5))).catch(() => {});
    await page.waitForTimeout(captureSettlePolicy.scrollDelayMs);
    await page.evaluate(() => scrollTo(0, 0)).catch(() => {});
  }
  const started = performance.now();
  let previous = "";
  let stable = 0;
  for (;;) {
    await page.waitForTimeout(captureSettlePolicy.sampleIntervalMs);
    const state = await renderedPageState(page);
    const digest = renderedPageSignature(state);
    if (digest === previous) stable += 1;
    else stable = 0;
    previous = digest;
    const elapsed = performance.now() - started;
    if (stable >= 2 && elapsed >= captureSettlePolicy.minObservationMs) return;
    if (elapsed >= captureSettlePolicy.maxObservationMs) return;
  }
}

async function renderedPageState(page) {
  return page.evaluate(() => {
    const body = document.body;
    const structure = () => {
      if (!body) return [];
      let hash = 2166136261;
      const stack = [body];
      while (stack.length) {
        const element = stack.pop();
        const token = `${element.tagName}:${element.childElementCount}:${element.getAttribute("role") || ""}:${element.getAttribute("itemprop") || ""};`;
        for (let index = 0; index < token.length; index += 1) {
          hash ^= token.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        for (let index = element.children.length - 1; index >= 0; index -= 1) stack.push(element.children[index]);
      }
      return [body.querySelectorAll("*").length, hash >>> 0];
    };
    return {
      url: location.href,
      title: document.title,
      text: body?.innerText || "",
      structure: structure(),
    };
  }).catch(() => ({ url: "", title: "", text: "", structure: [] }));
}

function renderedPageSignature(value) {
  return sha256(JSON.stringify([
    value?.url ?? value?.runtime?.location ?? "",
    normalizedText(value?.title),
    normalizedText(value?.text ?? value?.bodyText),
    value?.structure ?? value?.runtime?.renderedStructure ?? [],
  ]));
}

async function captureConsistentPage(page, type, screenshots) {
  let inspected = null;
  let screenshot = null;
  let state = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await settle(page, type);
    inspected = await inspectPage(page, type);
    if (screenshots) {
      try {
        screenshot = await page.screenshot({ type: "jpeg", quality: 45 });
      } catch (error) {
        return {
          inspected,
          screenshot: null,
          state: null,
          attempts: attempt,
          consistent: false,
          failure: "screenshot_failed",
          error: `${error?.name || "Error"}: ${error?.message || error}`,
        };
      }
      if (!screenshot?.length) {
        return {
          inspected,
          screenshot: null,
          state: null,
          attempts: attempt,
          consistent: false,
          failure: "screenshot_failed",
          error: "ScreenshotError: Chromium returned an empty audit screenshot",
        };
      }
    }
    state = await renderedPageState(page);
    if (renderedPageSignature(inspected) === renderedPageSignature(state)) {
      return { inspected, screenshot, state, attempts: attempt, consistent: true };
    }
  }
  return { inspected, screenshot, state, attempts: 3, consistent: false };
}

async function inspectPage(page, requestedType) {
  return page.evaluate((type) => {
    const normalize = value => String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0
        && rect.width > 0 && rect.height > 0;
    };
    const textLength = element => normalize(element?.innerText || element?.textContent || "").length;
    const renderedStructure = () => {
      const body = document.body;
      if (!body) return [];
      let hash = 2166136261;
      const stack = [body];
      while (stack.length) {
        const element = stack.pop();
        const token = `${element.tagName}:${element.childElementCount}:${element.getAttribute("role") || ""}:${element.getAttribute("itemprop") || ""};`;
        for (let index = 0; index < token.length; index += 1) {
          hash ^= token.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        for (let index = element.children.length - 1; index >= 0; index -= 1) stack.push(element.children[index]);
      }
      return [body.querySelectorAll("*").length, hash >>> 0];
    };
    const serializeFrozenDom = () => {
      const started = performance.now();
      const clone = document.cloneNode(true);
      const stack = [];
      const sourceBody = document.body;
      const clonedBody = clone.body;
      if (sourceBody && clonedBody) {
        for (let index = sourceBody.children.length - 1; index >= 0; index -= 1) {
          stack.push({
            source: sourceBody.children[index],
            target: clonedBody.children[index],
            parentVisibilityHidden: false,
            exit: false,
          });
        }
      }
      const visibleSubtrees = new WeakMap();
      let visitedElements = 0;
      let hiddenRoots = 0;
      while (stack.length) {
        const frame = stack.pop();
        const { source, target } = frame;
        if (!source || !target) continue;
        if (frame.exit) {
          const hasVisibleDescendant = [...source.children]
            .some(child => visibleSubtrees.get(child) === true);
          visibleSubtrees.set(source, !frame.visibilityHidden || hasVisibleDescendant);
          if (frame.visibilityHidden) {
            if (!hasVisibleDescendant) {
              target.setAttribute("hidden", "");
              hiddenRoots += 1;
              continue;
            }
            target.style.visibility = "visible";
            for (const node of [...target.childNodes]) {
              if (node.nodeType === Node.TEXT_NODE) node.remove();
            }
          } else if (frame.parentVisibilityHidden) {
            target.style.visibility = "visible";
          }
          continue;
        }
        visitedElements += 1;
        const style = getComputedStyle(source);
        if (source.hasAttribute("hidden") && style.display !== "none") target.removeAttribute("hidden");
        const displayContents = style.display === "contents";
        const cssHidden = style.display === "none"
          || (!displayContents && (
            Number.parseFloat(style.opacity || "1") === 0
            || style.contentVisibility === "hidden"
          ));
        if (cssHidden) {
          target.setAttribute("hidden", "");
          visibleSubtrees.set(source, false);
          hiddenRoots += 1;
          continue;
        }
        if (source.style && target.style) {
          if (source.style.display === "none" && style.display !== "none") target.style.removeProperty("display");
          if (Number(source.style.opacity) === 0 && Number(style.opacity) !== 0) target.style.removeProperty("opacity");
          if (source.style.contentVisibility === "hidden" && style.contentVisibility !== "hidden") {
            target.style.removeProperty("content-visibility");
          }
          if (/^(?:hidden|collapse)$/.test(source.style.visibility)
            && !/^(?:hidden|collapse)$/.test(style.visibility)) {
            target.style.removeProperty("visibility");
          }
          if (displayContents) {
            target.style.removeProperty("opacity");
            target.style.removeProperty("content-visibility");
          }
        }
        const visibilityHidden = style.visibility === "hidden" || style.visibility === "collapse";
        stack.push({
          ...frame,
          exit: true,
          visibilityHidden,
          visibility: style.visibility,
        });
        for (let index = source.children.length - 1; index >= 0; index -= 1) {
          stack.push({
            source: source.children[index],
            target: target.children[index],
            parentVisibilityHidden: visibilityHidden,
            exit: false,
          });
        }
      }
      return {
        html: clone.documentElement.outerHTML,
        visitedElements,
        hiddenRoots,
        elapsedMs: performance.now() - started,
      };
    };
    const candidates = [];
    const addCandidates = (selector, strength) => {
      document.querySelectorAll(selector).forEach((element) => {
        if (!visible(element)) return;
        const chrome = element.closest("header,nav,footer,aside,[role='navigation'],[role='complementary']");
        if (chrome && !element.matches("main,article,[role='main'],[role='article'],[itemprop='articleBody']")) return;
        const length = textLength(element);
        if (length < 40) return;
        const links = [...element.querySelectorAll("a")].reduce((sum, link) => sum + textLength(link), 0);
        const linkRatio = links / Math.max(1, length);
        const score = length * (type === "detail" ? Math.max(0.25, 1 - linkRatio * 0.8) : 1) * strength;
        candidates.push({ element, score, strength, source: selector });
      });
    };
    if (type === "detail") {
      const titleKey = normalize(document.title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      for (const heading of document.querySelectorAll("h1,h2")) {
        if (!visible(heading)) continue;
        const headingText = normalize(heading.innerText || heading.textContent || "");
        const headingKey = headingText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
        if (headingKey.length < 6) continue;
        const match = titleKey.includes(headingKey)
          ? headingKey.length / Math.max(headingKey.length, titleKey.length)
          : (headingKey.includes(titleKey) ? titleKey.length / headingKey.length : 0);
        if (match < 0.3) continue;
        let element = heading.parentElement;
        while (element && element !== document.body) {
          if (element.matches("article,main,section,div")) {
            const length = textLength(element);
            const paragraphChars = [...element.querySelectorAll("p")]
              .reduce((sum, paragraph) => sum + textLength(paragraph), 0);
            if (length >= 100 && paragraphChars >= 80) {
              const linkChars = [...element.querySelectorAll("a")].reduce((sum, link) => sum + textLength(link), 0);
              const linkRatio = linkChars / Math.max(1, length);
              const density = paragraphChars / Math.max(1, length);
              const score = 1_000_000 * match + paragraphChars * (1 + density) - linkRatio * 10_000 - length * 0.01;
              candidates.push({ element, score, strength: 10, source: "title-anchored" });
            }
          }
          element = element.parentElement;
        }
      }
    }
    if (type === "detail") {
      addCandidates("article,[itemprop='articleBody'],[data-testid*='article'],.article-content,.article_content,.article-body,.articleBody,.post-content,.entry-content,.content-article,#article-content,#articleContent", 4);
      addCandidates("main,[role='main'],#main,#content,.main-content,.main_content,.content", 1.5);
    } else {
      addCandidates("main,[role='main'],#main,#content,.main-content,.main_content,.page-content,.content", 2);
    }
    let jsonLd = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (queue.length) {
          const item = queue.shift();
          if (!item || typeof item !== "object") continue;
          if (Array.isArray(item)) queue.push(...item);
          else {
            const body = normalize(item.articleBody || item.text || "");
            if (body.length >= 100 && (!jsonLd || body.length > jsonLd.body.length)) {
              jsonLd = { body, headline: normalize(item.headline || item.name || "") };
            }
            if (item["@graph"]) queue.push(item["@graph"]);
          }
        }
      } catch (_error) {}
    }
    candidates.sort((left, right) => right.score - left.score);
    const root = candidates[0]?.element || document.body;
    const rootSource = candidates[0]?.source || "body";
    const rootKind = root === document.body
      ? "body"
      : (root.matches("article,[itemprop='articleBody']") ? "article" : root.tagName.toLowerCase());
    const rootText = normalize(root.innerText || root.textContent || "");
    const rootConfidence = jsonLd?.body || rootKind === "article"
      ? "high"
      : (root !== document.body && (
        root.matches("main,[role='main']")
        || candidates[0]?.source === "title-anchored"
        || (candidates[0]?.strength >= 4 && rootText.length >= 100)
        || rootText.length >= 200
      ) ? "medium" : "low");
    const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,td,th,dt,dd";
    const collectBlocks = (container, minimum, maximum) => {
      const values = [];
      const seen = new Set();
      for (const element of container.querySelectorAll(blockSelector)) {
        if (!visible(element)) continue;
        const text = normalize(element.innerText || element.textContent || "");
        if (text.length < minimum || text.length > 2_500 || seen.has(text)) continue;
        seen.add(text);
        values.push(text);
      }
      if (!values.length) {
        const text = normalize(container.innerText || container.textContent || "");
        if (text) values.push(text.slice(0, 10_000));
      }
      if (values.length <= maximum) return values;
      const sampled = [];
      for (let index = 0; index < maximum; index += 1) {
        sampled.push(values[Math.floor(index * (values.length - 1) / Math.max(1, maximum - 1))]);
      }
      return sampled;
    };
    let requiredBlocks = collectBlocks(root, type === "detail" ? 12 : 3, 120);
    if (jsonLd?.headline && !requiredBlocks.includes(jsonLd.headline)) requiredBlocks.unshift(jsonLd.headline);
    if (jsonLd?.body && (root === document.body || requiredBlocks.join(" ").length < 100)) {
      requiredBlocks = [jsonLd.headline, ...jsonLd.body.split(/(?<=[。！？!?])\s*/).filter(value => value.length >= 12)]
        .filter(Boolean)
        .slice(0, 120);
    }
    const noiseBlocks = [];
    const noiseSeen = new Set();
    for (const container of document.querySelectorAll("header,nav,footer,aside,[role='navigation'],[role='complementary']")) {
      if (root.contains(container) || container.contains(root) || !visible(container)) continue;
      for (const text of collectBlocks(container, 4, 15)) {
        if (!noiseSeen.has(text)) {
          noiseSeen.add(text);
          noiseBlocks.push(text);
        }
      }
    }
    const links = [];
    const linkSeen = new Set();
    for (const link of root.querySelectorAll("a[href]")) {
      const text = normalize(link.innerText || link.textContent || link.getAttribute("aria-label") || "");
      if (!text || text.length > 200 || !visible(link)) continue;
      let href = "";
      try { href = new URL(link.getAttribute("href"), document.baseURI).href; } catch (_error) {}
      const key = `${text}\n${href}`;
      if (!href || linkSeen.has(key)) continue;
      linkSeen.add(key);
      links.push({ text, href });
      if (links.length >= 150) break;
    }
    const images = [];
    const imageSeen = new Set();
    for (const image of root.querySelectorAll("img")) {
      let src = "";
      try {
        src = new URL(image.currentSrc || image.getAttribute("src") || image.getAttribute("data-src") || "", document.baseURI).href;
      } catch (_error) {}
      const alt = normalize(image.getAttribute("alt") || image.getAttribute("title") || "");
      const key = `${src}\n${alt}`;
      if ((!src && !alt) || imageSeen.has(key)) continue;
      imageSeen.add(key);
      images.push({ src, alt });
      if (images.length >= 100) break;
    }
    const discoveredLinks = [...document.querySelectorAll("a[href]")].map((link) => {
      try { return new URL(link.getAttribute("href"), document.baseURI).href; } catch (_error) { return ""; }
    }).filter(Boolean).slice(0, 3_000);
    const frozenDom = serializeFrozenDom();
    return {
      title: document.title,
      bodyText: normalize(document.body?.innerText || ""),
      html: frozenDom.html,
      discoveredLinks,
      runtime: {
        readyState: document.readyState,
        location: location.href,
        renderedStructure: renderedStructure(),
        resourceEntries: performance.getEntriesByType("resource").length,
        scriptElements: document.scripts.length,
        frozenDomVisitedElements: frozenDom.visitedElements,
        frozenDomHiddenRoots: frozenDom.hiddenRoots,
        frozenDomElapsedMs: frozenDom.elapsedMs,
      },
      reference: {
        method: jsonLd?.body && root === document.body ? "json-ld" : "independent-dom-root",
        confidence: rootConfidence,
        rootKind,
        rootSource,
        mainText: jsonLd?.body || rootText,
        requiredBlocks,
        noiseBlocks: noiseBlocks.slice(0, 80),
        links,
        images,
        structures: {
          headings: root.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").length,
          lists: root.querySelectorAll("ul,ol,dl").length,
          tables: root.querySelectorAll("table").length,
          codeBlocks: root.querySelectorAll("pre,code").length,
        },
      },
    };
  }, requestedType);
}

function captureFailureReason(status, title, text, finalUrl = "") {
  const normalizedTitle = normalizedText(title);
  const bodyText = normalizedText(text);
  const probe = normalizedText(`${title}\n${text}`).slice(0, 3_000);
  if (status >= 400) return `http_${status}`;
  let hostname = "";
  let pathname = "";
  try {
    const parsed = new URL(finalUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch (_error) {}
  const challengeUrl = /(?:^|[.-])(?:captcha|verify|challenge)(?:[.-]|$)/i.test(hostname)
    || /\/(?:captcha|verify|challenge)(?:[\/._-]|$)/i.test(pathname);
  const challengeCopy = /(?:安全验证|访问验证|验证中心|验证码|人机验证|滑动验证|拖动滑块|security verification|verify you are human|access denied|just a moment|请求异常|操作频繁|访问过于频繁)/i.test(probe);
  if ((challengeUrl && (challengeCopy || probe.length < 1_500))
    || (challengeCopy && probe.length < 1_500)) return "challenge";
  const loginUrl = /(?:^|[.-])(?:login|signin|passport|account)(?:[.-]|$)/i.test(hostname)
    || /(?:login|signin|passport|account)/i.test(pathname);
  const loginTitle = /^(?:会员)?登录(?:中心|页面)?$|^(?:扫码|账号|手机号|密码)登录$/i.test(normalizedText(title));
  const loginCopy = /(?:会员登录|扫码登录|账号登录|手机号登录|密码登录|登录注册|请登录|立即登录|登录后(?:查看|继续)|sign\s*in|log\s*in)/i.test(probe);
  if ((loginUrl && (loginTitle || loginCopy || bodyText.length < 1_500))
    || (loginTitle && probe.length < 1_500)) return "login_wall";
  const errorTitle = /(?:^|\b)404(?:\b|$)|页面(?:不存在|找不到)|哎呀.{0,8}出错|内容正在升级改造|服务暂不可用/i.test(normalizedTitle);
  if (errorTitle && bodyText.length < 2_500) return "error_shell";
  if (bodyText.length < 80) return "insufficient_content";
  return "";
}

async function captureOne(page, entry, outputDir, screenshots) {
  const started = performance.now();
  let response = null;
  try {
    response = await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const captured = await captureConsistentPage(page, entry.type, screenshots);
    const inspected = captured.inspected;
    const finalUrl = captured.state?.url || inspected.runtime.location || page.url();
    const status = response?.status() || 0;
    const reason = captureFailureReason(status, inspected.title, inspected.bodyText, finalUrl);
    const frozenDomSha256 = sha256(inspected.html);
    const base = {
      ...entry,
      requestedUrl: entry.url,
      finalUrl,
      title: inspected.title,
      status,
      elapsedMs: Math.round(performance.now() - started),
      visibleChars: inspected.bodyText.length,
      discoveredLinks: inspected.discoveredLinks,
      captureEvidence: {
        source: "chromium-live-page",
        serializedFrom: "detached document clone with computed visibility frozen",
        frozenDomSha256,
        frozenDomChars: inspected.html.length,
        consistencyAttempts: captured.attempts,
        contentStable: captured.consistent,
        ...inspected.runtime,
      },
    };
    if (captured.failure) {
      const error = new Error(captured.error || captured.failure);
      error.captureFailure = captured.failure;
      throw error;
    }
    if (!captured.consistent) return { ...base, ok: false, failure: "unstable_content" };
    if (reason) return { ...base, ok: false, failure: reason };
    const html = withBase(sanitizeSnapshotHtml(inspected.html), finalUrl);
    const inputSha256 = sha256(html);
    const fileName = `${entry.siteId}-${inputSha256.slice(0, 16)}.html`;
    const snapshotPath = join(outputDir, "snapshots", fileName);
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, html);
    let screenshot = "";
    let screenshotSha256 = "";
    if (screenshots) {
      const screenshotPath = join(outputDir, "screenshots", fileName.replace(/\.html$/, ".jpg"));
      mkdirSync(dirname(screenshotPath), { recursive: true });
      writeFileSync(screenshotPath, captured.screenshot);
      screenshot = relative(outputDir, screenshotPath);
      screenshotSha256 = sha256(captured.screenshot);
    }
    return {
      ...base,
      ok: true,
      inputSha256,
      snapshot: relative(outputDir, snapshotPath),
      screenshot,
      screenshotSha256,
      reference: inspected.reference,
    };
  } catch (error) {
    return {
      ...entry,
      requestedUrl: entry.url,
      finalUrl: page.url(),
      ok: false,
      failure: error?.captureFailure || (error?.name === "TimeoutError" ? "timeout" : "network_error"),
      error: `${error?.name || "Error"}: ${error?.message || error}`,
      elapsedMs: Math.round(performance.now() - started),
      discoveredLinks: [],
    };
  }
}

async function mapConcurrent(items, workers, task) {
  const results = new Array(items.length);
  let cursor = 0;
  async function work() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, work));
  return results;
}

function siteCaptureEntry(site, entry) {
  return {
    ...entry,
    siteId: site.id,
    siteName: site.name,
    vertical: site.vertical,
    ...(site.evaluationSplit ? { evaluationSplit: site.evaluationSplit } : {}),
    ...(site.siteFamily ? { siteFamily: site.siteFamily } : {}),
    ...(site.discoveredType ? { discoveredType: site.discoveredType } : {}),
  };
}

function buildReplacementPlan(config) {
  if (!config.strictSiteQuotas || !Array.isArray(config.sites) || !config.sites.length) return null;
  const cells = new Map();
  for (const site of config.sites) {
    const evaluationSplit = String(site.evaluationSplit || "").trim();
    const vertical = String(site.vertical || "").trim();
    const discoveredType = String(site.discoveredType || "").trim();
    const quota = Number(site.quota || config.samplesPerSite || 0);
    if (!evaluationSplit || !vertical || !discoveredType || !Number.isInteger(quota) || quota <= 0) return null;
    const key = JSON.stringify([evaluationSplit, vertical, discoveredType]);
    const current = cells.get(key) || { evaluationSplit, vertical, discoveredType, quota: 0 };
    current.quota += quota;
    cells.set(key, current);
  }
  return {
    dimensions: ["evaluationSplit", "vertical", "discoveredType"],
    cells: [...cells.values()].sort((left, right) => {
      const leftKey = JSON.stringify([left.evaluationSplit, left.vertical, left.discoveredType]);
      const rightKey = JSON.stringify([right.evaluationSplit, right.vertical, right.discoveredType]);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
}

async function captureCore(config, outputDir, workers, screenshots, {
  completedSites = new Map(),
  onSiteComplete = async () => {},
} = {}) {
  const browser = await chromium.launch({ headless: !flag("--headed") });
  try {
    const siteResults = new Array(config.sites.length);
    for (const [siteIndex, result] of completedSites) siteResults[siteIndex] = result;
    const pendingSites = config.sites
      .map((site, siteIndex) => ({ site, siteIndex }))
      .filter(({ siteIndex }) => !completedSites.has(siteIndex));
    await mapConcurrent(pendingSites, workers, async ({ site, siteIndex }) => {
      const context = await browser.newContext({
        viewport: { width: 1365, height: 900 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        ignoreHTTPSErrors: true,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
      });
      let result;
      try {
        await context.route("**/*", async (route) => {
          if (["font", "media"].includes(route.request().resourceType())) await route.abort();
          else await route.continue();
        });
        const page = await context.newPage();
        const quota = Number(site.quota || config.samplesPerSite || 12);
        const successes = [];
        const failures = [];
        const usedUrls = new Set();
        const attemptedUrls = new Set();
        const usedDigests = new Set();
        const candidates = [];
        const candidateSeen = new Set();
        const accept = (captured) => {
          const url = canonicalUrl(captured.finalUrl || captured.requestedUrl);
          if (!captured.ok) {
            failures.push(captured);
            return false;
          }
          if ((config.strictSiteQuotas && successes.length >= quota)
            || usedUrls.has(url)
            || usedDigests.has(captured.inputSha256)) return false;
          usedUrls.add(url);
          usedDigests.add(captured.inputSha256);
          successes.push(captured);
          return true;
        };
        for (const seed of site.seeds) {
          if (config.strictSiteQuotas && successes.length >= quota) break;
          const captured = await captureOne(page, siteCaptureEntry(site, seed), outputDir, screenshots);
          attemptedUrls.add(canonicalUrl(seed.url));
          attemptedUrls.add(canonicalUrl(captured.finalUrl || captured.requestedUrl));
          accept(captured);
          for (const value of captured.discoveredLinks || []) {
            const url = canonicalUrl(value);
            if (!url || candidateSeen.has(url) || !sameHost(url, site.hosts) || !matchesDetail(url, site.detailPatterns || [])) continue;
            candidateSeen.add(url);
            candidates.push(url);
          }
        }
        const candidateAttempts = evenlySample(candidates, Math.max(16, quota * 5));
        for (const url of candidateAttempts) {
          if (successes.length >= quota) break;
          if (attemptedUrls.has(url)) continue;
          attemptedUrls.add(url);
          accept(await captureOne(page, siteCaptureEntry(site, {
            type: site.discoveredType || "detail",
            url,
          }), outputDir, screenshots));
        }
        result = { site, quota, successes, failures, reserveUrls: candidateAttempts.filter(url => !attemptedUrls.has(url)) };
      } finally {
        await context.close();
      }
      siteResults[siteIndex] = result;
      await onSiteComplete(siteIndex, result);
      console.log(`capture ${siteIndex + 1}/${config.sites.length} ${site.id}: ${result.successes.length}/${result.quota} (${result.failures.length} failed)`);
    });

    const successes = siteResults.flatMap(result => result.successes);
    const failures = siteResults.flatMap(result => result.failures);
    const target = Number(config.sampleTarget || successes.length);
    if (!config.strictSiteQuotas && successes.length < target) {
      const shortage = target - successes.length;
      const overflow = [];
      const maxReserve = Math.max(shortage * 3, shortage + 20);
      let round = 0;
      while (overflow.length < maxReserve) {
        let added = false;
        for (const result of siteResults) {
          const url = result.reserveUrls[round];
          if (!url) continue;
          overflow.push(siteCaptureEntry(result.site, {
            type: result.site.discoveredType || "detail",
            url,
          }));
          added = true;
          if (overflow.length >= maxReserve) break;
        }
        if (!added) break;
        round += 1;
      }
      const extra = await mapConcurrent(overflow, workers, async (entry) => {
        const context = await browser.newContext({
          viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", ignoreHTTPSErrors: true,
        });
        try {
          await context.route("**/*", async route => ["font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue());
          const page = await context.newPage();
          return await captureOne(page, entry, outputDir, screenshots);
        } finally {
          await context.close();
        }
      });
      const usedUrls = new Set(successes.map(item => canonicalUrl(item.finalUrl)));
      const usedDigests = new Set(successes.map(item => item.inputSha256));
      for (const captured of extra) {
        if (!captured.ok) {
          failures.push(captured);
          continue;
        }
        const url = canonicalUrl(captured.finalUrl);
        if (usedUrls.has(url) || usedDigests.has(captured.inputSha256)) continue;
        usedUrls.add(url);
        usedDigests.add(captured.inputSha256);
        successes.push(captured);
        if (successes.length >= target) break;
      }
    }
    return { samples: successes.slice(0, target), failures, target };
  } finally {
    await browser.close();
  }
}

const CAPTURE_CHECKPOINT_SCHEMA = "qingzhou.article-extraction-capture-checkpoint.v1";

function captureCheckpointIdentity(configPath, config, suite, screenshots) {
  return {
    schema: CAPTURE_CHECKPOINT_SCHEMA,
    suite,
    configSha256: sha256(readFileSync(configPath)),
    effectivePlanSha256: sha256(JSON.stringify(config)),
    screenshots,
  };
}

function validateCheckpointResult(result, site, siteIndex, config, outputDir, screenshots) {
  if (!result || sha256(JSON.stringify(result.site)) !== sha256(JSON.stringify(site))) {
    throw new Error(`capture checkpoint site ${siteIndex + 1} does not match ${site.id}`);
  }
  const quota = Number(site.quota || config.samplesPerSite || 12);
  if (result.quota !== quota
    || !Array.isArray(result.successes)
    || !Array.isArray(result.failures)
    || !Array.isArray(result.reserveUrls)) {
    throw new Error(`capture checkpoint site ${site.id} has an invalid result`);
  }
  if (config.strictSiteQuotas && result.successes.length > quota) {
    throw new Error(`capture checkpoint site ${site.id} exceeds its strict quota`);
  }
  for (const sample of result.successes) {
    if (sample.siteId !== site.id
      || (site.evaluationSplit && sample.evaluationSplit !== site.evaluationSplit)
      || (site.siteFamily && sample.siteFamily !== site.siteFamily)
      || (site.discoveredType && sample.discoveredType !== site.discoveredType)) {
      throw new Error(`capture checkpoint site ${site.id} sample metadata mismatch`);
    }
    const snapshot = corpusAssetPath(outputDir, sample.snapshot, `capture checkpoint site ${site.id} snapshot`);
    if (!/^[a-f0-9]{64}$/.test(String(sample.inputSha256 || "").toLowerCase())
      || sha256(readFileSync(snapshot)) !== String(sample.inputSha256).toLowerCase()) {
      throw new Error(`capture checkpoint site ${site.id} snapshot digest mismatch`);
    }
    if (!canonicalUrl(sample.finalUrl || sample.requestedUrl)) {
      throw new Error(`capture checkpoint site ${site.id} sample has no canonical URL`);
    }
    if (screenshots) {
      const screenshot = corpusAssetPath(outputDir, sample.screenshot, `capture checkpoint site ${site.id} screenshot`);
      const screenshotSha256 = String(sample.screenshotSha256 || "").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(screenshotSha256)
        || sha256(readFileSync(screenshot)) !== screenshotSha256) {
        throw new Error(`capture checkpoint site ${site.id} screenshot digest mismatch`);
      }
    } else if (sample.screenshot || sample.screenshotSha256) {
      throw new Error(`capture checkpoint site ${site.id} screenshot mode mismatch`);
    }
  }
  return result;
}

function loadCaptureCheckpoint(path, identity, config, outputDir) {
  if (!existsSync(path)) throw new Error(`capture resume checkpoint does not exist: ${path}`);
  const checkpoint = json(path);
  for (const key of ["schema", "suite", "configSha256", "effectivePlanSha256", "screenshots"]) {
    if (checkpoint[key] !== identity[key]) throw new Error(`capture checkpoint ${key} does not match this run`);
  }
  if (!Array.isArray(checkpoint.completedSites)) throw new Error("capture checkpoint has no completedSites array");
  const completedSites = new Map();
  for (const entry of checkpoint.completedSites) {
    const siteIndex = Number(entry?.siteIndex);
    const site = config.sites[siteIndex];
    if (!Number.isInteger(siteIndex) || !site || completedSites.has(siteIndex)) {
      throw new Error(`capture checkpoint has an invalid or duplicate site index: ${entry?.siteIndex}`);
    }
    if (entry.siteId !== site.id || entry.sitePlanSha256 !== sha256(JSON.stringify(site))) {
      throw new Error(`capture checkpoint site plan does not match ${site.id}`);
    }
    completedSites.set(siteIndex, validateCheckpointResult(
      entry.result,
      site,
      siteIndex,
      config,
      outputDir,
      identity.screenshots,
    ));
  }
  return { checkpoint, completedSites };
}

async function captureCommand() {
  const suite = option("--suite", "core");
  if (suite !== "core") throw new Error(`unsupported capture suite: ${suite}`);
  const configPath = resolve(option("--config", join(here, "chinese-realworld-sites.json")));
  const outputDir = resolve(option("--output", join(defaultResults, "zh-core-v1")));
  const workers = numberOption("--workers", 6);
  const config = json(configPath);
  const site = option("--site", "");
  if (site && Array.isArray(config.sites)) {
    config.sites = config.sites.filter(item => item.id === site);
    config.sampleTarget = config.sites.reduce((sum, item) => sum + Number(item.quota || config.samplesPerSite || 12), 0);
  }
  const target = Number(option("--target", ""));
  if (Number.isFinite(target) && target > 0) config.sampleTarget = Math.floor(target);
  mkdirSync(outputDir, { recursive: true });
  const screenshots = flag("--screenshots");
  const checkpointPath = join(outputDir, ".capture-checkpoint.json");
  const checkpointIdentity = captureCheckpointIdentity(configPath, config, suite, screenshots);
  let checkpoint;
  let completedSites;
  if (flag("--resume")) {
    ({ checkpoint, completedSites } = loadCaptureCheckpoint(checkpointPath, checkpointIdentity, config, outputDir));
  } else {
    if (existsSync(checkpointPath)) {
      throw new Error(`capture checkpoint already exists; pass --resume to continue it: ${checkpointPath}`);
    }
    checkpoint = { ...checkpointIdentity, startedAt: new Date().toISOString(), completedSites: [] };
    completedSites = new Map();
    writeJsonAtomic(checkpointPath, checkpoint);
  }
  const result = await captureCore(config, outputDir, workers, screenshots, {
    completedSites,
    onSiteComplete: async (siteIndex, siteResult) => {
      const entry = {
        siteIndex,
        siteId: config.sites[siteIndex].id,
        sitePlanSha256: sha256(JSON.stringify(config.sites[siteIndex])),
        result: siteResult,
      };
      const existing = checkpoint.completedSites.findIndex(item => item.siteIndex === siteIndex);
      if (existing >= 0) checkpoint.completedSites[existing] = entry;
      else checkpoint.completedSites.push(entry);
      checkpoint.completedSites.sort((left, right) => left.siteIndex - right.siteIndex);
      writeJsonAtomic(checkpointPath, checkpoint);
    },
  });
  const idWidth = Math.max(4, String(result.target).length);
  const replacementPlan = buildReplacementPlan(config);
  const manifest = {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite,
    capturedAt: new Date().toISOString(),
    config: relative(root, configPath),
    environment: {
      viewport: { width: 1365, height: 900 },
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      capture: {
        source: "playwright-chromium-live-dom",
        javascriptEnabled: true,
        networkEnabled: true,
        blockedResourceTypes: ["font", "media"],
        settle: {
          ...captureSettlePolicy,
          stableRenderedPageObservations: 2,
          scrollCollectionPages: true,
        },
        consistency: "retry when URL, complete rendered text, or structural counts change during capture",
        serialization: "detached document clone after hydration with computed visibility frozen",
      },
      browser: await chromium.launch({ headless: true }).then(async browser => {
        const version = browser.version();
        await browser.close();
        return version;
      }),
    },
    target: result.target,
    captured: result.samples.length,
    samples: result.samples.map((sample, index) => ({ ...sample, id: `${suite}-${String(index + 1).padStart(idWidth, "0")}` })),
    failures: result.failures,
    catalog: result.catalog || null,
    ...(replacementPlan ? { replacementPlan } : {}),
  };
  writeJsonAtomic(join(outputDir, "manifest.json"), manifest);
  rmSync(checkpointPath, { force: true });
  console.log(JSON.stringify({ outputDir, target: manifest.target, captured: manifest.captured, failures: manifest.failures.length }, null, 2));
  if (suite === "core" && manifest.captured < manifest.target) process.exitCode = 2;
}

function readCorpus(value, role, label) {
  if (!value) throw new Error(`compose requires ${label} <corpus-directory>`);
  const corpusDir = resolve(value);
  const manifestPath = join(corpusDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`${label} has no manifest.json: ${corpusDir}`);
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (!Number.isInteger(manifest.target) || manifest.target <= 0) {
    throw new Error(`${label} manifest has an invalid target`);
  }
  if (!Array.isArray(manifest.samples)) throw new Error(`${label} manifest has no samples array`);
  return { role, label, corpusDir, manifest, manifestSha256: sha256(manifestBytes) };
}

function readCorpusOption(name) {
  return readCorpus(option(name), name.slice(2), name);
}

function sampleCanonicalUrl(sample) {
  return canonicalUrl(sample.finalUrl || sample.url || sample.requestedUrl || "");
}

function corpusAssetPath(corpusDir, value, label) {
  if (!value || typeof value !== "string") throw new Error(`${label} is missing`);
  const path = resolve(corpusDir, value);
  if (path !== corpusDir && !path.startsWith(`${corpusDir}${sep}`)) {
    throw new Error(`${label} escapes its corpus directory`);
  }
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${value}`);
  return path;
}

function copyContentAddressedAsset(source, outputDir, folder, extension, expectedSha256 = "") {
  const bytes = readFileSync(source);
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== String(expectedSha256).toLowerCase()) {
    throw new Error(`snapshot digest mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  const target = join(outputDir, folder, `${digest}${extension}`);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  return relative(outputDir, target);
}

function sourceProvenance(source) {
  const manifest = source.manifest;
  return {
    role: source.role,
    manifestSha256: source.manifestSha256,
    schema: manifest.schema,
    suite: manifest.suite,
    target: manifest.target,
    captured: manifest.samples.length,
    capturedAt: manifest.capturedAt || null,
    sanitizedAt: manifest.sanitizedAt || null,
    annotatedAt: manifest.annotatedAt || null,
    config: manifest.config || null,
    environment: manifest.environment || null,
    catalog: manifest.catalog || null,
    provenance: manifest.provenance || null,
    ...(manifest.replacementPlan ? { replacementPlan: manifest.replacementPlan } : {}),
  };
}

function replacementCell(value, label) {
  const evaluationSplit = String(value?.evaluationSplit || "").trim();
  const vertical = String(value?.vertical || "").trim();
  const discoveredType = String(value?.discoveredType || "").trim();
  if (!evaluationSplit || !vertical || !discoveredType) {
    throw new Error(`${label} is missing evaluationSplit, vertical, or discoveredType`);
  }
  return {
    key: JSON.stringify([evaluationSplit, vertical, discoveredType]),
    evaluationSplit,
    vertical,
    discoveredType,
  };
}

function parseReplacementPlan(manifest) {
  const plan = manifest.replacementPlan;
  if (!plan) return null;
  if (JSON.stringify(plan.dimensions) !== JSON.stringify(["evaluationSplit", "vertical", "discoveredType"])
    || !Array.isArray(plan.cells)
    || !plan.cells.length) {
    throw new Error("increment replacementPlan has an invalid cell contract");
  }
  const cells = new Map();
  let total = 0;
  for (const [index, value] of plan.cells.entries()) {
    const cell = replacementCell(value, `increment replacementPlan cell ${index + 1}`);
    const quota = Number(value.quota);
    if (!Number.isInteger(quota) || quota <= 0 || cells.has(cell.key)) {
      throw new Error(`increment replacementPlan cell ${index + 1} has an invalid quota or duplicate identity`);
    }
    cells.set(cell.key, { ...cell, quota });
    total += quota;
  }
  if (total !== manifest.target) {
    throw new Error(`increment replacementPlan totals ${total} pages but its manifest target is ${manifest.target}`);
  }
  return { dimensions: plan.dimensions, cells };
}

function composeEntries(source) {
  return source.manifest.samples.map(sample => {
    const url = sampleCanonicalUrl(sample);
    const inputSha256 = String(sample.inputSha256 || "").toLowerCase();
    if (!url) throw new Error(`${source.label} sample ${sample.id || "<unknown>"} has no canonical URL`);
    if (!/^[a-f0-9]{64}$/.test(inputSha256)) {
      throw new Error(`${source.label} sample ${sample.id || "<unknown>"} has an invalid inputSha256`);
    }
    return { source, sample, url };
  });
}

function composeExactIdentity(entry) {
  const snapshot = corpusAssetPath(
    entry.source.corpusDir,
    entry.sample.snapshot,
    `${entry.source.label} sample ${entry.sample.id || "<unknown>"} snapshot`,
  );
  const bytes = readFileSync(snapshot);
  const inputDom = String(entry.sample.inputSha256).toLowerCase();
  if (sha256(bytes) !== inputDom) {
    throw new Error(`${entry.source.label} sample ${entry.sample.id || "<unknown>"} snapshot digest mismatch`);
  }
  const text = normalizeSnapshotText(bytes.toString("utf8"));
  return {
    inputDom,
    frozenDom: String(entry.sample.captureEvidence?.frozenDomSha256 || "").toLowerCase(),
    normalizedText: text ? sha256(text) : "",
  };
}

function selectCellAwareComposeEntries(base, increment, supplements, replacementPlan, entriesBySource) {
  const selected = [];
  const seenUrls = new Set();
  const seenExact = {
    inputDom: new Set(),
    frozenDom: new Set(),
    normalizedText: new Set(),
  };
  const exactDuplicatesSkipped = {
    canonicalUrl: 0,
    inputDom: 0,
    frozenDom: 0,
    normalizedText: 0,
  };
  const select = (entry, preserveBase = false) => {
    const identity = composeExactIdentity(entry);
    if (!preserveBase) {
      const duplicateReasons = [
        ["canonicalUrl", entry.url && seenUrls.has(entry.url)],
        ...Object.keys(seenExact).map(name => [name, identity[name] && seenExact[name].has(identity[name])]),
      ].filter(([, duplicate]) => duplicate);
      if (duplicateReasons.length) {
        for (const [name] of duplicateReasons) exactDuplicatesSkipped[name] += 1;
        return false;
      }
    }
    if (entry.url) seenUrls.add(entry.url);
    for (const name of Object.keys(seenExact)) {
      if (identity[name]) seenExact[name].add(identity[name]);
    }
    selected.push(entry);
    return true;
  };

  const baseEntries = entriesBySource.get(base);
  if (baseEntries.length < base.manifest.target) {
    throw new Error(`compose base target is ${base.manifest.target} but its manifest contains only ${baseEntries.length} samples`);
  }
  for (const entry of baseEntries.slice(0, base.manifest.target)) select(entry, true);

  const remaining = new Map([...replacementPlan.cells].map(([key, cell]) => [key, cell.quota]));
  const selectedBySource = new Map();
  const consider = entry => {
    const cell = replacementCell(entry.sample, `${entry.source.label} sample ${entry.sample.id || "<unknown>"}`);
    if (!remaining.has(cell.key)) {
      throw new Error(`${entry.source.label} sample ${entry.sample.id || "<unknown>"} is outside the increment replacementPlan`);
    }
    if (remaining.get(cell.key) <= 0 || !select(entry)) return;
    remaining.set(cell.key, remaining.get(cell.key) - 1);
    selectedBySource.set(entry.source.role, (selectedBySource.get(entry.source.role) || 0) + 1);
  };

  for (const entry of entriesBySource.get(increment)) consider(entry);
  for (const supplement of supplements) {
    if (![...remaining.values()].some(Boolean)) break;
    for (const entry of entriesBySource.get(supplement)) consider(entry);
  }

  const shortages = [...remaining]
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ ...replacementPlan.cells.get(key), missing: count }));
  if (shortages.length) {
    const details = shortages.map(cell => (
      `${cell.evaluationSplit}/${cell.vertical}/${cell.discoveredType}: ${cell.missing}`
    )).join(", ");
    throw new Error(`compose supplements cannot fill increment replacement cells (${details})`);
  }
  return {
    entries: selected,
    selection: {
      mode: "replacement-cell",
      dimensions: replacementPlan.dimensions,
      selectedBySource: Object.fromEntries(selectedBySource),
      exactDuplicatesSkipped,
    },
  };
}

function composeCommand() {
  const base = readCorpusOption("--base");
  const increment = readCorpusOption("--increment");
  const supplements = repeatedOption("--supplement").map((value, index) => (
    readCorpus(value, `supplement-${index + 1}`, `--supplement #${index + 1}`)
  ));
  const sources = [base, increment, ...supplements];
  const outputValue = option("--output");
  if (!outputValue) throw new Error("compose requires --output <corpus-directory>");
  const outputDir = resolve(outputValue);
  if (sources.some(source => outputDir === source.corpusDir)) {
    throw new Error("compose output must differ from every input corpus directory");
  }
  if (existsSync(outputDir)) throw new Error(`compose output already exists: ${outputDir}`);
  if (sources.some(source => (
    source.manifest.schema !== base.manifest.schema || source.manifest.suite !== base.manifest.suite
  ))) {
    throw new Error("compose inputs must use the same corpus schema and suite");
  }

  const target = base.manifest.target + increment.manifest.target;
  const entriesBySource = new Map(sources.map(source => [source, composeEntries(source)]));
  const replacementPlan = parseReplacementPlan(increment.manifest);
  let selection = null;
  let selectedEntries;
  if (replacementPlan) {
    ({ entries: selectedEntries, selection } = selectCellAwareComposeEntries(
      base,
      increment,
      supplements,
      replacementPlan,
      entriesBySource,
    ));
  } else {
    const seen = new Set();
    selectedEntries = [];
    for (const source of sources) {
      for (const entry of entriesBySource.get(source)) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        selectedEntries.push(entry);
      }
    }
    if (selectedEntries.length < target) {
      throw new Error(`compose needs ${target} unique canonical URLs but inputs provide only ${selectedEntries.length}`);
    }
    selectedEntries = selectedEntries.slice(0, target);
  }

  mkdirSync(dirname(outputDir), { recursive: true });
  const temporaryDir = mkdtempSync(`${outputDir}.compose-`);
  try {
    const idWidth = Math.max(4, String(target).length);
    const samples = selectedEntries.map(({ source, sample }, index) => {
      const snapshotSource = corpusAssetPath(source.corpusDir, sample.snapshot, `${source.role} sample snapshot`);
      const snapshot = copyContentAddressedAsset(
        snapshotSource,
        temporaryDir,
        "snapshots",
        ".html",
        sample.inputSha256,
      );
      let screenshot = "";
      if (sample.screenshot) {
        const screenshotSource = corpusAssetPath(source.corpusDir, sample.screenshot, `${source.role} sample screenshot`);
        screenshot = copyContentAddressedAsset(
          screenshotSource,
          temporaryDir,
          "screenshots",
          extname(screenshotSource).toLowerCase() || ".jpg",
        );
      }
      return {
        ...sample,
        id: `${base.manifest.suite}-${String(index + 1).padStart(idWidth, "0")}`,
        inputSha256: String(sample.inputSha256).toLowerCase(),
        snapshot,
        screenshot,
      };
    });
    const capturedAt = sources.map(source => source.manifest.capturedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const manifest = {
      schema: base.manifest.schema,
      suite: base.manifest.suite,
      capturedAt,
      target,
      captured: samples.length,
      samples,
      failures: [
        ...sources.flatMap(source => (Array.isArray(source.manifest.failures) ? source.manifest.failures : [])),
      ],
      provenance: {
        kind: "composed-corpus",
        identity: "canonical-final-url",
        sources: sources.map(sourceProvenance),
        ...(selection ? { selection } : {}),
      },
    };
    writeJson(join(temporaryDir, "manifest.json"), manifest);
    renameSync(temporaryDir, outputDir);
    console.log(JSON.stringify({ outputDir, target, captured: samples.length, failures: manifest.failures.length }, null, 2));
  } catch (error) {
    rmSync(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

function sanitizeCommand() {
  const corpusDir = resolve(option("--corpus", join(defaultResults, "zh-core-v1")));
  const manifestPath = resolve(option("--manifest", join(corpusDir, "manifest.json")));
  const manifest = json(manifestPath);
  let changed = 0;
  for (const sample of manifest.samples || []) {
    const currentPath = resolve(corpusDir, sample.snapshot);
    const sanitized = sanitizeSnapshotHtml(readFileSync(currentPath, "utf8"));
    const inputSha256 = sha256(sanitized);
    if (inputSha256 === sample.inputSha256) continue;
    const nextPath = join(corpusDir, "snapshots", `${sample.siteId}-${inputSha256.slice(0, 16)}.html`);
    writeFileSync(nextPath, sanitized);
    sample.snapshot = relative(corpusDir, nextPath);
    sample.inputSha256 = inputSha256;
    changed += 1;
  }
  manifest.sanitizedAt = new Date().toISOString();
  writeJson(manifestPath, manifest);
  console.log(JSON.stringify({ manifest: manifestPath, samples: manifest.samples.length, changed }, null, 2));
}

async function annotateCommand() {
  const corpusDir = resolve(option("--corpus", join(defaultResults, "zh-core-v1")));
  const manifestPath = resolve(option("--manifest", join(corpusDir, "manifest.json")));
  const workers = numberOption("--workers", 6);
  const manifest = json(manifestPath);
  const browser = await chromium.launch({ headless: true });
  let cursor = 0;
  async function work() {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.route("**/*", async route => (
      route.request().url().startsWith("file:") ? route.continue() : route.abort()
    ));
    const page = await context.newPage();
    for (;;) {
      const index = cursor++;
      if (index >= manifest.samples.length) break;
      const sample = manifest.samples[index];
      await page.goto(pathToFileURL(resolve(corpusDir, sample.snapshot)).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      sample.reference = (await inspectPage(page, sample.type)).reference;
      if ((index + 1) % 25 === 0) console.log(`annotate ${index + 1}/${manifest.samples.length}`);
    }
    await context.close();
  }
  await Promise.all(Array.from({ length: Math.min(workers, manifest.samples.length) }, work));
  await browser.close();
  manifest.annotatedAt = new Date().toISOString();
  writeJson(manifestPath, manifest);
  console.log(JSON.stringify({
    manifest: manifestPath,
    samples: manifest.samples.length,
    confidence: Object.fromEntries(["high", "medium", "low"].map(value => [value, manifest.samples.filter(item => item.reference?.confidence === value).length])),
  }, null, 2));
}

async function initScripts({ defuddleBundle = "" } = {}) {
  const extensionDir = await ensureTestExtension();
  const upstream = await prepareUpstreamArticleAssets();
  const files = [
    upstream.readability, upstream.turndown, upstream.gfm,
    join(extensionDir, "content/article-extractor.js"),
    join(extensionDir, "content/content-script.js"), upstream.marked,
  ];
  const prelude = `
    globalThis.__qingzhouBenchmarkListener = null;
    const runtime = {
      getManifest: () => ({ name: "Qingzhou Benchmark", version: "0.0.0" }),
      onMessage: { addListener(listener) { globalThis.__qingzhouBenchmarkListener = listener; } },
      sendMessage: async () => ({ ok: true }),
    };
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: { runtime } });
    globalThis.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      const listener = globalThis.__qingzhouBenchmarkListener;
      if (typeof listener !== "function") return reject(new Error("content script listener is unavailable"));
      try { listener({ action, ...params }, {}, resolve); } catch (error) { reject(error); }
    });
  `;
  const trailer = `
    globalThis.__benchmarkMarkdown = (content) => {
      try {
        const service = new TurndownService({
          headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced", fence: String.fromCharCode(96).repeat(3), linkStyle: "inlined",
        });
        service.use(turndownPluginGfm.gfm);
        return service.turndown(content || "");
      } catch (_error) { return ""; }
    };
  `;
  // Upstream comparators install test-only globals; product entries remain self-contained.
  return [
    prelude,
    ...files.map(file => {
      const original = readFileSync(file, "utf8");
      return file === join(extensionDir, "content/article-extractor.js")
        ? instrumentArticleExtractorSource(original)
        : file === join(extensionDir, "content/content-script.js")
          ? instrumentContentScriptSource(original)
          : original;
    }),
    ...(defuddleBundle ? [readFileSync(defuddleBundle, "utf8")] : []),
    trailer,
  ];
}

async function assertBenchmarkRuntime(page, { defuddle = false, nativeDefuddleMarkdown = false } = {}) {
  const state = await page.evaluate(() => ({
    readability: typeof globalThis.Readability,
    turndown: typeof globalThis.TurndownService,
    gfm: typeof globalThis.turndownPluginGfm?.gfm,
    marked: typeof globalThis.marked?.parse,
    listener: typeof globalThis.__qingzhouBenchmarkListener,
    internalCandidates: typeof globalThis.__qingzhouArticleBenchmark?.collect,
    extractSourceText: typeof globalThis.__qingzhouArticleBenchmark?.lastExtractText,
    productArticleSerializer: typeof globalThis.__qingzhouContentBenchmark?.serializeArticleContent,
    defuddle: typeof globalThis.Defuddle,
    defuddleMarkdown: typeof globalThis.Defuddle?.createMarkdownContent,
  }));
  const required = [
    "readability",
    "turndown",
    "gfm",
    "marked",
    "listener",
    "internalCandidates",
    "extractSourceText",
    "productArticleSerializer",
    ...(defuddle ? ["defuddle"] : []),
    ...(nativeDefuddleMarkdown ? ["defuddleMarkdown"] : []),
  ];
  const missing = required.filter(name => state[name] !== "function");
  if (missing.length) throw new Error(`benchmark runtime is incomplete: ${missing.join(", ")}`);
}

async function createRunContext(browser, scripts) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai",
  });
  for (const content of scripts) await context.addInitScript({ content });
  await context.route("**/*", async route => (
    route.request().url().startsWith("file:") ? route.continue() : route.abort()
  ));
  return context;
}

async function readCurrent(page, { source = "auto", maxChunks = 30 } = {}) {
  await page.evaluate(() => globalThis.__qingzhouArticleBenchmark.clearLastExtractText());
  const chunks = [];
  const chunkEnds = [];
  let offset = 0;
  let first = null;
  let last = null;
  for (let index = 0; index < maxChunks; index += 1) {
    const result = await page.evaluate(({ nextOffset, nextSource }) => globalThis.__callQingzhouContent("readArticle", {
      source: nextSource, offset: nextOffset, limit: 20_000,
    }), { nextOffset: offset, nextSource: source });
    if (result?.error) throw new Error(result.error);
    if (!first) first = result;
    last = result;
    chunks.push(String(result?.text || ""));
    chunkEnds.push((chunkEnds.at(-1) || 0) + chunks.at(-1).length);
    if (!result?.hasMore || result.nextOffset == null || result.nextOffset <= offset) break;
    offset = result.nextOffset;
  }
  const markdown = chunks.join("");
  const rendered = await page.evaluate(value => {
    try {
      const html = globalThis.marked.parse(value, { gfm: true, breaks: true });
      const doc = new DOMParser().parseFromString(html, "text/html");
      return String(doc.body?.innerText || doc.body?.textContent || "");
    } catch (_error) {
      return value;
    }
  }, markdown);
  const sourceText = await page.evaluate(() => globalThis.__qingzhouArticleBenchmark.lastExtractText());
  return {
    ...first,
    markdown,
    text: rendered,
    sourceText,
    chunks: chunks.length,
    chunkEnds,
    truncated: Boolean(last?.hasMore),
  };
}

async function readInternalCandidates(page, { candidateProvenance = false } = {}) {
  const summary = await page.evaluate((provenance) => {
    return globalThis.__qingzhouArticleBenchmark.collect(document, { provenance });
  }, candidateProvenance);
  if (candidateProvenance) {
    const provenance = summary?.diagnostics?.provenance;
    if (summary?.diagnostics?.candidateProvenanceEnabled !== true
      || provenance?.schema !== "qingzhou.article-extraction-provenance.v1"
      || !Array.isArray(provenance?.sourceTree?.elements)
      || !Array.isArray(provenance?.sourceTree?.textUnits)
      || !Array.isArray(provenance?.sourceTree?.treeElements)
      || !Array.isArray(summary?.candidates)
      || !provenance?.candidates
      || typeof provenance.candidates !== "object"
      || INTERNAL_CANDIDATE_KEYS.some(key => (
        provenance.candidates[key]?.schema !== "qingzhou.article-extraction-candidate-provenance.v1"
      ))) {
      throw new Error("candidate provenance was requested but the extractor returned an incomplete provenance record");
    }
  }
  const candidates = [];
  for (const descriptor of summary.candidates || []) {
    if (!descriptor.available) {
      candidates.push(descriptor);
      continue;
    }
    let output = null;
    let error = descriptor.error || "";
    try {
      await page.evaluate(key => globalThis.__qingzhouArticleBenchmark.force(key), descriptor.key);
      output = await readCurrent(page, { source: "article", maxChunks: INTERNAL_CANDIDATE_MAX_CHUNKS });
    } catch (nextError) {
      error = `${nextError?.name || "Error"}: ${nextError?.message || nextError}`;
    } finally {
      await page.evaluate(() => globalThis.__qingzhouArticleBenchmark.clear()).catch(() => {});
    }
    candidates.push({ ...descriptor, error, output });
  }
  return { ...summary, candidates };
}

async function restoreDocumentBase(page, url) {
  await page.evaluate((baseUrl) => {
    document.querySelectorAll("base").forEach(element => element.remove());
    const base = document.createElement("base");
    base.href = baseUrl;
    (document.head || document.documentElement).prepend(base);
  }, url);
}

async function readLegacy(page) {
  return page.evaluate(() => {
    const markdown = content => globalThis.__benchmarkMarkdown?.(content) || "";
    let parsed = null;
    try {
      parsed = new Readability(document.cloneNode(true), { charThreshold: 0, keepClasses: false }).parse();
    } catch (_error) {}
    if (parsed && String(parsed.textContent || "").trim()) {
      return { mode: "readability", title: parsed.title || document.title, text: parsed.textContent || "", content: parsed.content || "", markdown: markdown(parsed.content) };
    }
    const root = document.querySelector("main,article,[role='main']") || document.body;
    const clone = root.cloneNode(true);
    clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,nav,header,footer,aside,form,button").forEach(element => element.remove());
    return { mode: "body-fallback", title: document.title, text: clone.innerText || clone.textContent || "", content: clone.outerHTML, markdown: markdown(clone.outerHTML) };
  });
}

async function readDefuddle(page, { markdownMode = "shared", url = "" } = {}) {
  return page.evaluate(({ nextMarkdownMode, pageUrl }) => {
    const includeNativeMarkdown = nextMarkdownMode === "native" || nextMarkdownMode === "both";
    const parsed = new globalThis.Defuddle(document.cloneNode(true), {
      url: pageUrl,
      useAsync: false,
      separateMarkdown: includeNativeMarkdown,
    }).parse();
    const content = String(parsed?.content || "");
    const extracted = new DOMParser().parseFromString(content, "text/html");
    const text = extracted.body?.innerText || extracted.body?.textContent || "";
    const markdownShared = globalThis.__qingzhouContentBenchmark.serializeArticleContent({ content, text });
    const markdownNative = includeNativeMarkdown ? String(parsed?.contentMarkdown || "") : "";
    if (includeNativeMarkdown && !markdownNative && content.trim()) {
      throw new Error("Defuddle bundle does not provide native Markdown output");
    }
    return {
      mode: parsed?.extractorType || "generic",
      title: parsed?.title || document.title,
      text,
      sourceText: text,
      content,
      markdown: nextMarkdownMode === "native" ? markdownNative : markdownShared,
      markdownShared,
      markdownNative,
      defuddleParseTimeMs: Number.isFinite(parsed?.parseTime) ? parsed.parseTime : null,
    };
  }, { nextMarkdownMode: markdownMode, pageUrl: url });
}

function blockCoverage(output, block) {
  const haystack = normalizedText(output);
  const needle = normalizedText(block);
  if (!needle) return 1;
  if (haystack.includes(needle)) return 1;
  const size = Math.min(48, Math.max(12, Math.floor(needle.length / 3)));
  const probes = [needle.slice(0, size), needle.slice(Math.max(0, Math.floor((needle.length - size) / 2)), Math.max(0, Math.floor((needle.length - size) / 2)) + size), needle.slice(-size)]
    .filter(value => value.length >= 8);
  return probes.filter(probe => haystack.includes(probe)).length / Math.max(1, probes.length);
}

function ngrams(text, size = 3, limit = 80_000) {
  const value = normalizedText(text).slice(0, limit);
  const counts = new Map();
  for (let index = 0; index <= value.length - size; index += 1) {
    const gram = value.slice(index, index + size);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

function ngramScores(output, reference) {
  const actual = ngrams(output);
  const expected = ngrams(reference);
  let overlap = 0;
  let actualTotal = 0;
  let expectedTotal = 0;
  for (const count of actual.values()) actualTotal += count;
  for (const count of expected.values()) expectedTotal += count;
  for (const [gram, count] of actual) overlap += Math.min(count, expected.get(gram) || 0);
  const precision = actualTotal ? overlap / actualTotal : 0;
  const recall = expectedTotal ? overlap / expectedTotal : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function markdownAssets(markdown) {
  const value = String(markdown || "");
  const links = [];
  const images = [];
  for (const match of value.matchAll(/(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const item = { label: normalizedText(match[2]), url: canonicalUrl(match[3]) };
    if (match[1]) images.push(item);
    else links.push(item);
  }
  for (const match of value.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ label: normalizedText(match[2].replace(/<[^>]+>/g, " ")), url: canonicalUrl(match[1]) });
  }
  for (const match of value.matchAll(/<img\b[^>]*(?:src=["'](https?:\/\/[^"']+)["'])[^>]*>/gi)) {
    images.push({ label: "", url: canonicalUrl(match[1]) });
  }
  return { links, images };
}

function resolveAssetUrl(value, baseUrl) {
  try {
    return canonicalUrl(new URL(value, baseUrl).href);
  } catch (_error) {
    return "";
  }
}

function absolutizeMarkdown(markdown, baseUrl) {
  return String(markdown || "").replace(
    /(!?\[[^\]]*\]\()([^\s)]+)(?=(?:\s+["'][^"']*["'])?\))/g,
    (match, prefix, url) => `${prefix}${resolveAssetUrl(url, baseUrl) || url}`,
  );
}

function assetRecall(expected, actual) {
  if (!expected.length) return null;
  let matches = 0;
  for (const item of expected) {
    const url = canonicalUrl(item.href || item.src || "");
    const label = normalizedText(item.text || item.alt || "");
    if (actual.some(candidate => (
      (url && candidate.url === url)
      || (label.length >= 4 && candidate.label === label)
    ))) matches += 1;
  }
  return matches / expected.length;
}

function structureRecall(markdown, reference) {
  const value = String(markdown || "");
  if (!value) return {
    linkRecall: reference?.links?.length ? 0 : null,
    imageRecall: reference?.images?.length ? 0 : null,
    headingPreserved: reference?.structures?.headings ? 0 : null,
    listPreserved: reference?.structures?.lists ? 0 : null,
    tablePreserved: reference?.structures?.tables ? 0 : null,
    codePreserved: reference?.structures?.codeBlocks ? 0 : null,
  };
  const assets = markdownAssets(value);
  return {
    linkRecall: assetRecall(reference?.links || [], assets.links),
    imageRecall: assetRecall(reference?.images || [], assets.images),
    headingPreserved: reference?.structures?.headings ? Number(/^#{1,6}\s+\S/m.test(value) || /<h[1-6]\b/i.test(value)) : null,
    listPreserved: reference?.structures?.lists ? Number(/^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/m.test(value) || /<(?:ul|ol|dl)\b/i.test(value)) : null,
    tablePreserved: reference?.structures?.tables ? Number(/^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/m.test(value) || /<table\b/i.test(value)) : null,
    codePreserved: reference?.structures?.codeBlocks ? Number(/```[\s\S]*?```/.test(value) || /<(?:pre|code)\b/i.test(value)) : null,
  };
}

function scoreOutput(output, reference, markdown = "", markdownOptions = {}) {
  const text = String(output || "");
  const required = reference?.requiredBlocks || [];
  const noise = reference?.noiseBlocks || [];
  const requiredRecall = required.length
    ? required.reduce((sum, block) => sum + blockCoverage(text, block), 0) / required.length
    : 0;
  const noiseHitRate = noise.length
    ? noise.reduce((sum, block) => sum + blockCoverage(text, block), 0) / noise.length
    : 0;
  const main = ngramScores(text, reference?.mainText || required.join(" "));
  const mainText = normalizedText(reference?.mainText || "");
  const third = Math.floor(mainText.length / 3);
  const sectionCoverage = mainText ? {
    head: blockCoverage(text, mainText.slice(0, Math.max(120, third))),
    middle: blockCoverage(text, mainText.slice(third, Math.max(third + 120, third * 2))),
    tail: blockCoverage(text, mainText.slice(Math.max(0, third * 2))),
  } : { head: 0, middle: 0, tail: 0 };
  return {
    chars: normalizedText(text).length,
    requiredRecall,
    noiseHitRate,
    mainNgramPrecision: main.precision,
    mainNgramRecall: main.recall,
    mainNgramF1: main.f1,
    sectionCoverage,
    structure: structureRecall(markdown, reference),
    markdown: markdown || text ? analyzeMarkdown(markdown, {
      sourceText: Object.hasOwn(markdownOptions, "sourceText") ? markdownOptions.sourceText : text,
      chunkEnds: markdownOptions.chunkEnds || [],
    }) : null,
  };
}

function internalCandidateDiagnostics(
  sample,
  value,
  currentOutput,
  reference,
  goldStatus,
  goldSplit,
  { candidateProvenance = false } = {},
) {
  const candidates = new Map((value?.candidates || []).map(candidate => [candidate.key, candidate]));
  const available = INTERNAL_CANDIDATE_KEYS
    .map(key => candidates.get(key))
    .filter(candidate => candidate?.output && !candidate.error);
  const byLength = [...available].sort((left, right) => (
    normalizedText(right.output.text).length - normalizedText(left.output.text).length
  ));
  const firstByDigest = new Map();
  const digestCount = new Map();
  for (const candidate of available) {
    const digest = sha256(normalizedText(candidate.output.text));
    if (!firstByDigest.has(digest)) firstByDigest.set(digest, candidate.key);
    digestCount.set(digest, (digestCount.get(digest) || 0) + 1);
  }
  const longest = normalizedText(byLength[0]?.output?.text).length;
  const rows = INTERNAL_CANDIDATE_KEYS.map(key => {
    const candidate = candidates.get(key) || { key, available: false, error: "candidate descriptor missing" };
    const output = candidate.output || {};
    const text = String(output.text || "").slice(0, INTERNAL_CANDIDATE_CONTENT_CAP);
    const markdown = String(output.markdown || "").slice(0, INTERNAL_CANDIDATE_CONTENT_CAP);
    const sourceText = output.sourceText == null
      ? null
      : String(output.sourceText).slice(0, INTERNAL_CANDIDATE_CONTENT_CAP);
    const outputChars = normalizedText(text).length;
    const peers = available
      .filter(other => other.key !== key)
      .map(other => ngramScores(text, other.output.text).f1);
    const digest = candidate.output && !candidate.error ? sha256(normalizedText(candidate.output.text)) : "";
    const lengthIndex = byLength.findIndex(other => other.key === key);
    return {
      key,
      strategy: candidate.strategy || "",
      available: Boolean(candidate.available && candidate.output && !candidate.error),
      error: candidate.error || "",
      elapsedMs: Number.isFinite(candidate.elapsedMs) ? candidate.elapsedMs : 0,
      rawOutputChars: candidate.rawOutputChars || 0,
      readabilityRawChars: candidate.readabilityRawChars,
      outputChars,
      truncated: Boolean(output.truncated),
      features: candidate.features ? {
        ...candidate.features,
        lengthRank: lengthIndex < 0 ? 0 : lengthIndex + 1,
        relativeToLongest: longest ? outputChars / longest : 0,
        meanPeerNgramF1: average(peers),
        maxPeerNgramF1: peers.length ? Math.max(...peers) : 0,
        duplicateGroupSize: digest ? digestCount.get(digest) || 1 : 0,
      } : null,
      duplicateOf: digest && firstByDigest.get(digest) !== key ? firstByDigest.get(digest) : "",
      metrics: (!goldStatus || goldStatus === "extract") && candidate.output && !candidate.error
        ? scoreOutput(text, reference, markdown, {
          sourceText,
          chunkEnds: output.chunkEnds || [],
        })
        : null,
      output: candidate.output ? {
        mode: output.mode || "",
        title: output.title || "",
        text,
        markdown,
        sourceText,
        chunks: output.chunks || 0,
        chunkEnds: output.chunkEnds || [],
        truncated: Boolean(output.truncated),
      } : null,
    };
  });
  return {
    schema: "qingzhou.article-extraction-internal-candidates.v3",
    id: sample.id,
    siteId: sample.siteId,
    type: sample.type,
    vertical: sample.vertical,
    goldStatus,
    goldSplit,
    candidateProvenance: { enabled: candidateProvenance },
    contentCapChars: INTERNAL_CANDIDATE_CONTENT_CAP,
    currentStrategy: value?.currentStrategy || "",
    currentError: value?.currentError || value?.error || "",
    benchmarkDiagnostics: value?.diagnostics || null,
    productCurrent: {
      available: Boolean(currentOutput && !currentOutput.error),
      error: currentOutput?.error || "",
      mode: currentOutput?.mode || "",
      outputChars: normalizedText(currentOutput?.text).length,
      nonEmpty: Boolean(normalizedText(currentOutput?.text) || normalizedText(currentOutput?.markdown)),
      metrics: goldStatus === "extract" && currentOutput && !currentOutput.error
        ? scoreOutput(currentOutput.text, reference, currentOutput.markdown || "", {
          sourceText: currentOutput.sourceText,
          chunkEnds: currentOutput.chunkEnds || [],
        })
        : null,
    },
    page: value?.page || null,
    candidates: rows,
  };
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}

function averageOrNull(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function modeCounts(items) {
  return Object.fromEntries([...new Set(items.map(item => item.mode || "unknown"))]
    .sort()
    .map(mode => [mode, items.filter(item => (item.mode || "unknown") === mode).length]));
}

function aggregate(items) {
  const ok = items.filter(item => !item.error);
  const elapsed = ok.map(item => item.elapsedMs).filter(Number.isFinite);
  return {
    samples: items.length,
    errors: items.length - ok.length,
    modes: modeCounts(items),
    empty: ok.filter(item => item.metrics.chars === 0).length,
    requiredRecall: average(ok.map(item => item.metrics.requiredRecall)),
    noiseHitRate: average(ok.map(item => item.metrics.noiseHitRate)),
    mainNgramPrecision: average(ok.map(item => item.metrics.mainNgramPrecision)),
    mainNgramRecall: average(ok.map(item => item.metrics.mainNgramRecall)),
    mainNgramF1: average(ok.map(item => item.metrics.mainNgramF1)),
    headCoverage: average(ok.map(item => item.metrics.sectionCoverage.head)),
    middleCoverage: average(ok.map(item => item.metrics.sectionCoverage.middle)),
    tailCoverage: average(ok.map(item => item.metrics.sectionCoverage.tail)),
    linkRecall: averageOrNull(ok.map(item => item.metrics.structure.linkRecall)),
    imageRecall: averageOrNull(ok.map(item => item.metrics.structure.imageRecall)),
    headingPreserved: averageOrNull(ok.map(item => item.metrics.structure.headingPreserved)),
    listPreserved: averageOrNull(ok.map(item => item.metrics.structure.listPreserved)),
    tablePreserved: averageOrNull(ok.map(item => item.metrics.structure.tablePreserved)),
    codePreserved: averageOrNull(ok.map(item => item.metrics.structure.codePreserved)),
    markdownQuality: {
      parserErrors: ok.reduce((sum, item) => sum + (item.metrics.markdown?.parser?.errors || 0), 0),
      syntaxDefects: ok.reduce((sum, item) => sum + (item.metrics.markdown?.syntax?.total || 0), 0),
      roundTripRecallDrifts: ok.reduce((sum, item) => sum + Number(Boolean(item.metrics.markdown?.roundTrip?.materialRecallDrift)), 0),
      roundTripPrecisionDrifts: ok.reduce((sum, item) => sum + Number(Boolean(item.metrics.markdown?.roundTrip?.materialPrecisionDrift)), 0),
      roundTripDrifts: ok.reduce((sum, item) => sum + Number(Boolean(item.metrics.markdown?.roundTrip?.drift)), 0),
      roundTripF1: averageOrNull(ok.map(item => item.metrics.markdown?.roundTrip?.f1)),
      paginationSensitiveBoundaries: ok.reduce((sum, item) => sum + (item.metrics.markdown?.pagination?.sensitiveBoundaries || 0), 0),
      paginationSemanticDrifts: ok.reduce((sum, item) => sum + Number(Boolean(item.metrics.markdown?.pagination?.semanticDrift)), 0),
      paginationDefects: ok.reduce((sum, item) => sum + (item.metrics.markdown?.pagination?.total || 0), 0),
      totalDefects: ok.reduce((sum, item) => sum + (item.metrics.markdown?.total || 0), 0),
    },
    performance: {
      meanMs: average(elapsed),
      p50Ms: percentile(elapsed, 0.5),
      p95Ms: percentile(elapsed, 0.95),
      maxMs: elapsed.length ? Math.max(...elapsed) : 0,
      totalMs: elapsed.reduce((sum, value) => sum + value, 0),
    },
  };
}

function aggregateExcluded(items) {
  const successful = items.filter(item => !item.error);
  const empty = successful.filter(item => item.outputChars === 0).length;
  const falsePositive = successful.length - empty;
  return {
    samples: items.length,
    errors: items.length - successful.length,
    empty,
    falsePositive,
  };
}

function aggregateGold(items) {
  const extract = items.filter(item => item.goldStatus === "extract");
  const exclude = items.filter(item => item.goldStatus === "exclude");
  return {
    samples: items.length,
    extract: aggregate(extract),
    exclude: aggregateExcluded(exclude),
  };
}

function crossExtractorOracleReport(samples, algorithms, gold) {
  const extractors = [
    "qingzhou-current",
    "legacy-readability",
    "trafilatura-python",
    ...(algorithms["defuddle-shared"]
      ? ["defuddle-shared"]
      : algorithms.defuddle
        ? ["defuddle"]
        : []),
  ];
  const baselineName = extractors[0];
  const results = Object.fromEntries(extractors.map(name => [
    name,
    new Map((algorithms[name] || []).map(item => [item.id, item])),
  ]));
  const items = [];
  for (const sample of samples) {
    if (gold.labelsById.get(sample.id)?.status !== "extract") continue;
    const available = extractors
      .map(name => ({ name, item: results[name].get(sample.id) }))
      .filter(extractor => extractor.item?.metrics && !extractor.item.error);
    let selected = null;
    for (const extractor of available) {
      if (!selected || extractor.item.metrics.mainNgramF1 > selected.item.metrics.mainNgramF1) {
        selected = extractor;
      }
    }
    const baseline = results[baselineName].get(sample.id);
    const baselineMainNgramF1 = baseline?.metrics && !baseline.error
      ? baseline.metrics.mainNgramF1
      : 0;
    const mainNgramPrecision = selected?.item.metrics.mainNgramPrecision || 0;
    const mainNgramRecall = selected?.item.metrics.mainNgramRecall || 0;
    const mainNgramF1 = selected?.item.metrics.mainNgramF1 || 0;
    items.push({
      id: sample.id,
      type: sample.type || "unknown",
      goldSplit: gold.splitById.get(sample.id) || "",
      selectedExtractor: selected?.name || "",
      mainNgramPrecision,
      mainNgramRecall,
      mainNgramF1,
      baselineMainNgramF1,
      selectionLossMainNgramF1: Math.max(0, mainNgramF1 - baselineMainNgramF1),
    });
  }
  const byType = new Map();
  for (const item of items) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(item);
  }
  const aggregate = group => {
    const selectedExtractorCounts = Object.fromEntries(extractors.map(name => [name, 0]));
    for (const item of group) {
      if (item.selectedExtractor) selectedExtractorCounts[item.selectedExtractor] += 1;
    }
    return {
      samples: group.length,
      noExtractorOutput: group.filter(item => !item.selectedExtractor).length,
      upperBound: {
        mainNgramPrecision: average(group.map(item => item.mainNgramPrecision)),
        mainNgramRecall: average(group.map(item => item.mainNgramRecall)),
        mainNgramF1: average(group.map(item => item.mainNgramF1)),
      },
      baseline: {
        algorithm: baselineName,
        mainNgramF1: average(group.map(item => item.baselineMainNgramF1)),
      },
      selectionLoss: {
        mainNgramF1: average(group.map(item => item.selectionLossMainNgramF1)),
        improvableSamples: group.filter(item => item.selectionLossMainNgramF1 > 1e-12).length,
      },
      selectedExtractorCounts,
    };
  };
  return {
    extractors,
    baseline: baselineName,
    gold: {
      base: aggregate(items.filter(item => item.goldSplit === "base")),
      increment: aggregate(items.filter(item => item.goldSplit === "increment")),
      combined: aggregate(items),
    },
    byType: Object.fromEntries([...byType].map(([name, group]) => [name, aggregate(group)])),
  };
}

function internalCandidateOracleReport(samples, diagnostics, algorithms, gold) {
  const baselineName = "qingzhou-current";
  const diagnosticsById = new Map(diagnostics.map(item => [item.id, item]));
  const baselineById = new Map((algorithms[baselineName] || []).map(item => [item.id, item]));
  const items = [];
  for (const sample of samples) {
    if (gold.labelsById.get(sample.id)?.status !== "extract") continue;
    const available = INTERNAL_CANDIDATE_KEYS
      .map(name => ({
        name,
        item: diagnosticsById.get(sample.id)?.candidates?.find(candidate => candidate.key === name),
      }))
      .filter(candidate => candidate.item?.metrics && !candidate.item.error);
    let selected = null;
    for (const candidate of available) {
      if (!selected || candidate.item.metrics.mainNgramF1 > selected.item.metrics.mainNgramF1) {
        selected = candidate;
      }
    }
    const baseline = baselineById.get(sample.id);
    const baselineMainNgramF1 = baseline?.metrics && !baseline.error
      ? baseline.metrics.mainNgramF1
      : 0;
    const mainNgramPrecision = selected?.item.metrics.mainNgramPrecision || 0;
    const mainNgramRecall = selected?.item.metrics.mainNgramRecall || 0;
    const mainNgramF1 = selected?.item.metrics.mainNgramF1 || 0;
    items.push({
      id: sample.id,
      type: sample.type || "unknown",
      goldSplit: gold.splitById.get(sample.id) || "",
      selectedCandidate: selected?.name || "",
      mainNgramPrecision,
      mainNgramRecall,
      mainNgramF1,
      baselineMainNgramF1,
      selectionLossMainNgramF1: Math.max(0, mainNgramF1 - baselineMainNgramF1),
    });
  }
  const byType = new Map();
  for (const item of items) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type).push(item);
  }
  const aggregate = group => {
    const selectedCandidateCounts = Object.fromEntries(INTERNAL_CANDIDATE_KEYS.map(name => [name, 0]));
    for (const item of group) {
      if (item.selectedCandidate) selectedCandidateCounts[item.selectedCandidate] += 1;
    }
    return {
      samples: group.length,
      noCandidateOutput: group.filter(item => !item.selectedCandidate).length,
      upperBound: {
        mainNgramPrecision: average(group.map(item => item.mainNgramPrecision)),
        mainNgramRecall: average(group.map(item => item.mainNgramRecall)),
        mainNgramF1: average(group.map(item => item.mainNgramF1)),
      },
      baseline: {
        algorithm: baselineName,
        mainNgramF1: average(group.map(item => item.baselineMainNgramF1)),
      },
      selectionLoss: {
        mainNgramF1: average(group.map(item => item.selectionLossMainNgramF1)),
        improvableSamples: group.filter(item => item.selectionLossMainNgramF1 > 1e-12).length,
      },
      selectedCandidateCounts,
    };
  };
  return {
    candidates: INTERNAL_CANDIDATE_KEYS,
    baseline: baselineName,
    contentCapChars: INTERNAL_CANDIDATE_CONTENT_CAP,
    gold: {
      base: aggregate(items.filter(item => item.goldSplit === "base")),
      increment: aggregate(items.filter(item => item.goldSplit === "increment")),
      combined: aggregate(items),
    },
    byType: Object.fromEntries([...byType].map(([name, group]) => [name, aggregate(group)])),
  };
}

function grouped(samples, resultMap, key) {
  const groups = new Map();
  for (const sample of samples) {
    const name = sample[key] || "unknown";
    if (!groups.has(name)) groups.set(name, []);
    const result = resultMap.get(sample.id);
    if (result) groups.get(name).push(result);
  }
  return Object.fromEntries([...groups].map(([name, items]) => [name, aggregate(items)]));
}

async function runCommand() {
  const corpusDir = resolve(option("--corpus", join(defaultResults, "zh-core-v1")));
  const manifestPath = resolve(option("--manifest", join(corpusDir, "manifest.json")));
  const outputDir = resolve(option("--output", join(corpusDir, "run-current")));
  const workers = numberOption("--workers", 4);
  const candidateProvenance = flag("--candidate-provenance");
  const upstream = resolve(option("--upstream", "/tmp/qingzhou-trafilatura-source"));
  const python = option("--python", "/tmp/qingzhou-trafilatura-venv/bin/python");
  const defuddleBundleValue = option("--defuddle-bundle");
  const defuddleBundle = defuddleBundleValue ? resolve(defuddleBundleValue) : "";
  if (defuddleBundle && !existsSync(defuddleBundle)) {
    throw new Error(`Defuddle bundle does not exist: ${defuddleBundle}`);
  }
  const defuddleMarkdown = option("--defuddle-markdown", "shared");
  if (!new Set(["shared", "native", "both"]).has(defuddleMarkdown)) {
    throw new Error(`Unsupported --defuddle-markdown value: ${defuddleMarkdown}`);
  }
  if (!defuddleBundle && defuddleMarkdown !== "shared") {
    throw new Error(`--defuddle-markdown ${defuddleMarkdown} requires --defuddle-bundle`);
  }
  const manifest = json(manifestPath);
  const labelsValue = option("--labels");
  const gold = labelsValue
    ? loadHumanGold(resolve(labelsValue), corpusDir, manifestPath, manifest)
    : null;
  mkdirSync(outputDir, { recursive: true });
  const upstreamOutput = join(outputDir, "trafilatura.json");
  execFileSync(python, [join(here, "realworld-runner.py"), "--upstream", upstream, "--manifest", manifestPath, "--corpus", corpusDir, "--output", upstreamOutput], { stdio: "inherit" });
  const trafilatura = json(upstreamOutput);
  const browser = await chromium.launch({ headless: true });
  const scripts = await initScripts({ defuddleBundle });
  const preflightContext = await createRunContext(browser, scripts);
  const preflightPage = await preflightContext.newPage();
  await assertBenchmarkRuntime(preflightPage, {
    defuddle: Boolean(defuddleBundle),
    nativeDefuddleMarkdown: Boolean(defuddleBundle) && defuddleMarkdown !== "shared",
  });
  await preflightContext.close();
  const evaluated = new Array(manifest.samples.length);
  let cursor = 0;
  async function runWorker() {
    const context = await createRunContext(browser, scripts);
    const page = await context.newPage();
    for (;;) {
      const index = cursor++;
      if (index >= manifest.samples.length) break;
      const sample = manifest.samples[index];
      const snapshot = resolve(corpusDir, sample.snapshot);
      const outputs = {};
      let internalCandidates = null;
      const browserAlgorithms = [
        "legacy-readability",
        "qingzhou-current",
        ...(defuddleBundle ? ["defuddle"] : []),
      ];
      for (const algorithm of browserAlgorithms) {
        try {
          await page.goto(pathToFileURL(snapshot).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await restoreDocumentBase(page, sample.finalUrl || sample.requestedUrl);
          const started = performance.now();
          const value = algorithm === "legacy-readability"
            ? await readLegacy(page)
            : algorithm === "qingzhou-current"
              ? await readCurrent(page)
              : await readDefuddle(page, {
                markdownMode: defuddleMarkdown,
                url: sample.finalUrl || sample.requestedUrl,
              });
          const elapsedMs = performance.now() - started;
          if (algorithm === "defuddle" && defuddleMarkdown === "both") {
            outputs["defuddle-shared"] = { ...value, markdown: value.markdownShared, elapsedMs };
            outputs["defuddle-native"] = { ...value, markdown: value.markdownNative, elapsedMs };
          } else {
            outputs[algorithm] = { ...value, elapsedMs };
          }
          if (algorithm === "qingzhou-current") {
            try {
              internalCandidates = await readInternalCandidates(page, { candidateProvenance });
            } catch (error) {
              if (candidateProvenance) {
                const provenanceError = new Error(
                  `${sample.id} candidate provenance failed: ${error?.message || error}`,
                  { cause: error },
                );
                provenanceError.code = "CANDIDATE_PROVENANCE_FAILED";
                throw provenanceError;
              }
              internalCandidates = {
                error: `${error?.name || "Error"}: ${error?.message || error}`,
                candidates: [],
              };
            }
          }
        } catch (error) {
          if (error?.code === "CANDIDATE_PROVENANCE_FAILED") throw error;
          const failed = { error: `${error?.name || "Error"}: ${error?.message || error}`, text: "" };
          if (algorithm === "defuddle" && defuddleMarkdown === "both") {
            outputs["defuddle-shared"] = failed;
            outputs["defuddle-native"] = failed;
          } else {
            outputs[algorithm] = failed;
          }
        }
      }
      evaluated[index] = { sample, outputs, internalCandidates };
      console.log(`run ${index + 1}/${manifest.samples.length} ${sample.id}`);
    }
    await context.close();
  }
  try {
    await Promise.all(Array.from(
      { length: Math.min(workers, manifest.samples.length) },
      runWorker,
    ));
  } finally {
    await browser.close();
  }

  const algorithms = {
    "legacy-readability": [],
    "qingzhou-current": [],
    "trafilatura-python": [],
    ...(defuddleBundle && defuddleMarkdown === "both"
      ? { "defuddle-shared": [], "defuddle-native": [] }
      : defuddleBundle
        ? { defuddle: [] }
        : {}),
  };
  const internalDiagnostics = [];
  for (const { sample, outputs, internalCandidates } of evaluated) {
    const label = gold?.labelsById.get(sample.id);
    const reference = label?.reference || sample.reference;
    const goldStatus = label?.status || "";
    const goldSplit = gold?.splitById.get(sample.id) || "";
    const browserAlgorithms = [
      "legacy-readability",
      "qingzhou-current",
      ...(defuddleBundle && defuddleMarkdown === "both"
        ? ["defuddle-shared", "defuddle-native"]
        : defuddleBundle
          ? ["defuddle"]
          : []),
    ];
    for (const name of browserAlgorithms) {
      const value = outputs[name];
      const productMarkdown = name === "legacy-readability" || name.startsWith("defuddle")
        ? absolutizeMarkdown(value.markdown || "", sample.finalUrl || sample.requestedUrl)
        : (value.markdown || "");
      algorithms[name].push({
        id: sample.id,
        siteId: sample.siteId,
        type: sample.type,
        vertical: sample.vertical,
        referenceConfidence: label ? "high" : (sample.reference?.confidence || "low"),
        goldStatus,
        goldSplit,
        mode: value.mode || "",
        error: value.error || "",
        elapsedMs: value.elapsedMs,
        outputChars: normalizedText(value.text).length,
        metrics: !label || goldStatus === "extract"
          ? scoreOutput(value.text, reference, productMarkdown, {
            sourceText: name === "qingzhou-current" || name.startsWith("defuddle") ? value.sourceText : value.text,
            chunkEnds: name === "qingzhou-current" ? value.chunkEnds : [],
          })
          : null,
      });
      writeJson(join(outputDir, "outputs", name, `${sample.id}.json`), value);
    }
    const upstreamValue = trafilatura.results[sample.id] || { text: "", error: trafilatura.errors[sample.id] || "" };
    algorithms["trafilatura-python"].push({
      id: sample.id,
      siteId: sample.siteId,
      type: sample.type,
      vertical: sample.vertical,
      referenceConfidence: label ? "high" : (sample.reference?.confidence || "low"),
      goldStatus,
      goldSplit,
      mode: "trafilatura",
      error: upstreamValue.error || "",
      elapsedMs: upstreamValue.elapsedMs,
      outputChars: normalizedText(upstreamValue.text).length,
      metrics: !label || goldStatus === "extract"
        ? scoreOutput(upstreamValue.text, reference, upstreamValue.markdown || "", {
          sourceText: upstreamValue.text,
        })
        : null,
    });
    writeJson(join(outputDir, "outputs", "trafilatura-python", `${sample.id}.json`), upstreamValue);
    const diagnostics = internalCandidateDiagnostics(
      sample,
      internalCandidates,
      outputs["qingzhou-current"],
      reference,
      goldStatus,
      goldSplit,
      { candidateProvenance },
    );
    internalDiagnostics.push(diagnostics);
    writeJson(join(outputDir, "outputs", "qingzhou-internal", `${sample.id}.json`), diagnostics);
  }
  writeFileSync(
    join(outputDir, "internal-candidates.jsonl"),
    `${internalDiagnostics.map(item => JSON.stringify(item)).join("\n")}\n`,
  );
  const algorithmReport = items => {
    if (!gold) return {
      modes: modeCounts(items),
      overall: aggregate(items.filter(item => item.referenceConfidence !== "low")),
      allReferences: aggregate(items),
      byType: grouped(manifest.samples, new Map(items.filter(item => item.referenceConfidence !== "low").map(item => [item.id, item])), "type"),
      allByType: grouped(manifest.samples, new Map(items.map(item => [item.id, item])), "type"),
      byVertical: grouped(manifest.samples, new Map(items.filter(item => item.referenceConfidence !== "low").map(item => [item.id, item])), "vertical"),
      allByVertical: grouped(manifest.samples, new Map(items.map(item => [item.id, item])), "vertical"),
    };
    const extractItems = items.filter(item => item.goldStatus === "extract");
    const extractIds = new Set(extractItems.map(item => item.id));
    const extractSamples = manifest.samples.filter(sample => extractIds.has(sample.id));
    const combined = aggregateGold(items);
    return {
      modes: modeCounts(items),
      overall: combined.extract,
      exclusions: combined.exclude,
      gold: {
        base: aggregateGold(items.filter(item => item.goldSplit === "base")),
        increment: aggregateGold(items.filter(item => item.goldSplit === "increment")),
        combined,
      },
      byType: grouped(extractSamples, new Map(extractItems.map(item => [item.id, item])), "type"),
      byVertical: grouped(extractSamples, new Map(extractItems.map(item => [item.id, item])), "vertical"),
    };
  };
  const report = {
    schema: gold ? "qingzhou.article-extraction-report.v4" : "qingzhou.article-extraction-report.v2",
    suite: manifest.suite,
    corpus: {
      manifest: relative(root, manifestPath),
      capturedAt: manifest.capturedAt,
      samples: manifest.samples.length,
      scoredSamples: gold ? gold.status.extract : manifest.samples.filter(item => item.reference?.confidence !== "low").length,
      failures: manifest.failures.length,
      confidence: Object.fromEntries(["high", "medium", "low"].map(value => [value, manifest.samples.filter(item => item.reference?.confidence === value).length])),
      ...(gold ? {
        labels: relative(root, join(gold.labelsDir, "manifest.json")),
        labelMethod: gold.manifest.method,
        labelStatus: gold.status,
      } : {}),
    },
    algorithms: Object.fromEntries(Object.entries(algorithms).map(([name, items]) => [name, algorithmReport(items)])),
    ...(gold ? {
      crossExtractorOracle: crossExtractorOracleReport(manifest.samples, algorithms, gold),
      internalCandidateOracle: internalCandidateOracleReport(manifest.samples, internalDiagnostics, algorithms, gold),
    } : {}),
    perSample: Object.fromEntries(Object.entries(algorithms).map(([name, items]) => [name, items])),
    provenance: {
      gitCommit: (() => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); } catch (_error) { return ""; } })(),
      articleExtractorSha256: sha256(readFileSync(join(await ensureTestExtension(), "content/article-extractor.js"))),
      contentScriptSha256: sha256(readFileSync(join(await ensureTestExtension(), "content/content-script.js"))),
      readabilitySha256: sha256(readFileSync((await prepareUpstreamArticleAssets()).readability)),
      markedSha256: sha256(readFileSync((await prepareUpstreamArticleAssets()).marked)),
      instrumentExtractorSha256: sha256(readFileSync(join(here, "instrument-extractor.mjs"))),
      instrumentContentScriptSha256: sha256(readFileSync(join(here, "instrument-content-script.mjs"))),
      markdownQualitySha256: sha256(readFileSync(join(here, "markdown-quality.mjs"))),
      candidateProvenance: { enabled: candidateProvenance },
      trafilaturaCommit: trafilatura.upstreamCommit,
      python: trafilatura.python,
      ...(defuddleBundle ? {
        defuddle: {
          bundle: defuddleBundle,
          bundleSha256: sha256(readFileSync(defuddleBundle)),
          serializer: defuddleMarkdown,
          useAsync: false,
        },
      } : {}),
    },
  };
  writeJson(join(outputDir, "report.json"), report);
  const lines = gold ? [
    `# ${manifest.suite} article extraction benchmark`,
    "",
    `Captured pages: ${manifest.samples.length}; human-approved extracts: ${gold.status.extract}; human-approved excludes: ${gold.status.exclude}; capture failures: ${manifest.failures.length}.`,
    `Candidate provenance: ${candidateProvenance ? "enabled" : "disabled"}.`,
    "",
    "| Algorithm | Shard | Extract pages | Main F1 | Main precision | Main recall | Markdown AST errors / syntax defects / semantic drift pages / pagination defects | Exclude pages | False positive / empty / error | p50 / p95 ms |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ] : [
    `# ${manifest.suite} article extraction benchmark`,
    "",
    `Captured pages: ${manifest.samples.length}; scored references: ${report.corpus.scoredSamples}; capture failures: ${manifest.failures.length}.`,
    `Candidate provenance: ${candidateProvenance ? "enabled" : "disabled"}.`,
    "",
    "| Algorithm | Main F1 | Main precision | Main recall | Required blocks | Noise hit | Head / middle / tail | Link / image recall | p50 / p95 ms | Errors | Markdown AST errors / syntax defects / semantic drift pages / pagination defects |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, value] of Object.entries(report.algorithms)) {
    if (gold) {
      for (const shard of ["base", "increment", "combined"]) {
        const result = value.gold[shard];
        const metric = result.extract;
        const exclude = result.exclude;
        const markdown = metric.markdownQuality;
        lines.push(`| ${name} | ${shard} | ${metric.samples} | ${metric.mainNgramF1.toFixed(4)} | ${metric.mainNgramPrecision.toFixed(4)} | ${metric.mainNgramRecall.toFixed(4)} | ${markdown.parserErrors} / ${markdown.syntaxDefects} / ${markdown.roundTripDrifts} / ${markdown.paginationDefects} | ${exclude.samples} | ${exclude.falsePositive} / ${exclude.empty} / ${exclude.errors} | ${metric.performance.p50Ms.toFixed(1)} / ${metric.performance.p95Ms.toFixed(1)} |`);
      }
    } else {
      const metric = value.overall;
      const markdown = metric.markdownQuality;
      lines.push(`| ${name} | ${metric.mainNgramF1.toFixed(4)} | ${metric.mainNgramPrecision.toFixed(4)} | ${metric.mainNgramRecall.toFixed(4)} | ${metric.requiredRecall.toFixed(4)} | ${metric.noiseHitRate.toFixed(4)} | ${metric.headCoverage.toFixed(3)} / ${metric.middleCoverage.toFixed(3)} / ${metric.tailCoverage.toFixed(3)} | ${metric.linkRecall.toFixed(3)} / ${metric.imageRecall.toFixed(3)} | ${metric.performance.p50Ms.toFixed(1)} / ${metric.performance.p95Ms.toFixed(1)} | ${metric.errors} | ${markdown.parserErrors} / ${markdown.syntaxDefects} / ${markdown.roundTripDrifts} / ${markdown.paginationDefects} |`);
    }
  }
  if (gold) {
    const oracle = report.crossExtractorOracle;
    lines.push(
      "",
      "## Cross-extractor ensemble oracle",
      "",
      `Each page selects the highest-gold-F1 complete output from ${oracle.extractors.join(", ")}; exact ties prefer ${oracle.baseline}. This is an ensemble upper bound across end-to-end extractors, not evidence that an internal Qingzhou candidate reranker can reproduce it. Selection loss is the macro F1 gap from ${oracle.baseline} to this upper bound.`,
      "",
      "| Group | Extract pages | Oracle F1 | Qingzhou F1 | Selection loss | Improvable pages | No extractor output | Selected extractors |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const shard of ["base", "increment", "combined"]) {
      const value = oracle.gold[shard];
      const selected = Object.entries(value.selectedExtractorCounts).map(([name, count]) => `${name}=${count}`).join(", ");
      lines.push(`| ${shard} | ${value.samples} | ${value.upperBound.mainNgramF1.toFixed(4)} | ${value.baseline.mainNgramF1.toFixed(4)} | ${value.selectionLoss.mainNgramF1.toFixed(4)} | ${value.selectionLoss.improvableSamples} | ${value.noExtractorOutput} | ${selected} |`);
    }
    for (const [type, value] of Object.entries(oracle.byType)) {
      const selected = Object.entries(value.selectedExtractorCounts).map(([name, count]) => `${name}=${count}`).join(", ");
      lines.push(`| type:${type} | ${value.samples} | ${value.upperBound.mainNgramF1.toFixed(4)} | ${value.baseline.mainNgramF1.toFixed(4)} | ${value.selectionLoss.mainNgramF1.toFixed(4)} | ${value.selectionLoss.improvableSamples} | ${value.noExtractorOutput} | ${selected} |`);
    }

    const internalOracle = report.internalCandidateOracle;
    lines.push(
      "",
      "## Qingzhou internal candidate oracle",
      "",
      `Each page selects the highest-gold-F1 product-serialized output from ${internalOracle.candidates.join(", ")}; exact ties follow that order. Probe work is excluded from Qingzhou performance timing and candidate text is capped at ${internalOracle.contentCapChars} characters.`,
      "",
      "| Group | Extract pages | Oracle F1 | Qingzhou F1 | Selection loss | Improvable pages | No candidate output | Selected candidates |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    );
    for (const shard of ["base", "increment", "combined"]) {
      const value = internalOracle.gold[shard];
      const selected = Object.entries(value.selectedCandidateCounts).map(([name, count]) => `${name}=${count}`).join(", ");
      lines.push(`| ${shard} | ${value.samples} | ${value.upperBound.mainNgramF1.toFixed(4)} | ${value.baseline.mainNgramF1.toFixed(4)} | ${value.selectionLoss.mainNgramF1.toFixed(4)} | ${value.selectionLoss.improvableSamples} | ${value.noCandidateOutput} | ${selected} |`);
    }
    for (const [type, value] of Object.entries(internalOracle.byType)) {
      const selected = Object.entries(value.selectedCandidateCounts).map(([name, count]) => `${name}=${count}`).join(", ");
      lines.push(`| type:${type} | ${value.samples} | ${value.upperBound.mainNgramF1.toFixed(4)} | ${value.baseline.mainNgramF1.toFixed(4)} | ${value.selectionLoss.mainNgramF1.toFixed(4)} | ${value.selectionLoss.improvableSamples} | ${value.noCandidateOutput} | ${selected} |`);
    }
  }
  lines.push("", gold
    ? "Text precision/recall/F1 is macro-averaged over human-approved extract pages only. Human-approved exclude pages report non-empty output as a false positive; empty output and execution errors are separate counts."
    : "Metrics are macro-averaged per page. Output length is diagnostic only and is never used as a quality score.", "");
  writeFileSync(join(outputDir, "report.md"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nReport: ${join(outputDir, "report.json")}`);
}

const command = process.argv[2] || "";
if (command === "capture") await captureCommand();
else if (command === "compose") composeCommand();
else if (command === "sanitize") sanitizeCommand();
else if (command === "annotate") await annotateCommand();
else if (command === "run") await runCommand();
else {
  console.error("Usage: realworld.mjs <capture|compose|sanitize|annotate|run> [options]");
  process.exitCode = 1;
}
