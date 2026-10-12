#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import socket
import secrets
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import AnyHttpUrl


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18765
DEFAULT_REQUEST_TIMEOUT_SECONDS = 180
BRIDGE_PROTOCOL_VERSION = 1


@dataclass
class BridgeRequest:
    id: str
    method: str
    params: dict[str, Any]
    target_client_id: str = ""
    timeout_ms: int = 0
    created_at: float = field(default_factory=time.time)
    event: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None


@dataclass
class BridgeJob:
    id: str
    method: str
    params: dict[str, Any]
    target_client_id: str = ""
    timeout_seconds: float = 0
    created_at: float = field(default_factory=time.time)
    started_at: float = 0
    completed_at: float = 0
    status: str = "queued"
    result: Any = None
    error: str = ""


class BridgeState:
    def __init__(
        self,
        *,
        host: str = DEFAULT_HOST,
        port: int = DEFAULT_PORT,
        token: str = "",
        request_timeout_seconds: int = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        if host not in {"127.0.0.1", "localhost"}:
            raise ValueError("Qingzhou bridge must bind to loopback")
        self.host = host
        self.port = port
        self.token = token.strip() or secrets.token_urlsafe(32)
        self.request_timeout_seconds = max(1, int(request_timeout_seconds))
        self.condition = threading.Condition()
        self.pending: list[BridgeRequest] = []
        self.inflight: dict[str, BridgeRequest] = {}
        self.clients: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, BridgeJob] = {}
        self.started_at = time.time()

    @property
    def endpoint(self) -> str:
        return f"http://{self.host}:{self.port}"

    def status(self) -> dict[str, Any]:
        with self.condition:
            clients = sorted(
                (
                    {
                        "clientId": client_id,
                        "lastSeenAt": info.get("lastSeenAt", 0),
                        "ageSeconds": round(time.time() - float(info.get("lastSeenAt", 0)), 3),
                        "extensionId": info.get("extensionId", ""),
                        "name": info.get("name", ""),
                        "capabilities": info.get("capabilities") or {},
                    }
                    for client_id, info in self.clients.items()
                ),
                key=lambda item: item["clientId"],
            )
            return {
                "endpoint": self.endpoint,
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "tokenConfigured": bool(self.token),
                "clientCount": len(clients),
                "clients": clients,
                "pending": len(self.pending),
                "inflight": len(self.inflight),
                "uptimeSeconds": round(time.time() - self.started_at, 3),
            }

    def enable_snippet(self, *, client_id: str = "qingzhou-codex") -> str:
        config = {
            "enabled": True,
            "endpoint": self.endpoint,
            "clientId": client_id,
            "token": self.token,
            "pollIntervalMs": 500,
            "pollTimeoutMs": 30000,
            "requestTimeoutMs": self.request_timeout_seconds * 1000,
            "maxBatch": 4,
            "includeCapabilities": True,
        }
        return (
            "await chrome.storage.local.set({\n"
            f"  \"_qingzhou_mcp_bridge\": {json.dumps(config, ensure_ascii=False, indent=2)}\n"
            "});\n"
            "await chrome.storage.local.get(\"_qingzhou_mcp_bridge\");"
        )

    def register_client(self, client: dict[str, Any]) -> dict[str, Any]:
        raw_id = str(client.get("id") or client.get("clientId") or "").strip()
        client_id = raw_id or "qingzhou-extension"
        with self.condition:
            self.clients[client_id] = {
                **client,
                "id": client_id,
                "lastSeenAt": time.time(),
            }
            self.condition.notify_all()
        return self.clients[client_id]

    def poll(self, client: dict[str, Any], *, timeout_ms: int = 30000, max_batch: int = 4) -> list[dict[str, Any]]:
        info = self.register_client(client)
        client_id = str(info.get("id") or "")
        deadline = time.time() + max(0.1, min(float(timeout_ms) / 1000.0, 60.0))
        batch_size = max(1, min(int(max_batch or 4), 16))
        with self.condition:
            while True:
                selected: list[BridgeRequest] = []
                remaining: list[BridgeRequest] = []
                for item in self.pending:
                    if len(selected) < batch_size and (not item.target_client_id or item.target_client_id == client_id):
                        selected.append(item)
                    else:
                        remaining.append(item)
                if selected:
                    self.pending = remaining
                    for item in selected:
                        self.inflight[item.id] = item
                    return [
                        {
                            "id": item.id,
                            "method": item.method,
                            "params": item.params,
                            "timeoutMs": item.timeout_ms or self.request_timeout_seconds * 1000,
                        }
                        for item in selected
                    ]

                wait_seconds = deadline - time.time()
                if wait_seconds <= 0:
                    return []
                self.condition.wait(min(wait_seconds, 1.0))

    def complete(self, request_id: str, payload: dict[str, Any]) -> bool:
        with self.condition:
            item = self.inflight.pop(request_id, None)
            if not item:
                return False
            item.result = payload
            item.event.set()
            self.condition.notify_all()
            return True

    def call_extension(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_seconds: float | None = None,
        client_id: str = "",
    ) -> Any:
        if not method:
            raise ValueError("method is required")
        timeout = self.normalize_timeout(timeout_seconds)
        request = BridgeRequest(
            id=f"qz_{int(time.time() * 1000)}_{secrets.token_hex(6)}",
            method=method,
            params=params or {},
            target_client_id=client_id,
            timeout_ms=int(timeout * 1000),
        )
        with self.condition:
            self.pending.append(request)
            self.condition.notify_all()

        if not request.event.wait(timeout):
            with self.condition:
                self.inflight.pop(request.id, None)
                self.pending = [item for item in self.pending if item.id != request.id]
            raise TimeoutError(f"Qingzhou bridge request timed out after {timeout:.0f}s: {method}")

        payload = request.result or {}
        if payload.get("ok") is False:
            error = payload.get("error") or "Qingzhou bridge request failed"
            raise RuntimeError(str(error))
        return payload.get("result")

    def normalize_timeout(self, timeout_seconds: float | None = None) -> float:
        return max(1.0, float(timeout_seconds or self.request_timeout_seconds))

    def start_extension_job(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_seconds: float | None = None,
        client_id: str = "",
    ) -> dict[str, Any]:
        if not method:
            raise ValueError("method is required")
        self.prune_jobs()
        job = BridgeJob(
            id=f"job_{int(time.time() * 1000)}_{secrets.token_hex(6)}",
            method=method,
            params=params or {},
            target_client_id=client_id,
            timeout_seconds=self.normalize_timeout(timeout_seconds),
        )
        with self.condition:
            self.jobs[job.id] = job
            self.condition.notify_all()
        thread = threading.Thread(
            target=self._run_extension_job,
            args=(job.id,),
            name=f"qingzhou-bridge-job-{job.id[-8:]}",
            daemon=True,
        )
        thread.start()
        return self.serialize_job(job, include_result=False)

    def _run_extension_job(self, job_id: str) -> None:
        with self.condition:
            job = self.jobs.get(job_id)
            if not job:
                return
            job.status = "running"
            job.started_at = time.time()
            self.condition.notify_all()
        try:
            result = self.call_extension(
                job.method,
                job.params,
                timeout_seconds=job.timeout_seconds,
                client_id=job.target_client_id,
            )
            with self.condition:
                job = self.jobs.get(job_id)
                if not job:
                    return
                job.status = "completed"
                job.result = result
                job.completed_at = time.time()
                self.condition.notify_all()
        except Exception as exc:  # noqa: BLE001 - surface background job errors to MCP.
            with self.condition:
                job = self.jobs.get(job_id)
                if not job:
                    return
                job.status = "failed"
                job.error = str(exc)
                job.completed_at = time.time()
                self.condition.notify_all()

    def get_job(self, job_id: str, *, include_result: bool = True) -> dict[str, Any]:
        self.prune_jobs()
        with self.condition:
            job = self.jobs.get(str(job_id or "").strip())
            if not job:
                raise KeyError(f"Unknown Qingzhou bridge job: {job_id}")
            return self.serialize_job(job, include_result=include_result)

    def serialize_job(self, job: BridgeJob, *, include_result: bool = True) -> dict[str, Any]:
        now = time.time()
        payload: dict[str, Any] = {
            "jobId": job.id,
            "method": job.method,
            "status": job.status,
            "done": job.status in {"completed", "failed"},
            "createdAt": job.created_at,
            "startedAt": job.started_at or None,
            "completedAt": job.completed_at or None,
            "ageSeconds": round(now - job.created_at, 3),
            "timeoutSeconds": job.timeout_seconds,
        }
        if job.completed_at and job.started_at:
            payload["durationSeconds"] = round(job.completed_at - job.started_at, 3)
        if job.status == "failed":
            payload["error"] = job.error
        if include_result and job.status == "completed":
            payload["result"] = job.result
        return payload

    def prune_jobs(self) -> None:
        with self.condition:
            if len(self.jobs) <= 200:
                return
            completed = [
                job for job in self.jobs.values()
                if job.status in {"completed", "failed"}
            ]
            completed.sort(key=lambda item: item.completed_at or item.created_at)
            for job in completed[: max(0, len(self.jobs) - 200)]:
                self.jobs.pop(job.id, None)

    def assert_token(self, token: str) -> None:
        if not token or not secrets.compare_digest(token.encode(), self.token.encode()):
            raise PermissionError("invalid qingzhou bridge token")


class PairingTokenVerifier:
    def __init__(self, state: BridgeState) -> None:
        self.state = state

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            self.state.assert_token(token)
        except PermissionError:
            return None
        return AccessToken(token=token, client_id="paired-local-client", scopes=["bridge"])


def start_http_server(state: BridgeState):
    """stdio and shared HTTP use exactly the same routes and security boundary."""
    import uvicorn

    sock = socket.socket()
    sock.bind((state.host, state.port))
    state.port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_mcp_app(state).streamable_http_app(),
        log_level="error", timeout_graceful_shutdown=1))
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), name="qingzhou-bridge-http", daemon=True)
    thread.start()
    return server, thread, sock


def create_mcp_app(state: BridgeState, *, streamable_http_path: str = "/mcp") -> FastMCP:
    app = FastMCP(
        "qz-browser-agent-mcp-bridge",
        instructions="Expose qz agent debugging capabilities through a local browser bridge.",
        log_level="ERROR",
        host=state.host,
        port=state.port,
        streamable_http_path=streamable_http_path,
        token_verifier=PairingTokenVerifier(state),
        auth=AuthSettings(issuer_url=AnyHttpUrl(state.endpoint),
            resource_server_url=AnyHttpUrl(state.endpoint + streamable_http_path), required_scopes=["bridge"]),
        transport_security=TransportSecuritySettings(
            allowed_hosts=[f"127.0.0.1:{state.port}", f"localhost:{state.port}"], allowed_origins=[]),
    )

    async def bridge_route(request: Any):
        import anyio
        from starlette.responses import JSONResponse, Response

        # Custom FastMCP routes do not pass through its transport security middleware.
        if request.headers.get("host", "").lower() not in {f"127.0.0.1:{state.port}", f"localhost:{state.port}"}:
            return JSONResponse({"error": "invalid bridge host"}, status_code=421)
        origin = request.headers.get("origin", "")
        if origin and not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            return JSONResponse({"error": "invalid bridge origin"}, status_code=403)
        headers = {"cache-control": "no-store"}
        if origin:
            headers.update({"access-control-allow-origin": origin, "vary": "Origin",
                "access-control-allow-methods": "GET, POST, OPTIONS",
                "access-control-allow-headers": "content-type, x-qingzhou-bridge-token"})
        def respond(payload: dict[str, Any], status: int = 200):
            return JSONResponse(payload, status_code=status, headers=headers)
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=headers)
        if request.url.path == "/health":
            return respond({"ok": True, "status": state.status()})
        try:
            state.assert_token(request.headers.get("x-qingzhou-bridge-token", ""))
        except PermissionError:
            return respond({"ok": False, "error": "invalid qingzhou bridge token"}, 403)
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return respond({"ok": False, "error": "JSON content-type required"}, 415)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("JSON object required")
            if request.url.path == "/v1/qingzhou/poll":
                client = body.get("client") if isinstance(body.get("client"), dict) else {}
                timeout_ms = int(client.get("pollTimeoutMs") or body.get("pollTimeoutMs") or 30000)
                max_batch = int(client.get("maxBatch") or body.get("maxBatch") or 4)
                requests = await anyio.to_thread.run_sync(lambda: state.poll(client, timeout_ms=timeout_ms, max_batch=max_batch))
                return respond({"requests": requests})
            request_id = str(body.get("requestId") or "").strip()
            if not request_id:
                return respond({"ok": False, "error": "requestId is required"}, 400)
            return respond({"ok": state.complete(request_id, body)})
        except (ValueError, TypeError):
            return respond({"ok": False, "error": "invalid bridge request"}, 400)

    for path, methods in [("/health", ["GET", "OPTIONS"]),
                          ("/v1/qingzhou/poll", ["POST", "OPTIONS"]),
                          ("/v1/qingzhou/result", ["POST", "OPTIONS"])]:
        app.custom_route(path, methods=methods, include_in_schema=False)(bridge_route)

    async def call_extension(
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout_seconds: float | None = None,
        client_id: str = "",
    ) -> Any:
        import anyio

        return await anyio.to_thread.run_sync(
            lambda: state.call_extension(
                method,
                params or {},
                timeout_seconds=timeout_seconds or state.request_timeout_seconds,
                client_id=client_id,
            ),
        )

    async def call_extension_or_tool(
        method: str,
        params: dict[str, Any],
        *,
        tool_name: str,
        tool_args: dict[str, Any],
        session_id: str = "default",
        timeout_seconds: float | None = None,
        client_id: str = "",
    ) -> Any:
        try:
            return await call_extension(method, params, timeout_seconds=timeout_seconds, client_id=client_id)
        except RuntimeError as exc:
            if "Unknown Qingzhou MCP bridge method" not in str(exc):
                raise
            return await call_extension("execute_tool", {
                "sessionId": session_id,
                "name": tool_name,
                "args": tool_args,
                "timeoutSeconds": timeout_seconds,
            }, timeout_seconds=timeout_seconds, client_id=client_id)

    @app.tool(description="查看本地 bridge 和已连接轻舟扩展客户端，不返回配对凭证。", structured_output=False)
    def qingzhou_bridge_status(clientId: str = "qingzhou-codex") -> dict[str, Any]:
        return state.status()

    @app.tool(description="生成在轻舟扩展 DevTools Console 中启用 bridge 的 chrome.storage snippet。", structured_output=False)
    def qingzhou_bridge_enable_snippet(clientId: str = "qingzhou-codex") -> dict[str, Any]:
        return {
            "snippet": state.enable_snippet(client_id=clientId or "qingzhou-codex"),
            "storageKey": "_qingzhou_mcp_bridge",
        }

    @app.tool(description="调用扩展端原始 bridge method，用于调试未包装的新接口。")
    async def qingzhou_call(
        method: str,
        params: dict[str, Any] | None = None,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        if not method.strip():
            raise ValueError("method is required")
        return await call_extension(method.strip(), params, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出扩展端 qz-browser-agent-mcp-bridge 当前暴露的方法。")
    async def qingzhou_list_capabilities(timeoutSeconds: float | None = None, clientId: str = "") -> Any:
        return await call_extension("capabilities", {}, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出轻舟会话及运行态。")
    async def qingzhou_list_sessions(
        limit: float | None = None,
        excludeSessionId: str = "",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("list_sessions", {
            "limit": limit,
            "excludeSessionId": excludeSessionId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="创建轻舟会话，可选立即发送首条消息。")
    async def qingzhou_create_session(
        title: str = "",
        firstMessage: str = "",
        parentSessionId: str = "",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("create_session", {
            "title": title,
            "firstMessage": firstMessage,
            "parentSessionId": parentSessionId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="向指定轻舟会话发送用户消息。")
    async def qingzhou_send_message(
        text: str,
        sessionId: str = "default",
        wait: bool = False,
        waitForStart: bool = True,
        waitForStartMs: float = 2000,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("send_message", {
            "sessionId": sessionId,
            "text": text,
            "wait": wait,
            "waitForStart": waitForStart,
            "waitForStartMs": waitForStartMs,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="向轻舟会话追加 follow-up 消息；如果会话正在运行，会在当前 run 完全停下后排队处理。")
    async def qingzhou_follow_up(
        text: str,
        sessionId: str = "default",
        images: list[Any] | None = None,
        clientMessageId: str = "",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("follow_up", {
            "sessionId": sessionId,
            "text": text,
            "images": images or [],
            "clientMessageId": clientMessageId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="中止轻舟会话当前运行；语义化 abort 封装，底层调用扩展端 stop_session。")
    async def qingzhou_abort_session(
        sessionId: str,
        cascade: bool = True,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("stop_session", {
            "sessionId": sessionId,
            "cascade": cascade,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="继续一个正在等待用户操作的轻舟会话。用于用户已完成外部操作后恢复任务。")
    async def qingzhou_continue_task(
        sessionId: str,
        waitId: str = "",
        payload: dict[str, Any] | None = None,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("continue_task", {
            "sessionId": sessionId,
            "waitId": waitId,
            "payload": payload,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="提交轻舟 ask_user / wait 表单答案，并恢复等待中的会话。先用 qingzhou_get_session_snapshot 读取 runtime.waitForm 字段。")
    async def qingzhou_submit_wait_form(
        sessionId: str,
        answers: dict[str, Any],
        waitId: str = "",
        reason: str = "submitted",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("submit_wait_form", {
            "sessionId": sessionId,
            "waitId": waitId,
            "answers": answers or {},
            "reason": reason,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="取消一个正在等待用户操作或表单输入的轻舟会话。")
    async def qingzhou_cancel_wait(
        sessionId: str,
        waitId: str = "",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("cancel_wait", {
            "sessionId": sessionId,
            "waitId": waitId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取轻舟会话运行态。")
    async def qingzhou_get_session_state(
        sessionId: str = "default",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("get_session_state", {
            "sessionId": sessionId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取与轻舟 UI 同源的任务快照：session、runtime、transcript、尾部消息、产物索引，可选 trace 和工具列表；tool transcript 用 argsState/argsGenerating 区分参数生成中和最终空参数。")
    async def qingzhou_get_session_snapshot(
        sessionId: str = "default",
        compact: bool = True,
        tail: bool = True,
        num: float = 50,
        includeArtifacts: bool = True,
        includeTrace: bool = False,
        traceLimit: float = 40,
        includeTools: bool = False,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("get_session_snapshot", {
            "sessionId": sessionId,
            "compact": compact,
            "tail": tail,
            "num": num,
            "includeArtifacts": includeArtifacts,
            "includeTrace": includeTrace,
            "traceLimit": traceLimit,
            "includeTools": includeTools,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取轻舟会话消息；compact/tail 可返回较短尾部摘要。")
    async def qingzhou_get_messages(
        sessionId: str = "default",
        compact: bool = True,
        tail: bool = True,
        num: float = 50,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("get_messages", {
            "sessionId": sessionId,
            "compact": compact,
            "tail": tail,
            "num": num,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="停止轻舟会话运行。")
    async def qingzhou_stop_session(
        sessionId: str,
        cascade: bool = True,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("stop_session", {
            "sessionId": sessionId,
            "cascade": cascade,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出当前 session 可用的轻舟内置工具和插件工具 schema。")
    async def qingzhou_list_tools(
        sessionId: str = "default",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("list_tools", {
            "sessionId": sessionId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出轻舟 skill 目录；只返回摘要和资源清单，不返回正文与资源内容。")
    async def qingzhou_list_skills(
        scope: str = "all",
        query: str = "",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        result = await call_extension_or_tool("list_skills", {
            "scope": scope,
            "query": query,
            "timeoutSeconds": timeoutSeconds,
        }, tool_name="qingzhou_skill_author__list_skills", tool_args={
            "scope": scope,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)
        if query and isinstance(result, dict):
            needle = query.casefold()
            names = [
                name for name in result.get("names", [])
                if isinstance(name, str) and needle in name.casefold()
            ]
            if names:
                result = {
                    **result,
                    "query": query,
                    "count": len(names),
                    "names": names,
                    "items": [{"name": name} for name in names],
                }
        return result

    @app.tool(description="读取轻舟 skill 正文和资源清单；默认不内联资源内容，按需再调用 qingzhou_get_skill_resource。")
    async def qingzhou_get_skill(
        name: str,
        includeContent: bool = True,
        includeResources: bool = False,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension_or_tool("get_skill", {
            "name": name,
            "includeContent": includeContent,
            "includeResources": includeResources,
            "timeoutSeconds": timeoutSeconds,
        }, tool_name="load_skill", tool_args={
            "name": name,
            "includeContent": includeContent,
            "includeResources": includeResources,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取轻舟 skill 包内单个资源文件内容，支持 start/maxChars 分块。")
    async def qingzhou_get_skill_resource(
        name: str,
        path: str,
        start: float = 0,
        maxChars: float = 300000,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension_or_tool("get_skill_resource", {
            "name": name,
            "path": path,
            "start": start,
            "maxChars": maxChars,
            "timeoutSeconds": timeoutSeconds,
        }, tool_name="load_skill_resource", tool_args={
            "name": name,
            "path": path,
            "start": start,
            "maxChars": maxChars,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="直接执行轻舟工具，用于系统 skill/plugin 调试。依赖 Agent 生命周期的页面工具请传当前 runId；wait=false 时后台执行并立即返回 jobId。")
    async def qingzhou_execute_tool(
        name: str,
        args: dict[str, Any] | None = None,
        sessionId: str = "default",
        runId: str = "",
        wait: bool = True,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        payload = {
            "sessionId": sessionId,
            "runId": runId,
            "name": name,
            "args": args or {},
            "timeoutSeconds": timeoutSeconds,
        }
        if wait is False:
            return state.start_extension_job(
                "execute_tool",
                payload,
                timeout_seconds=timeoutSeconds,
                client_id=clientId,
            )
        return await call_extension("execute_tool", payload, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取 qingzhou_execute_tool(wait=false) 后台 job 的状态和结果。", structured_output=False)
    def qingzhou_get_tool_job(
        jobId: str,
        includeResult: bool = True,
    ) -> dict[str, Any]:
        return state.get_job(jobId, include_result=includeResult)

    @app.tool(description="读取轻舟模型、安全策略等配置。")
    async def qingzhou_get_config(timeoutSeconds: float | None = None, clientId: str = "") -> Any:
        return await call_extension("get_config", {
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="保存轻舟配置。")
    async def qingzhou_save_config(
        config: dict[str, Any],
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("save_config", {
            "config": config,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出当前页面/session 上下文下的插件贡献。")
    async def qingzhou_list_plugins(
        sessionId: str = "default",
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("list_plugins", {
            "sessionId": sessionId,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="列出轻舟定时任务。")
    async def qingzhou_list_automations(
        limit: float | None = None,
        runLimit: float | None = None,
        timeoutSeconds: float | None = None,
        clientId: str = "",
    ) -> Any:
        return await call_extension("list_automations", {
            "limit": limit,
            "runLimit": runLimit,
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    @app.tool(description="读取轻舟 LLM/工具 trace 日志。")
    async def qingzhou_get_trace(timeoutSeconds: float | None = None, clientId: str = "") -> Any:
        return await call_extension("get_trace", {
            "timeoutSeconds": timeoutSeconds,
        }, timeout_seconds=timeoutSeconds, client_id=clientId)

    return app


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="qz MCP bridge over stdio plus local HTTP polling.")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default=os.environ.get("QINGZHOU_MCP_TRANSPORT", "stdio"),
        help="MCP transport to serve. stdio starts a per-client process; streamable-http runs a shared daemon.",
    )
    parser.add_argument("--host", default=os.environ.get("QINGZHOU_MCP_BRIDGE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("QINGZHOU_MCP_BRIDGE_PORT", DEFAULT_PORT)))
    parser.add_argument("--mcp-path", default=os.environ.get("QINGZHOU_MCP_PATH", "/mcp"))
    parser.add_argument("--token", default=os.environ.get("QINGZHOU_MCP_BRIDGE_TOKEN", ""))
    parser.add_argument("--request-timeout", type=int, default=int(os.environ.get("QINGZHOU_MCP_BRIDGE_TIMEOUT", DEFAULT_REQUEST_TIMEOUT_SECONDS)))
    parser.add_argument("--print-snippet", action="store_true", help="Print enable snippet to stderr on startup.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    token = args.token.strip()
    state = BridgeState(
        host=args.host,
        port=args.port,
        token=token,
        request_timeout_seconds=args.request_timeout,
    )
    mcp_path = "/" + str(args.mcp_path or "/mcp").strip().lstrip("/")
    if args.print_snippet:
        print("[qz-browser-agent-mcp-bridge] Enable qz extension bridge with:", file=sys.stderr)
        print(state.enable_snippet(), file=sys.stderr)
    app = create_mcp_app(state, streamable_http_path=mcp_path)
    if args.transport == "streamable-http":
        print(
            f"[qz-browser-agent-mcp-bridge] Streamable HTTP MCP listening on {state.endpoint}{mcp_path}; "
            f"extension bridge on {state.endpoint}",
            file=sys.stderr,
        )
        app.run("streamable-http")
        return 0

    http_server, http_thread, http_socket = start_http_server(state)
    print(f"[qz-browser-agent-mcp-bridge] HTTP bridge listening on {state.endpoint}", file=sys.stderr)
    try:
        app.run("stdio")
    finally:
        http_server.should_exit = True
        http_thread.join(timeout=3)
        http_socket.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
