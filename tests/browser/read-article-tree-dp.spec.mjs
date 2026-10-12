import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTestExtension } from "../support/extension-build.mjs";

import { expect, test, testAssetUrl } from "./fixtures.mjs";

const extractorScripts = [
  "extension/content/article-extractor.js",
];
let legacyOnlyArticleExtractorSource;
let treeDpProbeArticleExtractorSource;

test.beforeAll(async () => {
  const extensionDir = await ensureTestExtension();
  const articleExtractorPath = join(extensionDir, "content/article-extractor.js");
  const articleExtractorSource = readFileSync(articleExtractorPath, "utf8");
  const treeDpProductGate = "if (hanDominantDocument(doc)) {";
  if (articleExtractorSource.split(treeDpProductGate).length !== 2) {
    throw new Error("Tree-DP product gate must have one unambiguous test seam");
  }
  legacyOnlyArticleExtractorSource = articleExtractorSource.replace(
    treeDpProductGate,
    `if (false && hanDominantDocument(doc)) {`,
  );
  const extractorExport = "host.QingzhouArticleExtractor = Object.freeze({ extract });";
  if (articleExtractorSource.split(extractorExport).length !== 2) {
    throw new Error("article extractor export must have one unambiguous test seam");
  }
  treeDpProbeArticleExtractorSource = articleExtractorSource.replace(
    extractorExport,
    "globalThis.QingzhouArticleExtractor = Object.freeze({ extract, __testTreeDpExtract: treeDpExtract });",
  );
});

async function installExtractor(page, html, { disableTreeDp = false, exposeTreeDp = false } = {}) {
  await page.setContent(`<base href="https://example.test/">${html}`);
  for (const script of extractorScripts) {
    if (script === "extension/content/article-extractor.js" && (disableTreeDp || exposeTreeDp)) {
      await page.addScriptTag({
        content: exposeTreeDp ? treeDpProbeArticleExtractorSource : legacyOnlyArticleExtractorSource,
      });
    } else {
      await page.addScriptTag({ url: testAssetUrl(script) });
    }
  }
}

async function extractCandidate(page) {
  return page.evaluate(() => {
    const candidate = window.QingzhouArticleExtractor.extract(document);
    return candidate && {
      name: candidate.name,
      text: candidate.text,
      length: candidate.length,
    };
  });
}

async function extractWithElementReadability(page, selector, { complete = true } = {}) {
  return page.evaluate(({ targetSelector, complete }) => {
    const element = document.querySelector(targetSelector);
    const readability = {
      content: `<article>${element.outerHTML}</article>`,
      textContent: element.innerText,
    };
    const candidate = window.QingzhouArticleExtractor.extract(document, {
      readability,
      complete,
    });
    const linkTextLength = [...candidate.root.querySelectorAll("a")]
      .reduce((sum, link) => sum + link.innerText.trim().length, 0);
    return candidate && {
      name: candidate.name,
      text: candidate.text,
      length: candidate.length,
      linkShare: linkTextLength / candidate.length,
    };
  }, { targetSelector: selector, complete });
}

test("tree-DP with no valid root falls through instead of returning the whole body", async ({ page }) => {
  await installExtractor(page, `
    <header class="site-header"><nav><a href="/">首页</a><a href="/login">登录</a></nav></header>
    <article>
      <a href="/story">海洋观测任务完成首次深水连续采样。研究团队公布了本轮任务的观测结论、验证记录和仪器状态，完整说明采样过程、数据质量、航次安排及下一阶段计划。相关资料经过多轮复核，并向参与单位开放基础数据、技术报告和连续观测结果。</a>
    </article>
    <footer>下载客户端 联系客服 隐私设置</footer>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("海洋观测任务完成首次深水连续采样");
  expect(candidate.text).not.toContain("登录");
  expect(candidate.text).not.toContain("下载客户端");
});

test("tree-DP rescue expands the first repeated card into the complete central collection", async ({ page }) => {
  const cards = Array.from({ length: 10 }, (_, index) => `
    <article class="result-card">
      <h2>观测条目 ${index + 1}</h2>
      <div>${`第 ${index + 1} 项结果 独立事实 数据来源 影响范围 复核结论 后续计划 `.repeat(9)}</div>
    </article>
  `).join("");
  const navigation = Array.from({ length: 30 }, (_, index) => (
    `<a href="/nav/${index}">站点导航栏目 ${index + 1} 与服务入口</a>`
  )).join("");
  const html = `
    <header class="site-header"><nav>${navigation}</nav></header>
    <main class="main-content">${cards}</main>
  `;

  const extractWithFirstCardReadability = target => target.evaluate(() => {
    const firstCard = document.querySelector(".result-card");
    const readability = {
      content: firstCard.outerHTML,
      textContent: firstCard.innerText,
    };
    const candidate = window.QingzhouArticleExtractor.extract(document, { readability });
    return candidate && { text: candidate.text, length: candidate.length };
  });

  await installExtractor(page, html);
  const candidate = await extractWithFirstCardReadability(page);

  const legacyOnlyPage = await page.context().newPage();
  let legacyOnly;
  try {
    await installExtractor(legacyOnlyPage, html, { disableTreeDp: true });
    legacyOnly = await extractWithFirstCardReadability(legacyOnlyPage);
  } finally {
    await legacyOnlyPage.close();
  }

  expect(candidate.text).toContain("第 1 项结果 独立事实");
  expect(candidate.text).toContain("第 10 项结果 独立事实");
  expect(candidate.text).not.toContain("站点导航栏目");
  expect(legacyOnly.text).toContain("第 1 项结果 独立事实");
  expect(legacyOnly.text).not.toContain("第 10 项结果 独立事实");
  expect(candidate.length).toBeGreaterThan(legacyOnly.length * 2);
});

test("a coherent link-rich collection can bypass the conservative clear-gain caps", async ({ page }) => {
  const entries = Array.from({ length: 12 }, (_, index) => `
    <a class="catalog-entry" href="/entry/${index}">
      <h2>资料条目 ${index + 1}</h2>
      <span>${`第 ${index + 1} 项资料包含事实摘要、来源说明、影响范围、复核结论和后续安排。`.repeat(10)}</span>
    </a>
  `).join("");
  const html = `
    <header class="site-header"><nav><a href="/">首页</a><a href="/account">账户</a></nav></header>
    <main class="catalog-content">${entries}</main>
    <footer class="site-footer">版权声明 联系方式</footer>
  `;

  await installExtractor(page, html);
  const candidate = await extractWithElementReadability(page, ".catalog-entry");
  const articleMode = await extractWithElementReadability(page, ".catalog-entry", { complete: false });

  const legacyOnlyPage = await page.context().newPage();
  let legacyOnly;
  try {
    await installExtractor(legacyOnlyPage, html, { disableTreeDp: true });
    legacyOnly = await extractWithElementReadability(legacyOnlyPage, ".catalog-entry");
  } finally {
    await legacyOnlyPage.close();
  }

  expect(candidate.linkShare).toBeGreaterThan(0.8);
  expect(candidate.text).toContain("资料条目 12");
  expect(articleMode.text).not.toContain("资料条目 12");
  expect(legacyOnly.text).not.toContain("资料条目 12");
});

test("confidence evaluates the materialized candidate and never shrinks the legacy text", async ({ page }) => {
  const entries = Array.from({ length: 3 }, (_, index) => `
    <a class="entry" href="/${index}"><span>资料条目 ${index + 1}：${
      `第 ${index + 1} 项包含完整事实来源影响范围复核结论后续安排。`.repeat(10)
    }</span></a>
  `).join("");
  await installExtractor(page, `
    <header class="footer">${"登录注册下载客户端账户设置".repeat(30)}</header>
    <main class="main-content">
      <nav>${entries}</nav>
      <div class="tiny">${"仅剩错误摘要这一小段。".repeat(10)}</div>
    </main>
  `);

  const result = await page.evaluate(() => {
    const first = document.querySelector(".entry");
    const readability = { content: first.outerHTML, textContent: first.innerText };
    const article = window.QingzhouArticleExtractor.extract(document, { readability, complete: false });
    const complete = window.QingzhouArticleExtractor.extract(document, { readability, complete: true });
    return {
      article: { name: article?.name, text: article?.text, length: article?.length || 0 },
      complete: { name: complete?.name, text: complete?.text, length: complete?.length || 0 },
    };
  });

  expect(result.article.name).toBe("readability");
  expect(result.article.length).toBeGreaterThan(200);
  expect(result.article.text).toContain("第 1 项包含完整事实来源影响范围");
  expect(result.complete.length).toBeGreaterThanOrEqual(result.article.length);
  expect(result.complete.text).toContain("资料条目 1");
  expect(result.complete.text).not.toBe("仅剩错误摘要这一小段。".repeat(10));
});

test("a BODY include root is expanded instead of nesting BODY inside the candidate wrapper", async ({ page }) => {
  await installExtractor(page, `
    <main>${"这是正文内容，包含完整事实、证据、影响范围与结论。".repeat(30)}</main>
  `, { exposeTreeDp: true });

  const candidate = await page.evaluate(() => {
    const value = window.QingzhouArticleExtractor.__testTreeDpExtract(document);
    return value && {
      name: value.name,
      content: value.content,
      hasNestedBody: Boolean(value.root.querySelector("body")),
    };
  });

  expect(candidate.name).toBe("tree-dp");
  expect(candidate.hasNestedBody).toBe(false);
  expect(candidate.content).not.toMatch(/<body(?:\s|>)/i);
  expect(candidate.content).toContain("这是正文内容");
});

test("dependent content is emitted only through a legal ancestor root", async ({ page }) => {
  await installExtractor(page, `
    <footer class="footer"><a>${"登录注册下载账户服务入口".repeat(100)}</a></footer>
    <main><ul>X<li>${"正文包含完整事实、证据来源、影响范围、复核结论和后续安排。".repeat(20)}</li></ul></main>
  `, { exposeTreeDp: true });

  const candidate = await page.evaluate(() => {
    const value = window.QingzhouArticleExtractor.__testTreeDpExtract(document);
    return value && {
      content: value.content,
      firstTag: value.root.firstElementChild?.tagName || "",
      orphan: Boolean(value.root.querySelector(":scope > li, :scope > dt, :scope > dd, :scope > tr, :scope > td, :scope > th")),
    };
  });
  expect(candidate).not.toBeNull();
  expect(candidate.firstTag).toBe("MAIN");
  expect(candidate.orphan).toBe(false);
  expect(candidate.content).toContain("<ul>");
  expect(candidate.content).toContain("<li>");
});

test("phrasing wrappers around a malformed page cannot become Tree-DP roots", async ({ page }) => {
  const cards = Array.from({ length: 20 }, (_, index) => `
    <div class="item">
      <h3>杭州资讯条目 ${index + 1}</h3>
      <p>第 ${index + 1} 条包含事实来源、影响范围、复核结论与后续安排。</p>
    </div>
  `).join("");
  await installExtractor(page, `
    <em><em>
      <div class="top">登录 注册 下载客户端</div>
      ${cards}
      <div class="bottom">版权 联系我们</div>
    </em></em>
  `, { exposeTreeDp: true });

  const candidate = await page.evaluate(() => {
    const value = window.QingzhouArticleExtractor.__testTreeDpExtract(document);
    return value && { text: value.text };
  });

  expect(candidate).toBeNull();
});

test("a link-rich near-lookalike with retained boilerplate stays on the legacy path", async ({ page }) => {
  const entries = Array.from({ length: 12 }, (_, index) => `
    <a class="catalog-entry" href="/entry/${index}">
      <h2>候选条目 ${index + 1}</h2>
      <span>${`第 ${index + 1} 项候选资料包含简要说明、相关入口、下载方式和服务指引。`.repeat(10)}</span>
    </a>
  `).join("");
  await installExtractor(page, `
    <header class="site-header"><nav><a href="/">首页</a><a href="/account">账户</a></nav></header>
    <main class="catalog-content">
      ${entries}
      <a class="catalog-entry promo" href="/promo">
        <h2>推广专栏</h2>
        <span>${"推广服务提醒用户登录、注册、下载客户端并关注相关入口。".repeat(10)}</span>
      </a>
    </main>
    <footer class="site-footer">版权声明 联系方式</footer>
  `);

  const candidate = await extractWithElementReadability(page, ".catalog-entry");
  expect(candidate.text).toContain("候选条目 1");
  expect(candidate.text).not.toContain("候选条目 12");
});

test("tree-DP rescue keeps the legacy boundary when an expansion drops its ending", async ({ page }) => {
  const intro = `${"调查报告首先说明样本范围、采集方法和复核过程。".repeat(5)}唯一的报告结束语必须保留。`;
  const cards = Array.from({ length: 7 }, (_, index) => `
    <section class="result-card">
      <h2>扩展条目 ${index + 1}</h2>
      <p>${`第 ${index + 1} 项扩展材料包含独立数据、行业背景和后续判断。`.repeat(4)}</p>
    </section>
  `).join("");
  const navigation = Array.from({ length: 18 }, (_, index) => (
    `<a href="/nav/${index}">公共导航与服务入口 ${index + 1}</a>`
  )).join("");
  await installExtractor(page, `
    <header><nav>${navigation}</nav></header>
    <main class="main-content">
      <div class="article-content related-panel"><h1>专项调查报告</h1><p>${intro}</p></div>
      ${cards}
    </main>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("唯一的报告结束语必须保留");
});

test("link-heavy expansions never replace a focused legacy article", async ({ page }) => {
  const intro = "专题说明记录了采样范围、数据口径、验证过程与最终结论。".repeat(5);
  const links = Array.from({ length: 12 }, (_, index) => `
    <a class="catalog-entry" href="/catalog/${index}">目录链接 ${index + 1}：${"查看完整服务、下载资料与进入相关栏目。".repeat(4)}</a>
  `).join("");
  await installExtractor(page, `
    <header><nav>${"公共服务导航入口。".repeat(20)}</nav></header>
    <main class="main-content">
      <div class="article-content"><h1>专题说明</h1><p>${intro}</p></div>
      <section class="catalog-grid">${links}</section>
    </main>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("专题说明记录了采样范围");
  expect(candidate.text).not.toContain("目录链接 12");
});

test("media-player chrome never replaces a complete article", async ({ page }) => {
  const overlays = [
    "这里的细节太精彩了",
    "镜头切换真的很流畅",
    "这一段我看了很多遍",
    "背景音乐配合得很好",
    "队友记得关闭提示灯",
    "前方高能注意画面变化",
    "这个操作值得反复学习",
    "时间会证明这个判断",
    "终于等到完整版本发布",
    "大家不要错过最后一段",
    "画面中的伏笔终于揭晓",
    "结尾还有重要补充内容",
  ].map(text => `<div class="overlay-line">${text}</div>`).join("");
  await installExtractor(page, `
    <article class="article-content">
      <h1>远洋科考任务完成年度调查</h1>
      <p>播放 33.0 万 · 发布于 2026-08-09</p>
      <p>${"科考队公开了本次航次的主要发现、基础数据、仪器状态、复核记录和后续调查计划。".repeat(8)}</p>
    </article>
    <div class="media-player">
      <video controls></video>
      <div class="overlay-stream">${overlays}</div>
      <div class="player-login">登录后观看完整内容</div>
      <button>发送</button>
    </div>
  `);

  const candidate = await extractCandidate(page);
  expect(candidate.text).toContain("远洋科考任务完成年度调查");
  expect(candidate.text).toContain("主要发现、基础数据");
  expect(candidate.text).not.toContain("这里的细节太精彩了");
  expect(candidate.text).not.toContain("登录后观看完整内容");
});
