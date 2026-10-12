#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBenchmarkAssets } from "./benchmark-assets.mjs";
import { ensureTestExtension, resolveTestAsset } from "./extension-build.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const port = readPort(process.argv.slice(2));
const extensionDir = await ensureTestExtension();
await prepareBenchmarkAssets(extensionDir);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/__test_health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("ok");
    return;
  }
  if (url.pathname === "/favicon.ico") {
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_error) {
    respond(response, 400, "Bad request");
    return;
  }

  const candidate = resolveTestAsset(pathname, { root, extensionDir });
  if (!candidate) {
    respond(response, 403, "Forbidden");
    return;
  }

  let filePath = candidate;
  try {
    if (statSync(filePath).isDirectory()) filePath = resolve(filePath, "index.html");
    if (!statSync(filePath).isFile()) throw new Error("not a file");
  } catch (_error) {
    respond(response, 404, "Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes.get(extname(filePath).toLowerCase()) || "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Qingzhou test server listening on http://127.0.0.1:${server.address().port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, shutdown);
}

// Playwright owns this pipe even though it starts the web server in a separate
// process group. Closing it also covers a fail-fast SIGTERM/SIGKILL of the owner.
if (process.argv.includes("--watch-stdin")) {
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdin.resume();
}

function shutdown() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

function readPort(args) {
  const inline = args.find(arg => arg.startsWith("--port="));
  const index = args.indexOf("--port");
  const value = inline ? inline.slice("--port=".length) : index >= 0 ? args[index + 1] : process.env.QINGZHOU_TEST_PORT;
  const number = Number(value || 4173);
  if (!Number.isInteger(number) || number < 0 || number > 65535) throw new Error(`Invalid port: ${value}`);
  return number;
}

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(body);
}
