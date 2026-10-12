# qz MCP Bridge

Connect an MCP client to the qz extension through this standalone Python service. The extension
receives requests and returns results over local HTTP long polling. The bridge runs separately from
the extension package.

## Run locally

From the repository root, start the shared Streamable HTTP server:

```bash
QINGZHOU_MCP_BRIDGE_TOKEN="<random-pairing-token>" \
uv run --project services/mcp-bridge \
  --index https://pypi.org/simple \
  --default-index https://pypi.org/simple \
  --locked \
  qz-browser-agent-mcp-bridge --transport streamable-http --print-snippet
```

Configure the MCP client:

```toml
[mcp_servers.qz-browser-agent]
url = "http://127.0.0.1:18765/mcp"
bearer_token_env_var = "QINGZHOU_MCP_BRIDGE_TOKEN"
```

Generate a random token locally, for example with `openssl rand -hex 32`, and set the same value in
`QINGZHOU_MCP_BRIDGE_TOKEN` for both the bridge and the MCP client. At startup, `--print-snippet`
prints a pairing snippet to the local terminal. Run it in the extension's DevTools console to
connect qz to the bridge. Keep the token in local configuration and redact it from shared logs.

The extension enables bridge connections after token pairing, including in debug mode. If the
service starts without a token, it generates one for that process. A stdio client can call
`qingzhou_bridge_enable_snippet` to obtain the local pairing snippet. Ordinary health and status
responses expose connection state only. Changing the token requires pairing again.

The service binds only to loopback. The MCP HTTP endpoint uses Bearer authentication; extension
poll/result requests use the pairing token. Custom routes check Host and Origin, and return an exact
CORS origin only for valid Chrome extension origins. Both stdio and HTTP use the same polling routes
and authentication checks. The extension rejects HTTP redirects and discards late polling commands
when pairing is revoked.

`qingzhou_execute_tool` accepts an optional `runId` and passes it unchanged to the extension's tool
context. If omitted, it reuses the Session's currently live run when available. For page tools that
depend on the Agent run lifecycle, read the current `runId` from the Session state and pass it
explicitly.

## Run over stdio

From the repository root, start the local service for an MCP client:

```bash
uv run --project services/mcp-bridge --locked qz-browser-agent-mcp-bridge --transport stdio
```

## Test and build

```bash
npm test -- services
uv build --project services/mcp-bridge
```

`npm test -- services` uses this service's uv lockfile and pytest configuration, with
`pytest-asyncio` for asynchronous tests.

The Python import package is `qz_browser_agent_mcp_bridge`; the distribution and CLI are both named
`qz-browser-agent-mcp-bridge`.
