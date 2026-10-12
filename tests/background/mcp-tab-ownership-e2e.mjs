import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
  assertNoUnexpectedDiagnostics,
  launchIsolatedExtensionMcp,
  runBridgePython,
} from "../support/isolated-extension-mcp.mjs";

const fixture = await startFixtureServer();
let environment = null;
try {
  environment = await launchIsolatedExtensionMcp({
    profilePrefix: "qingzhou-tab-owner-e2e-",
    headless: true,
    requestTimeoutSeconds: 60,
  });
  const unownedPage = await environment.context.newPage();
  await unownedPage.goto(`${fixture.baseUrl}/free`, { waitUntil: "domcontentloaded" });
  await runBridgePython(fileURLToPath(new URL("./mcp-tab-ownership.py", import.meta.url)), [
    "--bridge-url", environment.bridge.mcpUrl,
    "--base-url", fixture.baseUrl,
  ], { env: { QINGZHOU_MCP_BRIDGE_TOKEN: environment.bridge.token } });
  assertNoUnexpectedDiagnostics(environment.diagnostics);
  console.log(JSON.stringify({
    ok: true,
    scenario: "multi-session-subsession-tab-ownership",
    bridgePortIsolated: new URL(environment.bridge.endpoint).port !== "18765",
    bridgeClientCount: environment.bridgeStatus.clientCount,
  }));
} catch (error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  try {
    assertNoUnexpectedDiagnostics(environment?.diagnostics || []);
  } catch (diagnosticError) {
    failure.message = `${failure.message}\n${diagnosticError.message}`;
  }
  throw failure;
} finally {
  await environment?.close().catch(() => undefined);
  await fixture.close();
}

async function startFixtureServer() {
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://fixture.test").pathname.slice(1) || "index";
    const body = `<!doctype html><html><head><title>${path}</title></head><body><main><article><h1>${path}</h1><p>deterministic fixture ${path}</p></article></main></body></html>`;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolvePromise => server.close(resolvePromise)),
  };
}
