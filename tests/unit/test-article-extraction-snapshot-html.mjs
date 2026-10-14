import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import { createSnapshotSanitizer } from "../benchmarks/article-extraction/snapshot-html.mjs";
import { fixtureSample, realworldRunner, runAsync, writeFixtureCorpus } from "../support/article-extraction-benchmark.mjs";

const source = `<!doctype html><html><head><meta charset="gbk">
  <base href="https://wrong.example/"><meta http-equiv="refresh" content="0;url=https://wrong.example/">
  <link rel=stylesheet href="https://wrong.example/style.css">
  <script type=application/ld+json src="https://wrong.example/code.js">{"articleBody":"正文 & <b>text</b>"}</script>
  </head><body><article><h1>Snapshot</h1><p>正文 &amp; evidence</p>
  <a href="/article">Article</a><img src="/photo.png" alt="Photo">
  <table><tr><td>Cell</td></tr></table><p hidden>Hidden text</p>
  <object data="https://wrong.example/plugin"><p>Object fallback</p></object></article>
  <script>globalThis.snapshotExecuted = true</script>
  <svg/onload="globalThis.snapshotExecuted = true"><template>SVG template</template></svg>
  <a id="unsafe-link" href="java&#10;script:globalThis.snapshotExecuted=true">Unsafe</a>
  <iframe srcdoc="&lt;script>parent.snapshotExecuted=true&lt;/script>"></iframe>
  <template id="html-template"><img src=x onerror="globalThis.snapshotExecuted=true"><script>globalThis.snapshotExecuted=true</script></template>
  <scr<script>ignored</script>ipt>globalThis.snapshotExecuted=true</scr<script>ignored</script>ipt>
  </body></html>`;

test("snapshots preserve article evidence and remain inert when loaded or reparsed", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qz-snapshot-html-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const sanitizeSnapshot = await createSnapshotSanitizer(browser);
  const page = await browser.newPage();
  await page.route("**/*", route => route.request().url().startsWith("file:") ? route.continue() : route.abort());
  const url = "https://example.test/article?x=1&y=2";
  const html = await sanitizeSnapshot(source, url);
  assert.equal(await sanitizeSnapshot(html, url), html, "sanitization is idempotent");
  const file = join(directory, "snapshot.html");
  writeFileSync(file, html);
  await page.addInitScript(() => { globalThis.benchmarkReady = true; });
  await page.goto(pathToFileURL(file).href);
  const result = await page.evaluate(async () => {
    const template = document.querySelector("#html-template");
    document.body.append(template.content.cloneNode(true));
    const injected = document.createElement("script");
    injected.textContent = "globalThis.snapshotExecuted=true";
    document.body.append(injected);
    for (const element of document.querySelectorAll("*")) {
      element.dispatchEvent(new Event("error"));
      element.dispatchEvent(new Event("load"));
    }
    await new Promise(resolve => requestAnimationFrame(resolve));
    return {
      executed: globalThis.snapshotExecuted === true,
      benchmarkReady: globalThis.benchmarkReady,
      text: document.querySelector("article").innerText,
      jsonLd: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
      base: document.baseURI,
      link: document.querySelector("article a").href,
      image: document.querySelector("article img").getAttribute("src"),
      unsafeLink: document.querySelector("#unsafe-link").getAttribute("href"),
      handlers: [...document.querySelectorAll("*")].flatMap(element => [...element.attributes].filter(attribute => attribute.name.startsWith("on"))),
      frames: document.querySelectorAll("iframe,object,embed").length,
      charset: document.characterSet,
    };
  });
  assert.equal(result.executed, false);
  assert.equal(result.benchmarkReady, true, "benchmark instrumentation remains available under the snapshot CSP");
  assert.match(result.text, /正文 & evidence/);
  assert.match(result.text, /Cell/);
  assert.match(result.text, /Object fallback/);
  assert.doesNotMatch(result.text, /Hidden text/);
  assert.deepEqual(result.jsonLd, { articleBody: "正文 & <b>text</b>" });
  assert.equal(result.base, url);
  assert.equal(result.link, "https://example.test/article");
  assert.equal(result.image, "/photo.png");
  assert.equal(result.unsafeLink, null);
  assert.deepEqual(result.handlers, []);
  assert.equal(result.frames, 0);
  assert.equal(result.charset, "UTF-8");
});

test("offline sanitization updates snapshot hashes and produces stable files", async t => {
  const directory = mkdtempSync(join(tmpdir(), "qz-snapshot-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sample = fixtureSample(directory, "article", "https://example.test/article", { html: source });
  writeFixtureCorpus(directory, { samples: [sample] });
  const run = () => runAsync(process.execPath, [realworldRunner, "sanitize", "--corpus", directory]);
  const first = await run();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).changed, 1);
  const updated = JSON.parse(readFileSync(join(directory, "manifest.json"))).samples[0];
  const snapshot = readFileSync(join(directory, updated.snapshot));
  assert.equal(updated.inputSha256, createHash("sha256").update(snapshot).digest("hex"));
  const second = await run();
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(JSON.parse(second.stdout).changed, 0);
});
