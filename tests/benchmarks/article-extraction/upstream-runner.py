"""Run the checked-out upstream Trafilatura on its own annotated corpus."""

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
    parser.add_argument("--output", required=True)
    parser.add_argument("--corpus-sha256", required=True)
    parser.add_argument("--runner-sha256", required=True)
    args = parser.parse_args()

    source = os.path.abspath(args.upstream)
    sys.path.insert(0, source)
    import trafilatura  # pylint: disable=import-outside-toplevel
    from trafilatura import extract  # pylint: disable=import-outside-toplevel

    tests_dir = os.path.join(source, "tests")
    with open(os.path.join(tests_dir, "evaldata.json"), encoding="utf-8") as handle:
        annotations = json.load(handle)

    started = time.perf_counter()
    results: dict[str, str | None] = {}
    errors: dict[str, str] = {}
    timings_ms: dict[str, float] = {}
    for index, (url, item) in enumerate(annotations.items(), 1):
        path = next(
            (
                candidate
                for folder in ("cache", "eval")
                if os.path.isfile(candidate := os.path.join(tests_dir, folder, item["file"]))
            ),
            None,
        )
        if path is None:
            errors[url] = f"missing corpus file: {item['file']}"
            results[url] = None
            continue
        try:
            with open(path, "rb") as handle:
                html = handle.read()
            item_started = time.perf_counter_ns()
            try:
                results[url] = extract(
                    html,
                    include_comments=False,
                    include_tables=True,
                    include_formatting=False,
                )
            finally:
                timings_ms[url] = (time.perf_counter_ns() - item_started) / 1_000_000
        except Exception as error:  # benchmark failures count as misses
            errors[url] = f"{type(error).__name__}: {error}"
            results[url] = None
        if index % 100 == 0:
            print(f"upstream {index}/{len(annotations)}", flush=True)

    try:
        upstream_commit = subprocess.check_output(
            ["git", "-C", source, "rev-parse", "HEAD"], text=True
        ).strip()
    except (OSError, subprocess.SubprocessError):
        upstream_commit = ""

    payload = {
        "elapsedSeconds": time.perf_counter() - started,
        "python": f"{platform.python_implementation()} {platform.python_version()}",
        "trafilaturaVersion": trafilatura.__version__,
        "upstreamCommit": upstream_commit,
        "corpusSha256": args.corpus_sha256,
        "runnerSha256": args.runner_sha256,
        "configuration": {
            "includeComments": False,
            "includeTables": True,
            "includeFormatting": False,
        },
        "errors": errors,
        "results": results,
        "timingsMs": timings_ms,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
