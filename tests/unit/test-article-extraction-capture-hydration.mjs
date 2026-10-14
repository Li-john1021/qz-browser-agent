import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

import {
  fastCaptureSettleArgs,
  realworldRunner,
  runAsync,
} from "../support/article-extraction-benchmark.mjs";

function scriptString(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

test("live capture waits for hydration and retries when the inspected text changes before its screenshot", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-consistency-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const delayedFinal = "延迟水合后的完整中心内容".repeat(24);
  const richShell = "已经足够长但仍然只是导航与推荐占位的壳层内容".repeat(24);
  const richFinal = "富壳页面延迟水合后的完整中心正文".repeat(24);
  const betweenFinal = "截图前发生变化后的最终中心内容".repeat(24);
  const betweenInitial = "检查时仍然存在的初始中心内容".repeat(24);
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/delayed") {
      response.end(`<html><head><title>延迟水合</title></head><body><main id="content">${"正在加载中心内容".repeat(12)}</main><script>setTimeout(() => { document.querySelector('#content').textContent = ${scriptString(delayedFinal)}; }, 180);</script></body></html>`);
      return;
    }
    if (request.url === "/rich-delayed") {
      response.end(`<html><head><title>富壳延迟水合</title></head><body><main id="content">${richShell}</main><script>setTimeout(() => { document.querySelector('#content').textContent = ${scriptString(richFinal)}; }, 180);</script></body></html>`);
      return;
    }
    if (request.url === "/unstable") {
      response.end(`<html><head><title>持续变化</title></head><body><main id="content">${betweenInitial}</main><script>
        const originalRect = Element.prototype.getBoundingClientRect;
        let pending = false;
        let version = 0;
        Element.prototype.getBoundingClientRect = function(...args) {
          if (!pending) {
            pending = true;
            queueMicrotask(() => {
              document.querySelector('#content').textContent = ${scriptString(betweenInitial)} + (++version);
              pending = false;
            });
          }
          return originalRect.apply(this, args);
        };
      </script></body></html>`);
      return;
    }
    response.end(`<html><head><title>检查后变化</title></head><body><main id="content">${betweenInitial}</main><script>
      const originalRect = Element.prototype.getBoundingClientRect;
      let queued = false;
      Element.prototype.getBoundingClientRect = function(...args) {
        if (!queued) {
          queued = true;
          queueMicrotask(() => { document.querySelector('#content').textContent = ${scriptString(betweenFinal)}; });
        }
        return originalRect.apply(this, args);
      };
    </script></body></html>`);
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
    sampleTarget: 3,
    samplesPerSite: 3,
    sites: [{
      id: "fixture",
      name: "Fixture",
      vertical: "test",
      quota: 3,
      hosts: ["127.0.0.1"],
      seeds: [
        { type: "catalog", url: `${origin}/delayed` },
        { type: "catalog", url: `${origin}/rich-delayed` },
        { type: "catalog", url: `${origin}/between` },
        { type: "catalog", url: `${origin}/unstable` },
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
  assert.equal(manifest.captured, 3);
  assert.equal(manifest.failures.find(sample => sample.requestedUrl.endsWith("/unstable"))?.failure, "unstable_content");
  const delayed = manifest.samples.find(sample => sample.requestedUrl.endsWith("/delayed"));
  const rich = manifest.samples.find(sample => sample.requestedUrl.endsWith("/rich-delayed"));
  const between = manifest.samples.find(sample => sample.requestedUrl.endsWith("/between"));
  assert.match(readFileSync(join(output, delayed.snapshot), "utf8"), new RegExp(delayedFinal.slice(0, 24)));
  const richSnapshot = readFileSync(join(output, rich.snapshot), "utf8");
  assert.match(richSnapshot, new RegExp(richFinal.slice(0, 24)));
  assert.doesNotMatch(richSnapshot, new RegExp(richShell.slice(0, 24)));
  assert.match(readFileSync(join(output, between.snapshot), "utf8"), new RegExp(betweenFinal.slice(0, 24)));
  assert.doesNotMatch(readFileSync(join(output, between.snapshot), "utf8"), new RegExp(betweenInitial.slice(0, 24)));
  assert.equal(delayed.captureEvidence.contentStable, true);
  assert.equal(rich.captureEvidence.contentStable, true);
  assert.equal(between.captureEvidence.contentStable, true);
  assert.ok(between.captureEvidence.consistencyAttempts >= 2);
  assert.ok(existsSync(join(output, delayed.screenshot)));
  assert.ok(existsSync(join(output, rich.screenshot)));
  assert.ok(existsSync(join(output, between.screenshot)));
});

test("live capture consistency covers URL, complete rendered text, and basic structure", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-signature-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const longPrefix = "八万字之后的正文尾部仍属于页面状态。".repeat(5_000);
  const initialTail = "旧的长文尾部不得进入冻结快照";
  const finalTail = "新的长文尾部必须进入冻结快照";
  const unchangedText = "页面可见文字保持完全一致，但正文结构已经发生变化。".repeat(20);
  const mutationScript = expression => `<script>
    const originalRect = Element.prototype.getBoundingClientRect;
    let queued = false;
    Element.prototype.getBoundingClientRect = function(...args) {
      if (!queued) {
        queued = true;
        queueMicrotask(() => { ${expression} });
      }
      return originalRect.apply(this, args);
    };
  </script>`;
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/tail-between") {
      response.end(`<html><head><title>完整正文签名</title></head><body><main>${longPrefix}<p id="tail">${initialTail}</p></main>${mutationScript(`document.querySelector('#tail').textContent = ${JSON.stringify(finalTail)}`)}</body></html>`);
      return;
    }
    if (request.url === "/url-between") {
      response.end(`<html><head><title>地址签名</title></head><body><main><p>${unchangedText}</p></main>${mutationScript("history.replaceState(null, '', '/url-final')")}</body></html>`);
      return;
    }
    response.end(`<html><head><title>结构签名</title></head><body><main><p id="mutable">${unchangedText}</p></main>${mutationScript(`
      const previous = document.querySelector('#mutable');
      const replacement = document.createElement('article');
      replacement.id = 'mutable';
      replacement.textContent = previous.textContent;
      previous.replaceWith(replacement);
    `)}</body></html>`);
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
    sampleTarget: 3,
    samplesPerSite: 3,
    sites: [{
      id: "fixture",
      name: "Fixture",
      vertical: "test",
      quota: 3,
      hosts: ["127.0.0.1"],
      seeds: [
        { type: "detail", url: `${origin}/tail-between` },
        { type: "detail", url: `${origin}/url-between` },
        { type: "detail", url: `${origin}/structure-between` },
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
    ...fastCaptureSettleArgs,
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.equal(manifest.captured, 3);
  const tail = manifest.samples.find(sample => sample.requestedUrl.endsWith("/tail-between"));
  const url = manifest.samples.find(sample => sample.requestedUrl.endsWith("/url-between"));
  const structure = manifest.samples.find(sample => sample.requestedUrl.endsWith("/structure-between"));
  for (const sample of [tail, url, structure]) {
    assert.ok(sample.captureEvidence.consistencyAttempts >= 2);
  }
  const tailSnapshot = readFileSync(join(output, tail.snapshot), "utf8");
  assert.match(tailSnapshot, new RegExp(finalTail));
  assert.doesNotMatch(tailSnapshot, new RegExp(initialTail));
  assert.ok(url.finalUrl.endsWith("/url-final"));
  const structureSnapshot = readFileSync(join(output, structure.snapshot), "utf8");
  assert.match(structureSnapshot, /<article id="mutable">/);
  assert.doesNotMatch(structureSnapshot, /<p id="mutable">/);
  assert.equal(tail.captureEvidence.source, "chromium-live-page");
  assert.equal(tail.captureEvidence.serializedFrom, "detached document clone with computed visibility frozen");
  assert.match(tail.captureEvidence.frozenDomSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(tail.captureEvidence, "liveDomSha256"), false);
});
