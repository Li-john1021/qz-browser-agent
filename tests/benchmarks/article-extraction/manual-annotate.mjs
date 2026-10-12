#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { readTestApiKey } from "../../support/local-credentials.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const command = args[0] || "seed";

function option(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertReviewScreenshot(corpus, sample) {
  if (!sample.screenshot) return;
  const screenshot = resolve(corpus, sample.screenshot);
  const match = /^([a-f0-9]{64})\.[^.]+$/i.exec(basename(sample.screenshot));
  if ((!screenshot.startsWith(`${resolve(corpus)}${sep}`) && screenshot !== resolve(corpus))
    || !match || !existsSync(screenshot) || sha256(readFileSync(screenshot)) !== match[1].toLowerCase()) {
    throw new Error(`${sample.id} screenshot is not the content-addressed review image`);
  }
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value, limit) {
  const text = String(value || "").trim();
  if (text.length <= limit) return text;
  const part = Math.floor((limit - 80) / 3);
  const middle = Math.max(0, Math.floor((text.length - part) / 2));
  return `${text.slice(0, part)}\n…[${text.length - part * 3} chars omitted]…\n${text.slice(middle, middle + part)}\n…\n${text.slice(-part)}`;
}

function stableOrder(sample, names) {
  return [...names].sort((left, right) => (
    sha256(`${sample.id}\n${sample.inputSha256}\n${left}`).localeCompare(
      sha256(`${sample.id}\n${sample.inputSha256}\n${right}`),
    )
  ));
}

function parseJsonObject(value) {
  const text = String(value || "").trim();
  try {
    return JSON.parse(text);
  } catch (_error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("model did not return a JSON object");
  }
}

function assertTextOnlyPacket(packet) {
  const serialized = JSON.stringify(packet);
  if (/data:image\//i.test(serialized)) throw new Error("text-only label packet contains an image data URI");
  if (/\"(?:image_url|images|screenshot|screenshotAvailable)\"\s*:/i.test(serialized)) {
    throw new Error("text-only label packet contains an image-bearing field");
  }
}

async function callDeepSeek(apiKey, model, endpoint, packet, attempt = 1) {
  assertTextOnlyPacket(packet);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 3_000,
        messages: [
          { role: "system", content: LABEL_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(packet) },
        ],
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`DeepSeek HTTP ${response.status}: ${body.slice(0, 500)}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }
    const payload = JSON.parse(body);
    return {
      label: parseJsonObject(payload.choices?.[0]?.message?.content),
      usage: payload.usage || null,
      requestId: response.headers.get("x-request-id") || "",
    };
  } catch (error) {
    if (attempt < 4 && (error?.retryable || error?.name === "AbortError" || error instanceof TypeError)) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 750 * (2 ** (attempt - 1))));
      return callDeepSeek(apiKey, model, endpoint, packet, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const LABEL_SYSTEM_PROMPT = `你是中文网页正文基准集的逐页标注员。每次只判断一个已由真实 Chromium 渲染并冻结的页面。

目标是确定用户调用“读取正文”时应得到的中心内容边界，而不是评价任何抽取算法。候选草稿 A/B/C 已匿名并按页打乱，不能从顺序推断来源。
你是单模态文本模型。输入只有冻结 DOM 的结构与文本索引，以及匿名文本草稿；截图由人工复核员另行查看。

页面类型定义：
- detail/policy：保留标题、导语、正文、正文内小标题/列表/表格/代码/图注；排除全站导航、侧栏、评论、相关推荐、页脚、广告。
- thread/discussion：保留主帖及属于该讨论的有序回复；排除全站导航、侧栏、无关推荐、页脚和广告。
- home/channel/feed/search/topic/ranking/catalog：保留当前页面的中心内容集合及其必要分组标题、卡片标题/摘要/关键元数据；排除全站导航、页脚、浮层、广告和不属于中心集合的侧栏。
- entity/product/service/company/place/job：保留当前主体的名称、说明、状态、核心属性，以及直接描述同一主体的分组、列表和表格；排除站内导航、交易控件、跨主体推荐、页脚、浮层和广告。
- video/live/image：保留主内容标题、说明、作者、图注与直接相关的主体元数据；排除推荐流和评论，除非页面本身就是内容列表。中心内容很短也仍然有效。
- data：保留主数据表、标题、口径说明和必要表头。

输入中的 regions 和 blocks 只是 DOM 的中性索引，不是预先给出的答案。你必须自行选择中心区域。页面若是挑战页、登录墙、错误页、空壳或没有可提取内容，status=exclude。否则 status=extract。

判定以冻结 DOM 中实际存在的内容为准，而不是以样本声明的 type 为准。频道、首页、检索页、榜单和目录的中心列表是有效内容；重复子项、列表/表格规模和 linkShare 都只是结构特征，高链接密度本身不代表导航。付费提示、登录浮层或隐私提示出现时，只要 DOM 中仍有可辨识的标题、摘要、正文预览、主视频元数据或中心列表，就提取这些实际可见/可读内容；只有中心内容完全不存在时才 exclude。不要因为内容不完整、篇幅短、不是传统文章或候选草稿质量差而排除页面。

返回一个 JSON 对象，字段严格为：
{
  "status": "extract|exclude",
  "includeRegionIds": ["R..."],
  "excludeRegionIds": ["R..."],
  "requiredBlockIds": ["B..."],
  "forbiddenBlockIds": ["B..."],
  "bestDraft": "A|B|C|none",
  "confidence": "high|medium|low",
  "rationale": "简短说明正文边界依据",
  "visualReviewNeeded": true,
  "excludeReason": "仅 status=exclude 时填写"
}

规则：
1. extract 时 includeRegionIds 至少一个；优先选择最小但完整的中心区域，可多选按 DOM 顺序排列的并列区域，不得同时选择祖先与后代区域。
2. excludeRegionIds 只列 include 区域内部明确应删除的子区域。
3. requiredBlockIds 选择 4-12 个能覆盖开头、中段、结尾及关键结构的正例；短页面可少于 4 个。
4. forbiddenBlockIds 选择 2-8 个明确的导航、推荐、评论、广告或页脚负例；页面没有合适负例可为空。
5. 不补写 DOM 中不存在的事实；不因某份候选更长就偏爱它。
6. visualReviewNeeded 必须为 true，因为你是单模态模型，最终还需人工对照截图复核。
7. exclude 时四个区域/区块 ID 数组均为空，并填写明确的 excludeReason。`;

async function snapshotPacket(page, sample, candidatesDir) {
  const snapshot = resolve(candidatesDir.corpus, sample.snapshot);
  await page.goto(pathToFileURL(snapshot).href, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const dom = await page.evaluate(() => {
    const normalize = value => String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const hiddenByMarkup = element => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden
          || node.getAttribute("aria-hidden") === "true"
          || /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(node.getAttribute("style") || "")) {
          return true;
        }
      }
      return false;
    };
    const visibleText = element => normalize(element?.innerText || "");
    const depth = element => {
      let value = 0;
      for (let node = element; node?.parentElement; node = node.parentElement) value += 1;
      return value;
    };
    const marker = element => {
      const values = [
        element.id ? `#${element.id}` : "",
        ...String(element.className || "").split(/\s+/).filter(Boolean).slice(0, 5).map(value => `.${value}`),
        element.getAttribute("role") ? `[role=${element.getAttribute("role")}]` : "",
        element.getAttribute("itemprop") ? `[itemprop=${element.getAttribute("itemprop")}]` : "",
      ].filter(Boolean);
      return values.join("");
    };
    const semanticRegionSelector = [
      "body", "main", "article", "[role='main']", "[role='article']", "[itemprop='articleBody']",
      "header", "nav", "aside", "footer", "dialog", "form", "figure",
      "[role='banner']", "[role='navigation']", "[role='complementary']", "[role='contentinfo']",
      "[role='dialog']", "[role='alertdialog']",
      "[itemtype$='/VideoObject']", "[itemtype$='/ImageObject']",
    ].join(",");
    const regionSelector = `${semanticRegionSelector},section,div,ul,ol,dl,table`;
    const allRegions = [...document.querySelectorAll(regionSelector)].filter(element => (
      !hiddenByMarkup(element)
      && visibleText(element).length >= (element.matches(semanticRegionSelector) ? 2 : 40)
    ));
    const semantic = new Set(allRegions.filter(element => element.matches(semanticRegionSelector)));
    const generic = allRegions
      .filter(element => !semantic.has(element))
      .sort((left, right) => visibleText(right).length - visibleText(left).length)
      .slice(0, 180);
    const kept = new Set([...semantic, ...generic]);
    const regionElements = allRegions.filter(element => kept.has(element));
    const regionIds = new Map(regionElements.map((element, index) => [element, `R${String(index + 1).padStart(4, "0")}`]));
    for (const [element, id] of regionIds) element.setAttribute("data-qz-review-region", id);

    const blockSelector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption,caption,td,th,dt,dd,time,[rel='author'],[itemprop='headline'],[itemprop='author'],[itemprop='datePublished'],[itemprop='description']";
    const allBlocks = [...document.querySelectorAll(blockSelector)].filter(element => (
      !hiddenByMarkup(element) && visibleText(element).length >= 2
    ));
    const blockElements = allBlocks.length <= 360
      ? allBlocks
      : Array.from({ length: 360 }, (_, index) => allBlocks[Math.floor(
        index * (allBlocks.length - 1) / 359,
      )]);
    const blockIds = new Map(blockElements.map((element, index) => [element, `B${String(index + 1).padStart(4, "0")}`]));
    for (const [element, id] of blockIds) element.setAttribute("data-qz-review-block", id);

    const nearestRegionId = element => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (regionIds.has(node)) return regionIds.get(node);
      }
      return null;
    };
    const sample = (text, size = 120) => text.length <= size * 2
      ? text
      : `${text.slice(0, size)} … ${text.slice(-size)}`;
    return {
      title: document.title,
      bodyChars: visibleText(document.body).length,
      regions: regionElements.map(element => {
        const text = visibleText(element);
        const visibleChildren = [...element.children].filter(child => !hiddenByMarkup(child) && visibleText(child));
        const childTags = visibleChildren.reduce((counts, child) => {
          const tag = child.tagName.toLowerCase();
          counts[tag] = (counts[tag] || 0) + 1;
          return counts;
        }, {});
        const siblingSignature = sibling => [
          sibling.tagName,
          sibling.getAttribute("role") || "",
          sibling.getAttribute("itemprop") || "",
        ].join("|");
        const repeatedSiblings = element.parentElement
          ? [...element.parentElement.children].filter(sibling => (
            !hiddenByMarkup(sibling) && siblingSignature(sibling) === siblingSignature(element)
          )).length
          : 1;
        const linkChars = [...element.querySelectorAll("a")]
          .reduce((sum, link) => sum + visibleText(link).length, 0);
        const headings = [...element.querySelectorAll("h1,h2,h3,h4,h5,h6")]
          .map(visibleText)
          .filter(Boolean)
          .slice(0, 4);
        return {
          id: regionIds.get(element),
          parentId: nearestRegionId(element),
          tag: element.tagName.toLowerCase(),
          marker: marker(element),
          depth: depth(element),
          chars: text.length,
          linkShare: Number((linkChars / Math.max(1, text.length)).toFixed(3)),
          directChildren: visibleChildren.length,
          childTags,
          repeatedSiblings,
          listItems: element.querySelectorAll("li,dt,dd").length,
          tableRows: element.querySelectorAll("tr").length,
          headings,
          text: sample(text),
        };
      }),
      blocks: blockElements.map(element => ({
        id: blockIds.get(element),
        regionId: nearestRegionId(element),
        tag: element.tagName.toLowerCase(),
        text: sample(visibleText(element), 220),
      })),
    };
  });

  const algorithms = ["legacy-readability", "qingzhou-current", "trafilatura-python"];
  const order = stableOrder(sample, algorithms);
  const anonymous = {};
  const identities = {};
  for (let index = 0; index < order.length; index += 1) {
    const letter = String.fromCharCode(65 + index);
    const name = order[index];
    const path = join(candidatesDir.output, "outputs", name, `${sample.id}.json`);
    const value = existsSync(path) ? json(path) : { error: "candidate output missing" };
    anonymous[letter] = {
      mode: value.mode || "",
      error: value.error || "",
      content: compact(value.text || value.markdown || "", 18_000),
    };
    identities[letter] = name;
  }
  return {
    packet: {
      schema: "qingzhou.article-extraction-review-packet.v1",
      sample: {
        id: sample.id,
        inputSha256: sample.inputSha256,
        type: sample.type,
        vertical: sample.vertical,
        siteName: sample.siteName,
        requestedUrl: sample.requestedUrl,
        finalUrl: sample.finalUrl,
        title: sample.title,
      },
      dom,
      anonymousDrafts: anonymous,
    },
    identities,
  };
}

async function materializeLabel(page, sample, seeded, identities, model, usage, requestId, { strict = true } = {}) {
  const raw = seeded && typeof seeded === "object" ? seeded : {};
  if (!["extract", "exclude"].includes(raw.status)) throw new Error(`invalid label status: ${raw.status || "missing"}`);
  const status = raw.status;
  for (const field of ["includeRegionIds", "excludeRegionIds", "requiredBlockIds", "forbiddenBlockIds"]) {
    if (!Array.isArray(raw[field])) throw new Error(`${field} must be an array`);
  }
  const include = [...new Set(Array.isArray(raw.includeRegionIds) ? raw.includeRegionIds.map(String) : [])];
  const exclude = [...new Set(Array.isArray(raw.excludeRegionIds) ? raw.excludeRegionIds.map(String) : [])];
  const required = [...new Set(Array.isArray(raw.requiredBlockIds) ? raw.requiredBlockIds.map(String) : [])];
  const forbidden = [...new Set(Array.isArray(raw.forbiddenBlockIds) ? raw.forbiddenBlockIds.map(String) : [])];
  const excludeReason = normalizedText(raw.excludeReason);
  if (status === "exclude" && (include.length || exclude.length || required.length || forbidden.length)) {
    throw new Error("exclude label must have empty region and block selections");
  }
  if (status === "exclude" && !excludeReason) throw new Error("exclude label requires excludeReason");
  const materialized = await page.evaluate(({ status: nextStatus, includeIds, excludeIds, requiredIds, forbiddenIds }) => {
    const normalize = value => String(value || "")
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const region = id => document.querySelector(`[data-qz-review-region="${CSS.escape(id)}"]`);
    const block = id => document.querySelector(`[data-qz-review-block="${CSS.escape(id)}"]`);
    const missing = {
      include: includeIds.filter(id => !region(id)),
      exclude: excludeIds.filter(id => !region(id)),
      required: requiredIds.filter(id => !block(id)),
      forbidden: forbiddenIds.filter(id => !block(id)),
    };
    if (nextStatus === "exclude") return {
      missing,
      selectionErrors: [],
      orderedIncludeIds: [],
      mainText: "",
      requiredBlocks: [],
      noiseBlocks: [],
      requiredInside: [],
      forbiddenInside: [],
      structures: {},
    };

    const domOrder = (left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    };
    const selected = includeIds.map(region).filter(Boolean).sort(domOrder);
    const excluded = excludeIds.map(region).filter(Boolean);
    const nestedIncludes = selected.some((element, index) => (
      selected.some((other, otherIndex) => otherIndex !== index && other.contains(element))
    ));
    const invalidExcludes = excluded.filter(element => (
      !selected.some(included => included !== element && included.contains(element))
    ));
    const selectionErrors = [];
    if (nestedIncludes) selectionErrors.push("included regions must not contain one another");
    if (invalidExcludes.length) selectionErrors.push("excluded regions must be strict descendants of an included region");
    const retained = element => (
      selected.some(included => included.contains(element))
      && !excluded.some(removed => removed.contains(element))
    );
    const requiredElements = requiredIds.map(block).filter(Boolean);
    const forbiddenElements = forbiddenIds.map(block).filter(Boolean);
    const fragments = selected.map(element => {
      const clone = element.cloneNode(true);
      for (const id of excludeIds) {
        clone.querySelector(`[data-qz-review-region="${CSS.escape(id)}"]`)?.remove();
      }
      clone.querySelectorAll("script,style,noscript,svg,canvas,iframe,template,[hidden],[aria-hidden='true']").forEach(node => node.remove());
      clone.querySelectorAll("[style]").forEach(node => {
        if (/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(node.getAttribute("style") || "")) node.remove();
      });
      const showComment = clone.ownerDocument.defaultView?.NodeFilter?.SHOW_COMMENT || 128;
      const walker = clone.ownerDocument.createTreeWalker(clone, showComment);
      const comments = [];
      while (walker.nextNode()) comments.push(walker.currentNode);
      comments.forEach(node => node.remove());
      clone.querySelectorAll("[data-qz-review-region],[data-qz-review-block]").forEach(node => {
        node.removeAttribute("data-qz-review-region");
        node.removeAttribute("data-qz-review-block");
      });
      return clone;
    });
    const uniqueText = elements => [...new Set(elements
      .map(element => normalize(element.innerText || ""))
      .filter(Boolean))];
    return {
      missing,
      selectionErrors,
      orderedIncludeIds: selected.map(element => element.getAttribute("data-qz-review-region")),
      mainText: normalize(fragments.map(fragment => fragment.textContent || "").join("\n")),
      requiredBlocks: uniqueText(requiredElements),
      noiseBlocks: uniqueText(forbiddenElements),
      requiredInside: requiredElements.map(retained),
      forbiddenInside: forbiddenElements.map(retained),
      structures: {
        headings: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']").length, 0),
        lists: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("ul,ol,dl").length, 0),
        tables: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("table").length, 0),
        codeBlocks: fragments.reduce((sum, fragment) => sum + fragment.querySelectorAll("pre,code").length, 0),
      },
    };
  }, { status, includeIds: include, excludeIds: exclude, requiredIds: required, forbiddenIds: forbidden });

  const missingRegions = [...materialized.missing.include, ...materialized.missing.exclude];
  if (missingRegions.length) throw new Error(`unknown review region ids: ${missingRegions.join(", ")}`);
  if (materialized.selectionErrors.length) throw new Error(materialized.selectionErrors[0]);
  if (status === "extract" && !include.length) throw new Error("extract label has no included region");
  if (status === "extract" && materialized.mainText.length < 2) throw new Error("extract label materialized less than 2 characters");
  const consistencyErrors = [];
  if (status === "extract" && materialized.requiredInside.some(inside => !inside)) {
    consistencyErrors.push("required block falls outside the selected content regions");
  }
  if (status === "extract" && materialized.forbiddenInside.some(Boolean)) {
    consistencyErrors.push("forbidden block remains inside the selected content regions");
  }
  if (strict && consistencyErrors.length) throw new Error(consistencyErrors[0]);
  const bestDraft = ["A", "B", "C"].includes(raw.bestDraft) ? raw.bestDraft : "none";
  return {
    schema: "qingzhou.article-extraction-manual-label.v1",
    sampleId: sample.id,
    inputSha256: sample.inputSha256,
    finalUrl: sample.finalUrl,
    type: sample.type,
    status,
    selection: {
      includeRegionIds: materialized.orderedIncludeIds,
      excludeRegionIds: exclude,
      requiredBlockIds: required,
      forbiddenBlockIds: forbidden,
    },
    reference: {
      method: "deepseek-seed-pending-human-review",
      confidence: "pending",
      mainText: materialized.mainText,
      requiredBlocks: materialized.requiredBlocks,
      noiseBlocks: materialized.noiseBlocks,
      structures: materialized.structures,
      excludeReason,
    },
    seed: {
      model,
      bestDraft,
      bestDraftAlgorithm: identities[bestDraft] || "none",
      confidence: ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "low",
      rationale: normalizedText(raw.rationale),
      visualReviewNeeded: true,
      excludeReason,
      droppedBlockIds: [...materialized.missing.required, ...materialized.missing.forbidden],
      consistencyErrors,
      requestId,
      usage,
    },
    review: {
      status: "pending",
      reviewer: "",
      reviewedAt: null,
      notes: "",
    },
  };
}

async function seedCommand() {
  const corpus = resolve(option("--corpus"));
  const candidates = resolve(option("--candidates"));
  const output = resolve(option("--output", join(corpus, "manual-labels-v1")));
  const keyFile = option("--key-file");
  const model = option("--model", "deepseek-v4-flash");
  const endpoint = option("--endpoint", "https://api.deepseek.com/chat/completions");
  const workers = numberOption("--workers", 4);
  const limit = numberOption("--limit", Number.MAX_SAFE_INTEGER);
  const apiKey = readTestApiKey("deepseek", { keyFile });
  const manifest = json(join(corpus, "manifest.json"));
  const idsFile = option("--ids-file");
  const idsFromLabels = option("--ids-from-labels");
  if (idsFile && idsFromLabels) throw new Error("use only one of --ids-file and --ids-from-labels");
  const requestedIds = idsFile
    ? new Set(readFileSync(resolve(idsFile), "utf8").split(/\s+/).map(value => value.trim()).filter(Boolean))
    : idsFromLabels
      ? new Set(manifest.samples.filter(sample => {
        const path = join(resolve(idsFromLabels), "labels", `${sample.id}.json`);
        return !existsSync(path) || json(path).status !== "extract";
      }).map(sample => sample.id))
      : null;
  const selectedSamples = requestedIds
    ? manifest.samples.filter(sample => requestedIds.has(sample.id))
    : manifest.samples;
  if (requestedIds) {
    const foundIds = new Set(selectedSamples.map(sample => sample.id));
    const missingIds = [...requestedIds].filter(id => !foundIds.has(id));
    if (missingIds.length) throw new Error(`unknown sample ids: ${missingIds.join(", ")}`);
  }
  const samples = selectedSamples.slice(0, limit);
  mkdirSync(join(output, "labels"), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let cursor = 0;
  let completed = 0;
  let reused = 0;
  async function work() {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.route("**/*", route => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    for (;;) {
      const index = cursor++;
      if (index >= samples.length) break;
      const sample = samples[index];
      const labelPath = join(output, "labels", `${sample.id}.json`);
      if (existsSync(labelPath)) {
        const previous = json(labelPath);
        if (previous.inputSha256 === sample.inputSha256) {
          reused += 1;
          continue;
        }
      }
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const { packet, identities } = await snapshotPacket(page, sample, { corpus, output: candidates });
          if (lastError) packet.validationError = lastError.message;
          const response = await callDeepSeek(apiKey, model, endpoint, packet);
          const label = await materializeLabel(
            page,
            sample,
            response.label,
            identities,
            model,
            response.usage,
            response.requestId,
            { strict: attempt < 3 },
          );
          writeJsonAtomic(labelPath, label);
          completed += 1;
          console.log(`seed ${index + 1}/${samples.length} ${sample.id} ${label.status} ${label.seed.confidence}`);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 3) {
            writeJsonAtomic(labelPath, {
              schema: "qingzhou.article-extraction-manual-label.v1",
              sampleId: sample.id,
              inputSha256: sample.inputSha256,
              finalUrl: sample.finalUrl,
              type: sample.type,
              status: "review_required",
              selection: {
                includeRegionIds: [], excludeRegionIds: [], requiredBlockIds: [], forbiddenBlockIds: [],
              },
              reference: {
                method: "deepseek-seed-failed-human-review-required",
                confidence: "pending",
                mainText: "",
                requiredBlocks: [],
                noiseBlocks: [],
                structures: {},
              },
              seed: {
                model,
                bestDraft: "none",
                bestDraftAlgorithm: "none",
                confidence: "low",
                rationale: "",
                visualReviewNeeded: true,
                excludeReason: "",
                requestId: "",
                usage: null,
                error: normalizedText(error?.message || error),
              },
              review: { status: "pending", reviewer: "", reviewedAt: null, notes: "" },
            });
            completed += 1;
            console.log(`seed ${index + 1}/${samples.length} ${sample.id} review_required low`);
          }
        }
      }
    }
    await context.close();
  }
  try {
    await Promise.all(Array.from({ length: Math.min(workers, samples.length) }, work));
  } finally {
    await browser.close();
  }
  const labels = samples.map(sample => json(join(output, "labels", `${sample.id}.json`)));
  const summary = {
    schema: "qingzhou.article-extraction-manual-label-set.v1",
    corpus: join(corpus, "manifest.json"),
    corpusDigest: sha256(readFileSync(join(corpus, "manifest.json"))),
    model,
    modality: "text",
    samples: labels.length,
    completed,
    reused,
    status: Object.fromEntries(["extract", "exclude", "review_required"].map(value => [value, labels.filter(label => label.status === value).length])),
    confidence: Object.fromEntries(["high", "medium", "low"].map(value => [value, labels.filter(label => label.seed.confidence === value).length])),
    pendingHumanReview: labels.filter(label => label.review.status !== "approved").length,
  };
  writeJsonAtomic(join(output, "manifest.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

function ngramF1(left, right, size = 4) {
  const counts = (value) => {
    const text = normalizedText(value);
    const result = new Map();
    if (text.length < size) {
      if (text) result.set(text, 1);
      return result;
    }
    for (let index = 0; index <= text.length - size; index += 1) {
      const gram = text.slice(index, index + size);
      result.set(gram, (result.get(gram) || 0) + 1);
    }
    return result;
  };
  const leftCounts = counts(left);
  const rightCounts = counts(right);
  const leftTotal = [...leftCounts.values()].reduce((sum, value) => sum + value, 0);
  const rightTotal = [...rightCounts.values()].reduce((sum, value) => sum + value, 0);
  if (!leftTotal || !rightTotal) return 0;
  let overlap = 0;
  for (const [gram, count] of leftCounts) overlap += Math.min(count, rightCounts.get(gram) || 0);
  const precision = overlap / leftTotal;
  const recall = overlap / rightTotal;
  return precision + recall ? 2 * precision * recall / (precision + recall) : 0;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function auditFlags(sample, label, drafts, comparison = null) {
  const flags = [];
  if (!label) return ["missing-label"];
  if (!sample.screenshot) flags.push("missing-screenshot");
  if (label.status === "exclude") flags.push("excluded-page");
  if (label.status === "review_required") flags.push("seed-failed");
  if (comparison) {
    if (label.status !== comparison.status) flags.push("seed-status-disagreement");
    else if (label.status === "extract" && ngramF1(label.reference?.mainText, comparison.reference?.mainText) < 0.85) {
      flags.push("seed-boundary-disagreement");
    }
  }
  if (label.seed?.confidence !== "high") flags.push(`${label.seed?.confidence || "unknown"}-confidence`);
  if (label.seed?.droppedBlockIds?.length) flags.push("unknown-block-id-dropped");
  if (label.seed?.consistencyErrors?.length) flags.push("seed-consistency-error");
  const mainText = normalizedText(label.reference?.mainText);
  if (label.status === "extract" && mainText.length < 100) flags.push("short-gold");
  if (mainText.length > 60_000) flags.push("very-long-gold");
  const required = (label.reference?.requiredBlocks || []).map(normalizedText).filter(Boolean);
  const noise = (label.reference?.noiseBlocks || []).map(normalizedText).filter(Boolean);
  if (new Set(required).size !== required.length) flags.push("duplicate-required");
  if (label.status === "extract" && !required.length) flags.push("no-required-block");
  if (required.some(block => !mainText.includes(block))) flags.push("required-outside-gold");
  if (noise.some(block => block.length >= 8 && mainText.includes(block))) flags.push("noise-inside-gold");
  if (label.status === "extract" && mainText.length >= 500 && required.length < 4) flags.push("few-required-blocks");
  const draftScores = Object.values(drafts).map(value => ngramF1(value, mainText));
  if (label.status === "extract" && Math.max(0, ...draftScores) < 0.55) flags.push("no-close-draft");
  const pairScores = [
    ngramF1(drafts.A, drafts.B),
    ngramF1(drafts.A, drafts.C),
    ngramF1(drafts.B, drafts.C),
  ];
  if (Math.min(...pairScores) < 0.35) flags.push("strong-algorithm-disagreement");
  return flags;
}

async function auditCommand() {
  const corpus = resolve(option("--corpus"));
  const candidates = resolve(option("--candidates"));
  const labelsDir = resolve(option("--labels"));
  const compareLabelsDir = option("--compare-labels") ? resolve(option("--compare-labels")) : "";
  const manifest = json(join(corpus, "manifest.json"));
  const rows = manifest.samples.map(sample => {
    const labelPath = join(labelsDir, "labels", `${sample.id}.json`);
    const label = existsSync(labelPath) ? json(labelPath) : null;
    const comparisonPath = compareLabelsDir ? join(compareLabelsDir, "labels", `${sample.id}.json`) : "";
    const comparison = comparisonPath && existsSync(comparisonPath) ? json(comparisonPath) : null;
    const names = ["legacy-readability", "qingzhou-current", "trafilatura-python"];
    const order = stableOrder(sample, names);
    const drafts = {};
    const identities = {};
    for (let index = 0; index < order.length; index += 1) {
      const letter = String.fromCharCode(65 + index);
      const path = join(candidates, "outputs", order[index], `${sample.id}.json`);
      const value = existsSync(path) ? json(path) : {};
      drafts[letter] = String(value.markdown || value.text || "");
      identities[letter] = order[index];
    }
    return {
      sample,
      label,
      drafts,
      identities,
      comparison,
      flags: auditFlags(sample, label, drafts, comparison),
      scores: Object.fromEntries(Object.entries(drafts).map(([name, value]) => [
        name,
        ngramF1(value, label?.reference?.mainText || ""),
      ])),
    };
  });
  const audit = {
    schema: "qingzhou.article-extraction-manual-audit.v1",
    generatedAt: new Date().toISOString(),
    corpus: join(corpus, "manifest.json"),
    labels: labelsDir,
    samples: rows.length,
    flagged: rows.filter(row => row.flags.length).length,
    flags: Object.fromEntries([...new Set(rows.flatMap(row => row.flags))].sort().map(flag => [
      flag,
      rows.filter(row => row.flags.includes(flag)).length,
    ])),
    rows: rows.map(({ sample, label, flags, scores }) => ({
      id: sample.id,
      siteId: sample.siteId,
      siteName: sample.siteName,
      type: sample.type,
      finalUrl: sample.finalUrl,
      screenshot: sample.screenshot,
      status: label?.status || "missing",
      seedConfidence: label?.seed?.confidence || "",
      mainChars: normalizedText(label?.reference?.mainText).length,
      requiredBlocks: label?.reference?.requiredBlocks?.length || 0,
      noiseBlocks: label?.reference?.noiseBlocks?.length || 0,
      flags,
      scores,
    })),
  };
  writeJsonAtomic(join(labelsDir, "audit.json"), audit);

  const cards = rows.map(({ sample, label, comparison, drafts, flags, scores }) => {
    const screenshot = sample.screenshot ? `../${sample.screenshot}` : "";
    const required = (label?.reference?.requiredBlocks || []).map(value => `<li>${escapeHtml(value)}</li>`).join("");
    const noise = (label?.reference?.noiseBlocks || []).map(value => `<li>${escapeHtml(value)}</li>`).join("");
    const draftHtml = Object.entries(drafts).map(([name, value]) => `
      <details><summary>匿名草稿 ${name} · 与 gold F1 ${scores[name].toFixed(3)}</summary><pre>${escapeHtml(compact(value, 6_000))}</pre></details>
    `).join("");
    return `
      <article class="sample ${flags.length ? "flagged" : "clean"}" id="${sample.id}" data-flags="${escapeHtml(flags.join(" "))}">
        <header>
          <div><strong>${sample.id}</strong> · ${escapeHtml(sample.siteName)} · ${escapeHtml(sample.type)} · ${escapeHtml(label?.status || "missing")}</div>
          <a href="${escapeHtml(sample.finalUrl)}">${escapeHtml(sample.title)}</a>
          <div class="flags">${flags.map(flag => `<span>${escapeHtml(flag)}</span>`).join("") || "<span>no automatic flag</span>"}</div>
        </header>
        <div class="grid">
          <div>${screenshot ? `<img loading="lazy" src="${escapeHtml(screenshot)}" alt="${sample.id} screenshot">` : "<p>无截图</p>"}</div>
          <div>
            <p><b>初标置信度：</b>${escapeHtml(label?.seed?.confidence)}　<b>Gold 字符：</b>${normalizedText(label?.reference?.mainText).length}</p>
            <p><b>边界说明：</b>${escapeHtml(label?.seed?.rationale)}</p>
            ${comparison ? `<p><b>独立复标：</b>${escapeHtml(comparison.status)} · ${escapeHtml(comparison.seed?.confidence)} · gold F1 ${ngramF1(label?.reference?.mainText, comparison.reference?.mainText).toFixed(3)}</p>` : ""}
            <details open><summary>人工 gold 文本</summary><pre>${escapeHtml(compact(label?.reference?.mainText || "", 12_000))}</pre></details>
            <details><summary>必须保留 (${label?.reference?.requiredBlocks?.length || 0})</summary><ul>${required}</ul></details>
            <details><summary>必须排除 (${label?.reference?.noiseBlocks?.length || 0})</summary><ul>${noise}</ul></details>
            ${draftHtml}
          </div>
        </div>
      </article>
    `;
  }).join("\n");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>中文正文 500 页人工复核</title><style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#f4f4f2;color:#202124}nav{position:sticky;top:0;z-index:2;display:flex;gap:12px;align-items:center;padding:12px 20px;background:#fff;border-bottom:1px solid #ddd}nav input{min-width:320px;padding:8px 10px}.count{color:#777}.samples{max-width:1500px;margin:auto;padding:18px}.sample{margin:0 0 18px;background:#fff;border:1px solid #ddd;border-radius:12px;overflow:hidden}.sample.flagged{border-color:#c88}.sample>header{padding:14px 16px;border-bottom:1px solid #eee}.sample header a{display:block;color:#555;margin-top:4px}.flags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.flags span{font-size:12px;padding:3px 7px;border-radius:999px;background:#eee}.flagged .flags span{background:#fde5e2}.grid{display:grid;grid-template-columns:minmax(320px,44%) 1fr;gap:16px;padding:16px}.grid img{display:block;width:100%;height:auto;border:1px solid #ddd}.grid pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:460px;overflow:auto;background:#f7f7f7;padding:12px;border-radius:8px}details{margin:10px 0}li{margin:5px 0}@media(max-width:900px){.grid{grid-template-columns:1fr}}
    @media(prefers-color-scheme:dark){body{background:#171717;color:#eee}nav,.sample{background:#222}.grid pre{background:#181818}.sample>header{border-color:#444}.flags span{background:#444}}
  </style></head><body><nav><b>中文正文人工复核</b><button id="all">全部</button><button id="flagged">仅风险项</button><input id="search" placeholder="样本 / 站点 / flag"><span class="count"></span></nav><main class="samples">${cards}</main><script>
    const samples=[...document.querySelectorAll('.sample')], count=document.querySelector('.count'), search=document.querySelector('#search');
    let mode='all'; function render(){const q=search.value.trim().toLowerCase();let visible=0;for(const sample of samples){const keep=(mode==='all'||sample.classList.contains('flagged'))&&(!q||sample.textContent.toLowerCase().includes(q)||sample.dataset.flags.includes(q));sample.hidden=!keep;if(keep)visible++}count.textContent=visible+' / '+samples.length}document.querySelector('#all').onclick=()=>{mode='all';render()};document.querySelector('#flagged').onclick=()=>{mode='flagged';render()};search.oninput=render;render();
  </script></body></html>`;
  writeFileSync(join(labelsDir, "audit.html"), html);
  console.log(JSON.stringify({ audit: join(labelsDir, "audit.json"), html: join(labelsDir, "audit.html"), samples: audit.samples, flagged: audit.flagged, flags: audit.flags }, null, 2));
}

async function inspectCommand() {
  const corpus = resolve(option("--corpus"));
  const candidates = resolve(option("--candidates"));
  const sampleId = option("--id");
  if (!sampleId) throw new Error("inspect requires --id");
  const manifest = json(join(corpus, "manifest.json"));
  const sample = manifest.samples.find(item => item.id === sampleId);
  if (!sample) throw new Error(`unknown sample id: ${sampleId}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.route("**/*", route => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    const value = await snapshotPacket(page, sample, { corpus, output: candidates });
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function finalizeCommand() {
  const corpus = resolve(option("--corpus"));
  const candidates = resolve(option("--candidates"));
  const decisionsPath = resolve(option("--decisions"));
  const output = resolve(option("--output"));
  if (!option("--decisions")) throw new Error("finalize requires --decisions");
  if (!option("--output")) throw new Error("finalize requires --output");
  if (existsSync(output)) throw new Error(`final label directory already exists: ${output}`);
  const sourceDirectories = Object.fromEntries(["v1", "v2", "v3", "v4"]
    .map(name => [name, option(`--source-${name}`)])
    .filter(([, value]) => value)
    .map(([name, value]) => [name, resolve(value)]));
  const manifestPath = join(corpus, "manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes);
  manifest.samples.forEach(sample => assertReviewScreenshot(corpus, sample));
  const decisions = json(decisionsPath);
  if (decisions.schema !== "qingzhou.article-extraction-manual-decisions.v1") {
    throw new Error(`unsupported decisions schema: ${decisions.schema || "missing"}`);
  }
  const corpusDigest = sha256(manifestBytes);
  if (decisions.corpusDigest !== corpusDigest) throw new Error("decisions corpus digest does not match the frozen corpus");
  if (!normalizedText(decisions.reviewer)) throw new Error("decisions reviewer is required");
  if (!Array.isArray(decisions.samples)) throw new Error("decisions samples must be an array");
  const decisionsById = new Map();
  for (const decision of decisions.samples) {
    const id = String(decision?.id || "");
    if (!id) throw new Error("decision is missing id");
    if (decisionsById.has(id)) throw new Error(`duplicate decision: ${id}`);
    decisionsById.set(id, decision);
  }
  const corpusIds = new Set(manifest.samples.map(sample => sample.id));
  const missing = manifest.samples.filter(sample => !decisionsById.has(sample.id)).map(sample => sample.id);
  const unknown = [...decisionsById.keys()].filter(id => !corpusIds.has(id));
  if (missing.length || unknown.length) {
    throw new Error(`decisions must cover the corpus exactly (missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"})`);
  }

  const browser = await chromium.launch({ headless: true });
  const finalized = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    await context.route("**/*", route => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
    const page = await context.newPage();
    for (let index = 0; index < manifest.samples.length; index += 1) {
      const sample = manifest.samples[index];
      const decision = decisionsById.get(sample.id);
      if (decision.domReviewed !== true) throw new Error(`${sample.id} is not marked domReviewed`);
      if (sample.screenshot && decision.screenshotReviewed !== true) {
        throw new Error(`${sample.id} has a screenshot but is not marked screenshotReviewed`);
      }
      let raw;
      let sourceLabel = null;
      if (decision.source === "manual") {
        raw = {
          status: decision.status,
          includeRegionIds: decision.selection?.includeRegionIds,
          excludeRegionIds: decision.selection?.excludeRegionIds,
          requiredBlockIds: decision.selection?.requiredBlockIds,
          forbiddenBlockIds: decision.selection?.forbiddenBlockIds,
          bestDraft: "none",
          confidence: "high",
          rationale: decision.notes,
          excludeReason: decision.excludeReason,
        };
      } else {
        const sourceDirectory = sourceDirectories[decision.source];
        if (!sourceDirectory) throw new Error(`${sample.id} references unknown or unconfigured source: ${decision.source}`);
        const sourcePath = join(sourceDirectory, "labels", `${sample.id}.json`);
        if (!existsSync(sourcePath)) throw new Error(`${sample.id} source label is missing from ${decision.source}`);
        sourceLabel = json(sourcePath);
        if (sourceLabel.sampleId !== sample.id || sourceLabel.inputSha256 !== sample.inputSha256) {
          throw new Error(`${sample.id} source label does not match the frozen DOM`);
        }
        if (!["extract", "exclude"].includes(sourceLabel.status)) {
          throw new Error(`${sample.id} source label has unresolved status: ${sourceLabel.status}`);
        }
        raw = {
          status: sourceLabel.status,
          includeRegionIds: sourceLabel.selection?.includeRegionIds,
          excludeRegionIds: sourceLabel.selection?.excludeRegionIds,
          requiredBlockIds: sourceLabel.selection?.requiredBlockIds,
          forbiddenBlockIds: sourceLabel.selection?.forbiddenBlockIds,
          bestDraft: "none",
          confidence: "high",
          rationale: decision.notes || sourceLabel.seed?.rationale,
          excludeReason: decision.excludeReason
            || sourceLabel.reference?.excludeReason
            || sourceLabel.seed?.excludeReason,
        };
      }
      await snapshotPacket(page, sample, { corpus, output: candidates });
      const label = await materializeLabel(page, sample, raw, {}, "", null, "", { strict: true });
      if (label.seed.droppedBlockIds.length) {
        throw new Error(`${sample.id} final decision contains unknown block ids: ${label.seed.droppedBlockIds.join(", ")}`);
      }
      label.reference.method = "human-reviewed-frozen-dom";
      label.reference.confidence = "high";
      label.seed = {
        source: decision.source,
        sourceModel: sourceLabel?.seed?.model || "",
        sourceConfidence: sourceLabel?.seed?.confidence || "",
        rationale: normalizedText(raw.rationale),
        excludeReason: label.reference.excludeReason,
      };
      label.review = {
        status: "approved",
        reviewer: normalizedText(decisions.reviewer),
        reviewedAt: decisions.reviewedAt || null,
        domReviewed: true,
        screenshotReviewed: Boolean(sample.screenshot),
        notes: normalizedText(decision.notes),
      };
      finalized.push(label);
      console.log(`finalize ${index + 1}/${manifest.samples.length} ${sample.id} ${label.status} ${decision.source}`);
    }
    await context.close();
  } finally {
    await browser.close();
  }

  const temporary = `${output}.${process.pid}.tmp`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    mkdirSync(join(temporary, "labels"), { recursive: true });
    for (const label of finalized) writeFileSync(join(temporary, "labels", `${label.sampleId}.json`), `${JSON.stringify(label, null, 2)}\n`);
    const summary = {
      schema: "qingzhou.article-extraction-manual-label-set.v1",
      corpus: manifestPath,
      corpusDigest,
      method: "human-reviewed-frozen-dom",
      reviewer: normalizedText(decisions.reviewer),
      reviewedAt: decisions.reviewedAt || null,
      samples: finalized.length,
      status: Object.fromEntries(["extract", "exclude"].map(value => [value, finalized.filter(label => label.status === value).length])),
      pendingHumanReview: 0,
      decisionsSha256: sha256(readFileSync(decisionsPath)),
    };
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(summary, null, 2)}\n`);
    renameSync(temporary, output);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

if (command === "seed") {
  await seedCommand();
} else if (command === "audit") {
  await auditCommand();
} else if (command === "inspect") {
  await inspectCommand();
} else if (command === "finalize") {
  await finalizeCommand();
} else {
  throw new Error(`unknown command: ${command}`);
}
