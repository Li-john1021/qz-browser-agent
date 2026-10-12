import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fastCaptureSettleArgs,
  realworldRunner,
  runAsync,
} from "../support/article-extraction-benchmark.mjs";

test("live capture bounds failed detail candidates and never retries attempted URLs in overflow", async t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-capture-budget-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const requests = new Map();
  const detailLinks = Array.from({ length: 60 }, (_, index) => `/detail-${index + 1}`);
  const server = createServer((request, response) => {
    requests.set(request.url, (requests.get(request.url) || 0) + 1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/seed") {
      response.end(`<html><head><title>候选发现页</title></head><body><main><h1>候选发现页</h1><p>${"足够长的稳定入口正文。".repeat(30)}</p>${detailLinks.map((href, index) => `<a href="${href}">详情 ${index + 1}</a>`).join("")}</main></body></html>`);
      return;
    }
    response.end(`<html><head><title>安全验证</title></head><body><main>安全验证</main></body></html>`);
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
    samplesPerSite: 2,
    sites: [{
      id: "fixture",
      name: "Fixture",
      vertical: "test",
      quota: 2,
      hosts: ["127.0.0.1"],
      seeds: [{ type: "catalog", url: `${origin}/seed` }],
      discoveredType: "video",
      detailPatterns: ["/detail-"],
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
  const detailRequests = [...requests.entries()].filter(([url]) => url.startsWith("/detail-"));
  const perSiteBudget = Math.max(16, 2 * 5);
  assert.ok(detailRequests.length <= perSiteBudget, `attempted ${detailRequests.length} details with a ${perSiteBudget}-URL budget`);
  assert.ok(detailRequests.every(([, count]) => count === 1), "overflow must not retry an already attempted detail URL");
  assert.equal(requests.get("/seed"), 1);
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.ok(manifest.failures.filter(item => /\/detail-/.test(item.requestedUrl)).every(item => item.type === "video"));
});
