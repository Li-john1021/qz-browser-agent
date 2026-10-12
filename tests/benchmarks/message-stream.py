#!/usr/bin/env python3
from argparse import ArgumentParser
from pathlib import Path
import json
import os
import sys
import statistics

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import serve_repository


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
SMOKE_PATH = "/tests/message-rendering/smoke.html"
VIEWPORTS = {
    "desktop": {"width": 980, "height": 900},
    "mobile": {"width": 390, "height": 844},
}


serve_repo = serve_repository


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = max(0, min(len(ordered) - 1, int(len(ordered) * fraction + 0.999999) - 1))
    return ordered[index]


def summarize(samples, budget_ms):
    return {
        "p50Ms": round(statistics.median(samples), 3),
        "p95Ms": round(percentile(samples, 0.95), 3),
        "maxMs": round(max(samples), 3),
        "overBudget": sum(value > budget_ms for value in samples),
    }


def summarize_result(raw, budget_ms):
    return {
        "characters": raw["characters"],
        "samples": raw["samples"],
        "highlight": summarize(raw["highlightMs"], budget_ms),
        "markdown": summarize(raw["renderMs"], budget_ms),
        "domAndLayout": summarize(raw["commitMs"], budget_ms),
        "total": summarize(raw["totalMs"], budget_ms),
        "highlightCallsPerFrame": round(statistics.mean(raw["highlightCalls"]), 2),
        "tailMisses": raw["tailMisses"],
        "vendors": raw["vendors"],
    }


def budget_failures(payload):
    failures = []
    budget_ms = payload["budgetMs"]
    for run_result in payload["runs"]:
        for result in run_result["results"]:
            p95_ms = result["total"]["p95Ms"]
            if p95_ms > budget_ms:
                failures.append(
                    f"{run_result['viewport']} {result['characters']} chars "
                    f"p95={p95_ms:.3f}ms exceeds {budget_ms:.3f}ms"
                )
    return failures


def run(args):
    payload = {
        "budgetMs": args.budget_ms,
        "cadenceMs": 34,
        "runs": [],
    }
    with serve_repo() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"),
        )
        for viewport_name, viewport in VIEWPORTS.items():
            page = browser.new_page(viewport=viewport)
            page.goto(f"{base_url}{SMOKE_PATH}", wait_until="networkidle")
            page.wait_for_function(
                '() => document.querySelector("#status")?.dataset?.result',
                timeout=args.timeout,
            )
            raw_results = page.evaluate(
                """
                async ({ sizes, samples }) => {
                  const renderer = window.__messageSmokeRenderer;
                  const { hljs: engine } = await import("/extension/sidepanel/ui/highlight-config.js");
                  const { morphChildren } = await import("/extension/sidepanel/ui/dom-morph.js");
                  if (!renderer?.renderMarkdown || !engine?.highlight) {
                    throw new Error("production renderer or highlight.js is unavailable");
                  }

                  document.querySelector("#messages")?.replaceChildren();
                  const host = document.createElement("div");
                  host.className = "msg msg-assistant";
                  const content = document.createElement("div");
                  content.className = "msg-content";
                  host.append(content);
                  document.body.append(host);
                  const highlightScope = {};

                  let source = "";
                  let line = 0;
                  const largest = Math.max(...sizes);
                  while (source.length < largest + 4096) {
                    source += `const value_${line} = rows.map((item) => item.score + ${line}); // stream ${line}\\n`;
                    line += 1;
                  }

                  const originalHighlight = engine.highlight;
                  const originalHighlightAuto = engine.highlightAuto;
                  let highlightMs = 0;
                  let highlightCalls = 0;
                  engine.highlight = function(...args) {
                    const started = performance.now();
                    try {
                      return originalHighlight.apply(this, args);
                    } finally {
                      highlightMs += performance.now() - started;
                      highlightCalls += 1;
                    }
                  };
                  if (originalHighlightAuto) {
                    engine.highlightAuto = function(...args) {
                      const started = performance.now();
                      try {
                        return originalHighlightAuto.apply(this, args);
                      } finally {
                        highlightMs += performance.now() - started;
                        highlightCalls += 1;
                      }
                    };
                  }

                  const results = [];
                  try {
                    for (const targetSize of sizes) {
                      const renderMs = [];
                      const commitMs = [];
                      const totalMs = [];
                      const frameHighlightMs = [];
                      const frameHighlightCalls = [];
                      const vendors = new Set();
                      let tailMisses = 0;
                      const startSize = Math.max(256, targetSize - Math.min(4096, targetSize * 0.45));

                      for (let index = 0; index < samples + 3; index += 1) {
                        await new Promise(resolve => requestAnimationFrame(resolve));
                        const ratio = Math.min(1, (index + 1) / (samples + 3));
                        const length = Math.round(startSize + ((targetSize - startSize) * ratio));
                        const markdown = String.fromCharCode(96).repeat(3)
                          + "javascript\\n"
                          + source.slice(0, length);
                        highlightMs = 0;
                        highlightCalls = 0;

                        const started = performance.now();
                        const html = renderer.renderMarkdown(markdown, { math: "stream", highlightScope });
                        const rendered = performance.now();
                        const template = document.createElement("template");
                        template.innerHTML = html;
                        morphChildren(content, template.content);
                        const pre = content.querySelector(".markdown-code-block > pre");
                        if (!pre) throw new Error(`missing streamed code block at ${length} characters`);
                        pre.dataset.followTail = "true";
                        pre.scrollTop = pre.scrollHeight;
                        const bottomGap = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
                        if (bottomGap > 2) tailMisses += 1;
                        pre.getBoundingClientRect();
                        const committed = performance.now();

                        if (index >= 3) {
                          renderMs.push(rendered - started);
                          commitMs.push(committed - rendered);
                          totalMs.push(committed - started);
                          frameHighlightMs.push(highlightMs);
                          frameHighlightCalls.push(highlightCalls);
                          vendors.add(content.querySelector(".markdown-code-block")?.dataset.highlighter || "");
                        }
                      }

                      results.push({
                        characters: targetSize,
                        samples,
                        renderMs,
                        commitMs,
                        totalMs,
                        highlightMs: frameHighlightMs,
                        highlightCalls: frameHighlightCalls,
                        tailMisses,
                        vendors: Array.from(vendors).sort(),
                      });
                    }
                  } finally {
                    engine.highlight = originalHighlight;
                    if (originalHighlightAuto) engine.highlightAuto = originalHighlightAuto;
                    host.remove();
                  }
                  return results;
                }
                """,
                {"sizes": args.sizes, "samples": args.samples},
            )
            payload["runs"].append({
                "viewport": viewport_name,
                "size": viewport,
                "results": [summarize_result(result, args.budget_ms) for result in raw_results],
            })
            page.close()
        browser.close()

    failures = budget_failures(payload) if args.fail_on_budget else []
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for run_result in payload["runs"]:
            print(f"{run_result['viewport']} ({run_result['size']['width']}px)")
            for result in run_result["results"]:
                total = result["total"]
                highlight = result["highlight"]
                print(
                    f"  {result['characters']:>6} chars: "
                    f"total p50={total['p50Ms']:>6.2f}ms p95={total['p95Ms']:>6.2f}ms "
                    f"highlight p95={highlight['p95Ms']:>6.2f}ms "
                    f"over={total['overBudget']}/{result['samples']} "
                    f"vendor={','.join(result['vendors']) or 'none'} "
                    f"tailMisses={result['tailMisses']}"
                )
    if failures:
        print("Stream render budget failed:", file=os.sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=os.sys.stderr)
        return 1
    return 0


def main():
    parser = ArgumentParser(description="Benchmark streamed Markdown highlighting and tail following in Chromium.")
    parser.add_argument("--json", action="store_true", help="Print full JSON metrics.")
    parser.add_argument("--samples", type=int, default=24, help="Measured stream frames per size.")
    parser.add_argument("--sizes", type=int, nargs="+", default=[2000, 8000, 16000, 32000, 64000])
    parser.add_argument("--budget-ms", type=float, default=34.0, help="Playback render cadence budget.")
    parser.add_argument(
        "--fail-on-budget",
        action="store_true",
        help="Exit non-zero when total render p95 exceeds --budget-ms.",
    )
    parser.add_argument("--timeout", type=int, default=30000)
    raise SystemExit(run(parser.parse_args()))


if __name__ == "__main__":
    main()
