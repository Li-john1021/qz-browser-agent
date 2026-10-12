import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

import {
  realworldRunner,
  readabilityScript,
  articleExtractorScript,
  digest,
  fastCaptureSettleArgs,
  runAsync,
} from "../support/article-extraction-benchmark.mjs";

test("live capture rejects generic challenge and login redirects without matching a normal verify query", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-interstitials-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const normalText = "这是一篇讨论账号登录体验的正常产品文章，URL 查询参数不应把正文误判为验证页。".repeat(18);
  const server = createServer((request, response) => {
    if (request.url === "/challenge-start") {
      response.writeHead(302, { location: "/verify/v2/app/general_page" });
      response.end();
      return;
    }
    if (request.url === "/login-start") {
      response.writeHead(302, { location: "/weblogin?redirect=%2Fcompany" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/verify/v2/app/general_page") {
      response.end(`<html><head><title>验证中心</title></head><body><main>${"访问验证 请完成人机验证".repeat(8)}</main></body></html>`);
      return;
    }
    if (request.url?.startsWith("/weblogin")) {
      response.end(`<html><head><title>会员登录</title></head><body><main>${"扫码登录或使用手机号登录后继续".repeat(24)}</main></body></html>`);
      return;
    }
    if (request.url === "/security-verification") {
      response.end(`<html><head><title>Security Verification</title></head><body><main>${"Please complete the check".repeat(12)}</main></body></html>`);
      return;
    }
    if (request.url === "/missing") {
      response.end(`<html><head><title>404-页面不存在</title></head><body><main>${"当前地址没有可展示的页面，请返回首页。".repeat(12)}</main></body></html>`);
      return;
    }
    response.end(`<html><head><title>正常正文</title></head><body><article><h1>正常正文</h1><p>${normalText}</p><a href="/account/login">账号登录入口</a></article></body></html>`);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = join(fixtureRoot, "config.json");
  const output = join(fixtureRoot, "capture");
  writeFileSync(config, `${JSON.stringify({
    schema: "qingzhou.article-extraction-sites.v1",
    sampleTarget: 1,
    strictSiteQuotas: true,
    sites: [{
      id: "fixture",
      name: "Fixture",
      vertical: "test",
      quota: 1,
      evaluationSplit: "validation",
      siteFamily: "fixture-group",
      hosts: ["127.0.0.1"],
      seeds: [
        { type: "detail", url: `${origin}/challenge-start` },
        { type: "detail", url: `${origin}/login-start` },
        { type: "detail", url: `${origin}/security-verification` },
        { type: "detail", url: `${origin}/missing` },
        { type: "detail", url: `${origin}/article?verify=content` },
      ],
      detailPatterns: [],
    }],
  }, null, 2)}\n`);
  const result = await runAsync(process.execPath, [
    realworldRunner,
    "capture",
    "--config", config,
    "--output", output,
    "--workers", "1",
    "--screenshots",
    ...fastCaptureSettleArgs,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.equal(manifest.captured, 1);
  assert.deepEqual(manifest.failures.map(item => item.failure), ["challenge", "login_wall", "challenge", "error_shell"]);
  assert.match(manifest.failures[0].finalUrl, /\/verify\/v2\/app\/general_page$/);
  assert.match(manifest.failures[1].finalUrl, /\/weblogin\?/);
  assert.match(manifest.samples[0].requestedUrl, /\?verify=content$/);
  assert.equal(manifest.samples[0].evaluationSplit, "validation");
  assert.equal(manifest.samples[0].siteFamily, "fixture-group");
  assert.equal(digest(readFileSync(join(output, manifest.samples[0].screenshot))), manifest.samples[0].screenshotSha256);
});

test("strict site quotas preserve site diversity instead of filling a failed site from another site's reserve", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-strict-quota-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const requests = new Map();
  const server = createServer((request, response) => {
    requests.set(request.url, (requests.get(request.url) || 0) + 1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/healthy-seed") {
      response.end(`<html><head><title>健康站入口</title></head><body><main><p>${"健康站稳定正文。".repeat(30)}</p><a href="/healthy-detail">详情</a></main></body></html>`);
      return;
    }
    if (request.url === "/healthy-detail") {
      response.end(`<html><head><title>健康站详情</title></head><body><article>${"本可作为跨站补位的详情正文。".repeat(30)}</article></body></html>`);
      return;
    }
    response.end(`<html><head><title>安全验证</title></head><body><main>${"访问验证".repeat(24)}</main></body></html>`);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = join(fixtureRoot, "config.json");
  const output = join(fixtureRoot, "capture");
  writeFileSync(config, `${JSON.stringify({
    schema: "qingzhou.article-extraction-sites.v1",
    sampleTarget: 2,
    strictSiteQuotas: true,
    sites: [{
      id: "healthy",
      name: "Healthy",
      vertical: "test",
      quota: 1,
      hosts: ["127.0.0.1"],
      seeds: [{ type: "catalog", url: `${origin}/healthy-seed` }],
      detailPatterns: ["/healthy-detail"],
    }, {
      id: "blocked",
      name: "Blocked",
      vertical: "test",
      quota: 1,
      hosts: ["127.0.0.1"],
      seeds: [{ type: "detail", url: `${origin}/blocked` }],
      detailPatterns: [],
    }],
  }, null, 2)}\n`);
  const result = await runAsync(process.execPath, [
    realworldRunner,
    "capture",
    "--config", config,
    "--output", output,
    "--workers", "1",
    ...fastCaptureSettleArgs,
  ]);
  assert.equal(result.status, 2, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.equal(manifest.target, 2);
  assert.equal(manifest.captured, 1);
  assert.deepEqual(manifest.samples.map(sample => sample.siteId), ["healthy"]);
  assert.equal(requests.get("/healthy-detail") || 0, 0, "strict quotas must not spend another site's reserve on a global shortfall");
  assert.equal(existsSync(join(output, ".capture-checkpoint.json")), false, "a completed shortfall is final and should use a separate supplement corpus");
});

test("live capture freezes CSS-hidden roots without depending on site styles during replay", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-visibility-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const visibleText = "真实可见的中心正文应当完整保留。".repeat(30);
  const externalHidden = "外部样式隐藏的调试面板不得复活";
  const inlineHidden = "内联样式隐藏的弹窗不得复活";
  const markupHidden = "原本已经 hidden 的内容不得复活";
  const hiddenAncestorText = "visibility hidden 祖先自身的文字不得复活";
  const visibleDescendant = "后代用 visibility visible 恢复的正文必须保留";
  const nativeHiddenOverride = "被页面 CSS 恢复显示的原生 hidden 内容必须保留";
  const inlineHiddenOverride = "被页面 CSS 恢复显示的内联隐藏内容必须保留";
  const displayContentsOverride = "display contents 上无效的透明度不得隐藏后代";
  const hiddenChildren = Array.from({ length: 120 }, (_, index) => `<span class="hidden-child">隐藏子节点 ${index}</span>`).join("");
  const server = createServer((request, response) => {
    if (request.url === "/site.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(".external-hidden { display: none } .visibility-parent { visibility: hidden } .visibility-child { visibility: visible } .native-visible[hidden],.inline-visible { display: block !important } ");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<html><head><title>冻结可见性测试</title><link rel="stylesheet" href="/site.css"><style>.inline-hidden { visibility: hidden }</style></head><body><main><article><h1>冻结可见性测试</h1><p>${visibleText}</p><section class="visibility-parent">${hiddenAncestorText}<p class="visibility-child">${visibleDescendant}</p></section><div class="native-visible" hidden>${nativeHiddenOverride}</div><p class="inline-visible" style="display:none">${inlineHiddenOverride}</p><div style="display:contents;opacity:0"><p>${displayContentsOverride}</p></div></article><section class="external-hidden"><h2>${externalHidden}</h2>${hiddenChildren}</section><aside class="inline-hidden"><p>${inlineHidden}</p></aside><div class="markup-hidden" hidden><p>${markupHidden}</p><span class="already-hidden-child">隐藏子树后代</span></div></main></body></html>`);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = join(fixtureRoot, "config.json");
  const output = join(fixtureRoot, "capture");
  writeFileSync(config, `${JSON.stringify({
    schema: "qingzhou.article-extraction-sites.v1",
    sampleTarget: 1,
    samplesPerSite: 1,
    sites: [{
      id: "fixture",
      name: "Fixture",
      vertical: "test",
      quota: 1,
      hosts: ["127.0.0.1"],
      seeds: [{ type: "detail", url: `${origin}/article` }],
      detailPatterns: [],
    }],
  }, null, 2)}\n`);
  const captured = await runAsync(process.execPath, [
    realworldRunner,
    "capture",
    "--config", config,
    "--output", output,
    "--workers", "1",
    ...fastCaptureSettleArgs,
  ]);
  assert.equal(captured.status, 0, captured.stderr || captured.stdout);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  const sample = manifest.samples[0];
  assert.match(sample.reference.mainText, /真实可见的中心正文/);
  assert.match(sample.reference.mainText, new RegExp(visibleDescendant));
  assert.match(sample.reference.mainText, new RegExp(nativeHiddenOverride));
  assert.match(sample.reference.mainText, new RegExp(inlineHiddenOverride));
  assert.match(sample.reference.mainText, new RegExp(displayContentsOverride));
  assert.doesNotMatch(sample.reference.mainText, new RegExp(`${externalHidden}|${inlineHidden}|${markupHidden}`));
  assert.ok(sample.captureEvidence.frozenDomHiddenRoots >= 3);
  assert.ok(sample.captureEvidence.frozenDomVisitedElements < 30, "already hidden roots must prune their large subtrees from the visibility walk");
  assert.ok(Number.isFinite(sample.captureEvidence.frozenDomElapsedMs));
  t.diagnostic(`visibility freeze visited ${sample.captureEvidence.frozenDomVisitedElements} elements, hid ${sample.captureEvidence.frozenDomHiddenRoots} roots in ${sample.captureEvidence.frozenDomElapsedMs.toFixed(2)} ms`);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(pathToFileURL(join(output, sample.snapshot)).href, { waitUntil: "domcontentloaded" });
  const frozen = await page.evaluate(() => {
    document.querySelectorAll("style,link[rel~='stylesheet']").forEach(element => element.remove());
    return {
      text: document.body.innerText,
      externalHidden: document.querySelector(".external-hidden")?.hidden,
      inlineHidden: document.querySelector(".inline-hidden")?.hidden,
      markupHidden: document.querySelector(".markup-hidden")?.hidden,
      visibilityParentStyle: document.querySelector(".visibility-parent")?.style.visibility,
      visibilityChildStyle: document.querySelector(".visibility-child")?.style.visibility,
      nativeVisibleHidden: document.querySelector(".native-visible")?.hidden,
      inlineVisibleStyle: document.querySelector(".inline-visible")?.style.display,
      descendantWasSkipped: document.querySelector(".hidden-child")?.hasAttribute("hidden"),
    };
  });
  assert.match(frozen.text, /真实可见的中心正文/);
  assert.match(frozen.text, new RegExp(visibleDescendant));
  assert.match(frozen.text, new RegExp(nativeHiddenOverride));
  assert.match(frozen.text, new RegExp(inlineHiddenOverride));
  assert.match(frozen.text, new RegExp(displayContentsOverride));
  assert.doesNotMatch(frozen.text, new RegExp(`${externalHidden}|${inlineHidden}|${markupHidden}|${hiddenAncestorText}`));
  assert.deepEqual({
    externalHidden: frozen.externalHidden,
    inlineHidden: frozen.inlineHidden,
    markupHidden: frozen.markupHidden,
    visibilityParentStyle: frozen.visibilityParentStyle,
    visibilityChildStyle: frozen.visibilityChildStyle,
    nativeVisibleHidden: frozen.nativeVisibleHidden,
    inlineVisibleStyle: frozen.inlineVisibleStyle,
    descendantWasSkipped: frozen.descendantWasSkipped,
  }, {
    externalHidden: true,
    inlineHidden: true,
    markupHidden: true,
    visibilityParentStyle: "visible",
    visibilityChildStyle: "visible",
    nativeVisibleHidden: false,
    inlineVisibleStyle: "",
    descendantWasSkipped: false,
  });

  await page.addScriptTag({ path: readabilityScript });
  await page.addScriptTag({ path: articleExtractorScript });
  const candidates = await page.evaluate(() => {
    const parseReadability = () => new Readability(document.cloneNode(true), {
      charThreshold: 0,
      keepClasses: false,
    }).parse();
    return {
      legacy: parseReadability()?.textContent || "",
      current: globalThis.QingzhouArticleExtractor.extract(document, {
        readability: parseReadability(),
      })?.text || "",
    };
  });
  for (const [name, text] of Object.entries(candidates)) {
    assert.match(text, /真实可见的中心正文/, `${name} must retain visible article text`);
    assert.match(text, new RegExp(visibleDescendant), `${name} must retain visibility-restored descendants`);
    assert.match(text, new RegExp(nativeHiddenOverride), `${name} must retain CSS-restored native hidden text`);
    assert.match(text, new RegExp(inlineHiddenOverride), `${name} must retain CSS-restored inline hidden text`);
    assert.match(text, new RegExp(displayContentsOverride), `${name} must retain display-contents descendants`);
    assert.doesNotMatch(text, new RegExp(`${externalHidden}|${inlineHidden}|${markupHidden}|${hiddenAncestorText}`), `${name} must ignore frozen hidden roots`);
  }
});
