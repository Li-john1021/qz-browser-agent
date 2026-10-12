from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .cases import CaseSpec


CAPTURE_CREDENTIAL_FIELDS = frozenset({
    "apikey", "authorization", "proxyauthorization", "accesstoken", "refreshtoken",
    "idtoken", "bridgetoken", "token", "clientsecret", "secret", "password", "cookie", "setcookie",
    "apitoken", "authtoken", "apisecret", "secretkey", "privatekey", "accesskeysecret",
})


class CaseCapture:
    def __init__(self, directory: str, secrets: tuple[str, ...]) -> None:
        self.directory = Path(directory)
        self.secrets = tuple(sorted({value for value in secrets if value}, key=len, reverse=True))
        self.directory.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_environment(cls, directory: str) -> CaseCapture | None:
        if not directory:
            return None
        # The Node launcher passes only the selected credential, never the whole local env file.
        key = os.environ.get("QINGZHOU_CAPTURE_API_KEY", "").strip()
        key_file = os.environ.get("QINGZHOU_CAPTURE_API_KEY_FILE", "")
        if not key and key_file:
            key = Path(key_file).read_text(encoding="utf-8").strip()
        if not key:
            raise ValueError("--capture-dir requires QINGZHOU_CAPTURE_API_KEY or QINGZHOU_CAPTURE_API_KEY_FILE for redaction")
        return cls(directory, (key, os.environ.get("QINGZHOU_MCP_BRIDGE_TOKEN", "")))

    def redact(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {
                self.redact(str(key)): "[redacted]" if re.sub(r"[^a-z0-9]", "", str(key).lower()) in CAPTURE_CREDENTIAL_FIELDS else self.redact(item)
                for key, item in value.items()
            }
        if isinstance(value, (list, tuple)):
            return [self.redact(item) for item in value]
        if isinstance(value, str):
            # Tool args/results may themselves contain JSON, rather than objects.
            try:
                parsed = json.loads(value)
            except (ValueError, TypeError):
                parsed = None
            if isinstance(parsed, (dict, list)):
                cleaned = self.redact(parsed)
                if cleaned != parsed:
                    value = json.dumps(cleaned, ensure_ascii=False)
            for secret in self.secrets:
                value = value.replace(secret, "[redacted]")
        return value

    async def save(self, client: Any, case: CaseSpec, run_tag: str, session_id: str,
                   snapshot: dict[str, Any], result: dict[str, Any]) -> None:
        data = None
        capture_error = ""
        if case.table and session_id:
            try:
                data = await client.data_store_list(case.table, session_id=session_id)
            except Exception as exc:
                capture_error = f"Data readback failed: {exc}"
        payload = self.redact({
            "case": case.name, "iteration": case.iteration, "suite": case.suite,
            "runTag": run_tag, "prompt": case.prompt, "snapshot": snapshot,
            "result": result, "data": {"table": case.table, "response": data},
            "captureError": capture_error,
        })
        filename = f"{run_tag}-{case.name}-{case.iteration}.json"
        if Path(filename).name != filename:
            raise ValueError("Capture identifiers must not contain path separators")
        try:
            with (self.directory / filename).open("x", encoding="utf-8") as output:
                json.dump(payload, output, ensure_ascii=False, indent=2)
                output.write("\n")
        except Exception as exc:
            raise RuntimeError(f"Case capture failed: {self.redact(str(exc))}") from None
        if capture_error:
            raise RuntimeError(f"Case capture failed: {self.redact(capture_error)}") from None
