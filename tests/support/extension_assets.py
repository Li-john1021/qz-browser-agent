"""Serve compiled extension assets behind the existing browser-fixture URLs."""
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from tempfile import TemporaryDirectory
from urllib.parse import unquote, urlsplit
import json
import os
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
_temporary_build = None
_extension_directory = None
_benchmark_assets = None


def extension_directory():
    global _temporary_build, _extension_directory, _benchmark_assets
    if _extension_directory is None:
        configured = os.environ.get("QINGZHOU_TEST_EXTENSION_DIR")
        if configured:
            directory = Path(configured).resolve()
        else:
            _temporary_build = TemporaryDirectory(prefix="qingzhou-python-test-build-")
            directory = (Path(_temporary_build.name) / "extension").resolve()
            subprocess.run([
                "node", str(ROOT / "tests/support/extension-build.mjs"), "--output", str(directory),
            ], cwd=ROOT, check=True)
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("manifest_version") != 3:
            raise ValueError(f"Invalid test extension: {directory}")
        _benchmark_assets = TemporaryDirectory(prefix="qingzhou-benchmark-assets-")
        subprocess.run([
            "node", str(ROOT / "tests/support/benchmark-assets.mjs"), str(directory), _benchmark_assets.name,
        ], cwd=ROOT, check=True)
        _extension_directory = directory
    return _extension_directory


class ExtensionAssetHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        pathname = unquote(urlsplit(path).path)
        if pathname == "/extension" or pathname.startswith("/extension/"):
            root = extension_directory()
            overlay = {"/extension/sidepanel/sidepanel.html": "sidepanel.html",
                       "/extension/sidepanel/benchmark-test-hook.js": "benchmark-test-hook.js"}.get(pathname)
            if overlay:
                return str(Path(_benchmark_assets.name) / overlay)
            candidate = (root / pathname[len("/extension"):].lstrip("/")).resolve()
            if not candidate.is_relative_to(root):
                return str(root / ".invalid-test-asset-path")
            return str(candidate)
        return super().translate_path(path)

    def log_message(self, _format, *_args):
        pass


class LoopbackHTTPServer(ThreadingHTTPServer):
    """Bind fixture addresses without depending on host reverse-DNS services."""

    def server_bind(self):
        # Local fixtures must not wait for reverse DNS or depend on host networking.
        TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


@contextmanager
def serve_repository(handler=ExtensionAssetHandler):
    extension_directory()
    server = LoopbackHTTPServer(("127.0.0.1", 0), partial(handler, directory=str(ROOT)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
