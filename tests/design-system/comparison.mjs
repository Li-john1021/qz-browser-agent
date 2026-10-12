import { createHash } from "node:crypto";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { comparePixels } from "../benchmarks/conversation-render/compare-revisions.mjs";
import { benchmarkAsset } from "../support/benchmark-assets.mjs";

export function fixtureDirectories(options) {
  return Object.fromEntries(["reference", "candidate"].map(side => {
    const directory = options[`${side}-fixture-dir`] || options["fixture-dir"];
    if (!directory) throw new Error(`Missing --${side}-fixture-dir or --fixture-dir`);
    return [side, resolve(directory)];
  }));
}

/** A server owns exactly one immutable application and skin; module requests cannot cross revisions. */
export async function createComparisonServer({ fixtureDir, stylesheet, controlsHtml, root }) {
  fixtureDir = resolve(fixtureDir);
  root = resolve(root);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    if (pathname === "/extension/sidepanel/sidepanel.css") {
      response.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" }).end(stylesheet); return;
    }
    if (pathname === "/tests/button-system/smoke.html" && controlsHtml !== undefined) {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(controlsHtml); return;
    }
    const extension = pathname.startsWith("/extension/");
    if (!extension && pathname !== "/tests/button-system/smoke.html") { response.writeHead(403).end(); return; }
    const base = extension ? fixtureDir : root;
    const overlay = extension ? benchmarkAsset(pathname, fixtureDir) : null;
    const path = overlay || resolve(base, `.${extension ? pathname.slice(10) : pathname}`);
    if ((!path.startsWith(`${base}${sep}`) && !overlay) || !existsSync(path)) { response.writeHead(404).end(); return; }
    const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    response.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

/** Require stable pixels and geometry before comparing revisions; never mask or allow a pixel budget. */
export async function stableCapture(element, path) {
  let previous;
  for (let attempts = 1; attempts <= 8; attempts += 1) {
    const bytes = await element.screenshot({ animations: "disabled", caret: "hide" });
    const geometry = await element.evaluate(root => [root, ...root.querySelectorAll("*")].flatMap((element, index) => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility === "hidden") return [];
      return [{ index, tag: element.tagName, id: element.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
    }));
    const signature = `${hash(bytes)}:${hash(JSON.stringify(geometry))}`;
    if (signature === previous) {
      writeFileSync(path, bytes);
      writeFileSync(path.replace(/\.png$/, ".geometry.json"), `${JSON.stringify(geometry, null, 2)}\n`);
      writeFileSync(path.replace(/\.png$/, ".html"), await element.evaluate(element => element.outerHTML));
      return { path, geometry, attempts };
    }
    previous = signature;
  }
  throw new Error(`Screenshot did not settle in 8 captures: ${path}`);
}

export function compareCaptures(reference, candidate, diffPath) {
  const pixel = comparePixels(reference.path, candidate.path, diffPath);
  pixel.status = pixel.differentPixels === 0 ? "pass" : "fail";
  const geometryEqual = JSON.stringify(reference.geometry) === JSON.stringify(candidate.geometry);
  return { pixel, geometryEqual,
    stableCaptureAttempts: { reference: reference.attempts, candidate: candidate.attempts },
    exact: pixel.differentPixels === 0 && geometryEqual };
}
