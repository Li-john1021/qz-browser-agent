"""Run upstream Trafilatura against a frozen Qingzhou real-world corpus."""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    source = os.path.abspath(args.upstream)
    sys.path.insert(0, source)
    from trafilatura import extract  # pylint: disable=import-outside-toplevel

    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)

    results: dict[str, dict[str, str]] = {}
    errors: dict[str, str] = {}
    started = time.perf_counter()
    for index, item in enumerate(manifest["samples"], 1):
        path = os.path.join(args.corpus, item["snapshot"])
        try:
            item_started = time.perf_counter()
            with open(path, "rb") as handle:
                payload = handle.read()
                text = extract(
                    payload,
                    url=item.get("finalUrl") or item.get("requestedUrl"),
                    include_comments=False,
                    include_tables=True,
                    include_formatting=False,
                )
                markdown = extract(
                    payload,
                    url=item.get("finalUrl") or item.get("requestedUrl"),
                    include_comments=False,
                    include_tables=True,
                    include_images=True,
                    include_links=True,
                    include_formatting=True,
                    output_format="markdown",
                )
            results[item["id"]] = {
                "text": text or "",
                "markdown": markdown or "",
                "elapsedMs": (time.perf_counter() - item_started) * 1000,
            }
        except Exception as error:  # benchmark failures are reported, not hidden
            message = f"{type(error).__name__}: {error}"
            errors[item["id"]] = message
            results[item["id"]] = {"text": "", "error": message}
        if index % 25 == 0:
            print(f"trafilatura {index}/{len(manifest['samples'])}", flush=True)

    try:
        upstream_commit = subprocess.check_output(
            ["git", "-C", source, "rev-parse", "HEAD"], text=True
        ).strip()
    except (OSError, subprocess.SubprocessError):
        upstream_commit = ""
    payload = {
        "elapsedSeconds": time.perf_counter() - started,
        "python": f"{platform.python_implementation()} {platform.python_version()}",
        "upstreamCommit": upstream_commit,
        "errors": errors,
        "results": results,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
