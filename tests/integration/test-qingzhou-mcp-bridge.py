#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import threading
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_SRC = REPO_ROOT / "services" / "mcp-bridge" / "src"
SERVICE_SCRIPT = PACKAGE_SRC / "qz_browser_agent_mcp_bridge" / "server.py"
sys.path.insert(0, str(PACKAGE_SRC))

import qz_browser_agent_mcp_bridge.server as bridge  # noqa: E402


async def test_tool_catalog() -> None:
    state = bridge.BridgeState(token="test-token")
    app = bridge.create_mcp_app(state)
    tools = await app.list_tools()
    names = {item.name for item in tools}
    assert "qingzhou_bridge_status" in names
    assert "qingzhou_call" in names
    assert "qingzhou_get_session_snapshot" in names
    assert "qingzhou_execute_tool" in names
    assert "qingzhou_get_tool_job" in names
    assert "qingzhou_follow_up" in names
    assert "qingzhou_abort_session" in names
    assert "qingzhou_continue_task" in names
    assert "qingzhou_submit_wait_form" in names
    assert "qingzhou_cancel_wait" in names
    assert "qingzhou_list_skills" in names
    assert "qingzhou_get_skill" in names
    assert "qingzhou_get_skill_resource" in names
    assert all(name[0].isalpha() for name in names)
    assert all(item.outputSchema is None for item in tools)
    execute_tool = next(item for item in tools if item.name == "qingzhou_execute_tool")
    assert "runId" in execute_tool.inputSchema["properties"]


def test_queue_round_trip() -> None:
    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    result_box: dict[str, object] = {}

    def caller() -> None:
        result_box["value"] = state.call_extension("ping", {"hello": "world"}, timeout_seconds=2)

    thread = threading.Thread(target=caller)
    thread.start()

    requests = state.poll(
        {
            "id": "client-1",
            "extensionId": "ext",
            "name": "qingzhou-test",
            "capabilities": {"methods": ["ping"]},
        },
        timeout_ms=1000,
        max_batch=1,
    )
    assert len(requests) == 1
    assert requests[0]["method"] == "ping"
    assert requests[0]["params"] == {"hello": "world"}

    accepted = state.complete(requests[0]["id"], {
        "ok": True,
        "result": {"pong": True},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["value"] == {"pong": True}


async def test_execute_tool_async_job() -> None:
    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    app = bridge.create_mcp_app(state)

    started = await app.call_tool("qingzhou_execute_tool", {
        "name": "ask_user",
        "args": {"message": "wait"},
        "sessionId": "session-1",
        "runId": "run-public-1",
        "wait": False,
        "timeoutSeconds": 2,
    })
    started_payload = json.loads(started[0].text)
    assert started_payload["method"] == "execute_tool"
    assert started_payload["status"] in {"queued", "running"}
    assert started_payload["done"] is False
    job_id = started_payload["jobId"]

    requests = await asyncio.to_thread(state.poll, mcp_client(), timeout_ms=1000, max_batch=1)
    assert len(requests) == 1
    assert requests[0]["method"] == "execute_tool"
    assert requests[0]["timeoutMs"] == 2000
    assert requests[0]["params"]["sessionId"] == "session-1"
    assert requests[0]["params"]["runId"] == "run-public-1"
    assert requests[0]["params"]["name"] == "ask_user"

    accepted = state.complete(requests[0]["id"], {
        "ok": True,
        "result": {"toolName": "ask_user", "sessionId": "session-1", "result": {"waitId": "wait-1"}},
    })
    assert accepted is True

    job_payload = {}
    for _ in range(20):
        job_result = await app.call_tool("qingzhou_get_tool_job", {"jobId": job_id})
        job_payload = json.loads(job_result[0].text)
        if job_payload["status"] == "completed":
            break
        await asyncio.sleep(0.05)
    assert job_payload["status"] == "completed"
    assert job_payload["done"] is True
    assert job_payload["result"]["result"]["waitId"] == "wait-1"


def test_skill_wrappers_fallback_to_execute_tool() -> None:
    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    app = bridge.create_mcp_app(state)
    result_box: dict[str, object] = {}

    def caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_get_skill", {
            "name": "skill-workbench",
            "includeResources": True,
        }))
        result_box["value"] = json.loads(result[0].text)

    thread = threading.Thread(target=caller)
    thread.start()

    first = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)
    assert len(first) == 1
    assert first[0]["method"] == "get_skill"
    accepted = state.complete(first[0]["id"], {
        "ok": False,
        "error": "Unknown Qingzhou MCP bridge method: get_skill",
    })
    assert accepted is True

    second = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)
    assert len(second) == 1
    assert second[0]["method"] == "execute_tool"
    assert second[0]["params"]["name"] == "load_skill"
    assert second[0]["params"]["args"]["name"] == "skill-workbench"
    assert second[0]["params"]["args"]["includeResources"] is True
    accepted = state.complete(second[0]["id"], {
        "ok": True,
        "result": {"name": "skill-workbench", "content": "# 技能工作台"},
    })
    assert accepted is True

    thread.join(timeout=2)
    assert result_box["value"] == {"name": "skill-workbench", "content": "# 技能工作台"}


async def test_mcp_tool_call_leaves_event_loop_free() -> None:
    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    app = bridge.create_mcp_app(state)
    task = asyncio.create_task(app.call_tool("qingzhou_list_capabilities", {
        "timeoutSeconds": 2,
    }))

    await asyncio.sleep(0.05)
    request = (await asyncio.to_thread(state.poll, mcp_client(), timeout_ms=1000, max_batch=1))[0]
    assert request["method"] == "capabilities"
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"methods": ["ping", "capabilities"]},
    })
    assert accepted is True

    result = await asyncio.wait_for(task, timeout=2)
    assert json.loads(result[0].text) == {"methods": ["ping", "capabilities"]}


def test_session_control_wrappers() -> None:
    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    app = bridge.create_mcp_app(state)
    result_box: dict[str, object] = {}

    def follow_up_caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_follow_up", {
            "sessionId": "session-1",
            "text": "queued message",
            "clientMessageId": "client-message-1",
        }))
        result_box["follow_up"] = json.loads(result[0].text)

    thread = threading.Thread(target=follow_up_caller)
    thread.start()
    request = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)[0]
    assert request["method"] == "follow_up"
    assert request["params"]["sessionId"] == "session-1"
    assert request["params"]["text"] == "queued message"
    assert request["params"]["clientMessageId"] == "client-message-1"
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"accepted": True, "sessionId": "session-1"},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["follow_up"] == {"accepted": True, "sessionId": "session-1"}

    def abort_caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_abort_session", {
            "sessionId": "session-1",
            "cascade": False,
        }))
        result_box["abort"] = json.loads(result[0].text)

    thread = threading.Thread(target=abort_caller)
    thread.start()
    request = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)[0]
    assert request["method"] == "stop_session"
    assert request["params"]["sessionId"] == "session-1"
    assert request["params"]["cascade"] is False
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"stopped": True, "sessionId": "session-1"},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["abort"] == {"stopped": True, "sessionId": "session-1"}

    def continue_task_caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_continue_task", {
            "sessionId": "session-1",
            "waitId": "wait-1",
            "payload": {"continued": True, "reason": "mcp"},
        }))
        result_box["continue_task"] = json.loads(result[0].text)

    thread = threading.Thread(target=continue_task_caller)
    thread.start()
    request = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)[0]
    assert request["method"] == "continue_task"
    assert request["params"]["sessionId"] == "session-1"
    assert request["params"]["waitId"] == "wait-1"
    assert request["params"]["payload"] == {"continued": True, "reason": "mcp"}
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"accepted": True, "sessionId": "session-1", "waitId": "wait-1"},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["continue_task"] == {"accepted": True, "sessionId": "session-1", "waitId": "wait-1"}

    def submit_wait_form_caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_submit_wait_form", {
            "sessionId": "session-1",
            "waitId": "wait-2",
            "answers": {"choice": "A", "notes": "done"},
        }))
        result_box["submit_wait_form"] = json.loads(result[0].text)

    thread = threading.Thread(target=submit_wait_form_caller)
    thread.start()
    request = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)[0]
    assert request["method"] == "submit_wait_form"
    assert request["params"]["sessionId"] == "session-1"
    assert request["params"]["waitId"] == "wait-2"
    assert request["params"]["answers"] == {"choice": "A", "notes": "done"}
    assert request["params"]["reason"] == "submitted"
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"accepted": True, "submitted": True, "answerKeys": ["choice", "notes"]},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["submit_wait_form"] == {"accepted": True, "submitted": True, "answerKeys": ["choice", "notes"]}

    def cancel_wait_caller() -> None:
        result = asyncio.run(app.call_tool("qingzhou_cancel_wait", {
            "sessionId": "session-1",
            "waitId": "wait-3",
        }))
        result_box["cancel_wait"] = json.loads(result[0].text)

    thread = threading.Thread(target=cancel_wait_caller)
    thread.start()
    request = state.poll(mcp_client(), timeout_ms=1000, max_batch=1)[0]
    assert request["method"] == "cancel_wait"
    assert request["params"]["sessionId"] == "session-1"
    assert request["params"]["waitId"] == "wait-3"
    accepted = state.complete(request["id"], {
        "ok": True,
        "result": {"accepted": True, "reason": "cancelled"},
    })
    assert accepted is True
    thread.join(timeout=2)
    assert result_box["cancel_wait"] == {"accepted": True, "reason": "cancelled"}


def test_streamable_http_bridge_routes() -> None:
    from starlette.testclient import TestClient

    state = bridge.BridgeState(token="test-token", request_timeout_seconds=2)
    app = bridge.create_mcp_app(state)
    client = TestClient(app.streamable_http_app(), base_url=state.endpoint)

    health = client.get("/health")
    assert health.status_code == 200
    assert health.json()["status"]["endpoint"] == "http://127.0.0.1:18765"

    forbidden = client.post("/v1/qingzhou/poll", json={"client": {"id": "client-1"}})
    assert forbidden.status_code == 403

    empty_poll = client.post(
        "/v1/qingzhou/poll",
        headers={"x-qingzhou-bridge-token": "test-token"},
        json={"client": {"id": "client-1", "pollTimeoutMs": 1}, "maxBatch": 1},
    )
    assert empty_poll.status_code == 200
    assert empty_poll.json() == {"requests": []}

    result = client.post(
        "/v1/qingzhou/result",
        headers={"x-qingzhou-bridge-token": "test-token"},
        json={"requestId": "missing", "ok": True, "result": {}},
    )
    assert result.status_code == 200
    assert result.json() == {"ok": False}


def mcp_client() -> dict[str, object]:
    return {
        "id": "client-1",
        "extensionId": "ext",
        "name": "qingzhou-test",
        "capabilities": {"methods": ["ping"]},
    }


async def test_mcp_tool_call_status() -> None:
    state = bridge.BridgeState(host="127.0.0.1", port=18765, token="abc")
    app = bridge.create_mcp_app(state)
    result = await app.call_tool("qingzhou_bridge_status", {"clientId": "client-test"})
    payload = json.loads(result[0].text)
    assert payload["endpoint"] == "http://127.0.0.1:18765"
    assert "enableSnippet" not in payload
    assert "abc" not in json.dumps(payload)


def test_mcp_stdio_smoke() -> None:
    process = subprocess.Popen(
        [sys.executable, str(SERVICE_SCRIPT), "--port", "0", "--request-timeout", "2"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert process.stdin and process.stdout and process.stderr
    try:
        write_mcp(process, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "qingzhou-test", "version": "0"},
            },
        })
        initialize = read_mcp(process)
        assert initialize["id"] == 1
        assert initialize["result"]["serverInfo"]["name"] == "qz-browser-agent-mcp-bridge"

        write_mcp(process, {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        write_mcp(process, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        listed = read_mcp(process)
        tools = listed["result"]["tools"]
        names = {item["name"] for item in tools}
        assert "qingzhou_bridge_status" in names
        assert "qingzhou_get_session_snapshot" in names
        assert "qingzhou_get_tool_job" in names
        assert "qingzhou_follow_up" in names
        assert "qingzhou_abort_session" in names
        assert "qingzhou_continue_task" in names
        assert "qingzhou_submit_wait_form" in names
        assert "qingzhou_cancel_wait" in names
        assert "qingzhou_list_skills" in names
        assert "qingzhou_get_skill_resource" in names
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()


def write_mcp(process: subprocess.Popen[str], message: dict[str, object]) -> None:
    assert process.stdin
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()


def read_mcp(process: subprocess.Popen[str]) -> dict[str, object]:
    assert process.stdout
    line = process.stdout.readline()
    assert line, "MCP server closed stdout before responding"
    assert line.startswith("{"), line
    return json.loads(line)


def main() -> int:
    asyncio.run(test_tool_catalog())
    test_queue_round_trip()
    asyncio.run(test_execute_tool_async_job())
    test_skill_wrappers_fallback_to_execute_tool()
    asyncio.run(test_mcp_tool_call_leaves_event_loop_free())
    test_session_control_wrappers()
    test_streamable_http_bridge_routes()
    asyncio.run(test_mcp_tool_call_status())
    test_mcp_stdio_smoke()
    print("qingzhou MCP bridge tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def test_pairing_covers_http_mcp_and_custom_routes() -> None:
    from starlette.testclient import TestClient

    state = bridge.BridgeState()
    assert len(state.token) >= 32
    app = bridge.create_mcp_app(state)
    with TestClient(app.streamable_http_app(), base_url=state.endpoint) as client:
        for token in ["", "wrong"]:
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream"}
            assert client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).status_code == 401
            assert client.post("/v1/qingzhou/result", headers={"x-qingzhou-bridge-token": token}, json={"requestId": "missing"}).status_code == 403
        paired = {"Authorization": f"Bearer {state.token}", "Accept": "application/json, text/event-stream"}
        initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "paired-test", "version": "1"}}}
        assert client.post("/mcp", headers=paired, json=initialize).status_code == 200
        for path in ["/health", "/v1/qingzhou/poll", "/v1/qingzhou/result"]:
            method = "GET" if path == "/health" else "POST"
            assert client.request(method, path, headers={"host": "evil.example", "x-qingzhou-bridge-token": state.token}).status_code == 421
            for origin in ["https://evil.example", "http://127.0.0.1:9999", "null", "chrome-extension://bad-id"]:
                result = client.request(method, path, headers={"origin": origin, "x-qingzhou-bridge-token": state.token})
                assert result.status_code == 403
                assert "access-control-allow-origin" not in result.headers
        for header in [{"host": "evil.example"}, {"origin": "https://evil.example"}]:
            assert client.post("/mcp", headers={**paired, **header}, json=initialize).status_code in {403, 421}
        origin = "chrome-extension://" + "a" * 32
        preflight = client.options("/v1/qingzhou/poll", headers={"origin": origin})
        assert preflight.status_code == 204
        assert preflight.headers["access-control-allow-origin"] == origin
        assert client.post("/v1/qingzhou/poll", headers={"origin": origin}, json={}).status_code == 403
        malformed = client.post("/v1/qingzhou/poll", headers={"x-qingzhou-bridge-token": state.token}, json=[1])
        assert malformed.status_code == 400
        public = client.get("/health")
        assert state.token not in public.text
        assert "enableSnippet" not in public.text
        assert state.pending == [] and state.inflight == {} and state.clients == {}


def test_stdio_polling_uses_same_pairing_routes() -> None:
    import httpx
    import time

    state = bridge.BridgeState(port=0)
    server, thread, sock = bridge.start_http_server(state)
    try:
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        with httpx.Client(base_url=state.endpoint) as client:
            assert client.get("/health").status_code == 200
            assert client.post("/v1/qingzhou/poll", json={}).status_code == 403
            assert client.get("/health", headers={"Host": "evil.example"}).status_code == 421
            assert client.post("/v1/qingzhou/result", headers={"x-qingzhou-bridge-token": state.token}, json={"requestId": "missing"}).status_code == 200
    finally:
        server.should_exit = True
        thread.join(timeout=3)
        sock.close()
