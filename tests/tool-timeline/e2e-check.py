#!/usr/bin/env python3
from argparse import ArgumentParser
from contextlib import contextmanager
from pathlib import Path
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import serve_repository


ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parents[1]
FIXTURE_ROOT = ROOT / "fixtures" / "conversations"


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


@contextmanager
def serve_sidepanel():
    with serve_repository() as base_url:
        yield f"{base_url}/tests/tool-timeline/visual-test.html"


def read_fixture(path):
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    fixture.setdefault("name", Path(path).stem)
    return fixture


def fixture_paths(args):
    if args.fixture:
        return [Path(item) for item in args.fixture]
    return sorted(FIXTURE_ROOT.glob("*.json"))


def render_fixture(page, fixture):
    if fixture.get("scenario"):
        page.evaluate("(id) => window.visualTimelineTest.renderScenario(id)", fixture["scenario"])
        return

    conversation = fixture.get("conversation") or {}
    if "entries" in fixture:
        conversation = {
            "title": fixture.get("title") or fixture.get("name") or "E2E fixture",
            "entries": fixture["entries"],
        }
    expect(isinstance(conversation.get("entries"), list), f"{fixture['name']}: missing conversation.entries")
    page.evaluate("(flow) => window.visualTimelineTest.renderConversationFlow(flow)", conversation)


def run_fixture(page, fixture, width):
    page.evaluate("(width) => window.visualTimelineTest.setDeviceWidth(width)", width)
    page.evaluate("() => window.visualTimelineTest.resetPresentationState()")
    render_fixture(page, fixture)
    page.wait_for_timeout(100)

    steps = fixture.get("steps") or [{"action": "assert", "expect": "noHorizontalOverflow"}]
    assertions = 0
    operations = 0
    for index, step in enumerate(steps):
        label = step_label(fixture, width, index, step)
        action = str(step.get("action") or "").strip()
        try:
            if action == "assert":
                run_assertion(page, step, label)
                assertions += 1
            elif action == "render":
                render_fixture(page, {**fixture, "conversation": step.get("conversation") or fixture.get("conversation") or {}})
                page.wait_for_timeout(step.get("delay", 80))
                operations += 1
            else:
                run_operation(page, step)
                operations += 1
        except Exception as err:
            raise AssertionError(f"{label}: {err}") from err

    return {
        "name": fixture["name"],
        "width": width,
        "assertions": assertions,
        "operations": operations,
        "stats": collect_stats(page),
    }


def step_label(fixture, width, index, step):
    name = step.get("label") or step.get("expect") or step.get("action") or "step"
    return f"{fixture['name']}@{width}px step {index + 1} ({name})"


def run_operation(page, step):
    action = step.get("action")
    if action == "wait":
        page.wait_for_timeout(step.get("ms") or step.get("delay") or 120)
        return
    if action == "setWidth":
        page.evaluate("(width) => window.visualTimelineTest.setDeviceWidth(width)", step.get("width", 420))
        page.wait_for_timeout(step.get("delay", 80))
        return
    if action == "scenario":
        page.evaluate("(id) => window.visualTimelineTest.renderScenario(id)", step.get("id") or step.get("scenario") or "mixed")
        page.wait_for_timeout(step.get("delay", 100))
        return
    if action == "click":
        selector = step["selector"]
        index = step.get("index", 0)
        locator = page.locator(selector)
        expect(locator.count() > index, f"missing selector {selector!r} at index {index}")
        locator.nth(index).click()
        page.wait_for_timeout(step.get("delay", 80))
        return
    if action == "clickText":
        result = page.evaluate(
            """({ selector, text }) => {
                const node = [...document.querySelectorAll(selector)]
                  .find(item => (item.textContent || '').includes(text));
                if (!node) return false;
                node.click();
                return true;
            }""",
            {"selector": step["selector"], "text": step["text"]},
        )
        expect(result, f"missing selector {step['selector']!r} containing {step['text']!r}")
        page.wait_for_timeout(step.get("delay", 80))
        return
    if action == "eval":
        page.evaluate(step["expression"])
        page.wait_for_timeout(step.get("delay", 80))
        return

    page.evaluate(
        """async (operation) => {
            await window.visualTimelineTest.runOperationFlow([operation], { status: false });
        }""",
        step,
    )
    page.wait_for_timeout(step.get("delay", 80))


def run_assertion(page, step, label):
    kind = step.get("expect")
    if kind == "selectorCount":
        count = page.locator(step["selector"]).count()
        assert_count(count, step, label)
        return
    if kind == "selectorText":
        text = text_for_selector(page, step["selector"], step.get("index", 0))
        if "includes" in step:
            expect(step["includes"] in text, f"expected text to include {step['includes']!r}, got {text!r}")
        if "equals" in step:
            expect(text.strip() == step["equals"], f"expected text {step['equals']!r}, got {text.strip()!r}")
        if "notIncludes" in step:
            expect(step["notIncludes"] not in text, f"expected text to omit {step['notIncludes']!r}, got {text!r}")
        return
    if kind == "collapsedLane":
        lane_collapsed(page, step["lane"])
        return
    if kind == "expandedLane":
        lane_expanded(page, step["lane"])
        return
    if kind == "singleToolCollapsed":
        single_tool_collapsed(page, step.get("selector") or ".msg-tool")
        return
    if kind == "singleToolExpanded":
        single_tool_expanded(page, step.get("selector") or ".msg-tool")
        return
    if kind == "laneOrder":
        expect_lane_order(page)
        return
    if kind == "laneWidthsAligned":
        expect_lane_widths_aligned(page, step.get("selectors"))
        return
    if kind == "noHorizontalOverflow":
        expect_no_horizontal_overflow(page)
        return
    if kind == "navText":
        selector = step.get("selector") or ".tool-timeline-slot-nav span"
        text = text_for_selector(page, selector, step.get("index", 0)).strip()
        expect(text == step["equals"], f"expected nav text {step['equals']!r}, got {text!r}")
        return
    if kind == "activeText":
        selector = step.get("selector") or ".tool-timeline-step.active, .tool-family-row.active, .tool-family-batch.active"
        text = text_for_selector(page, selector, step.get("index", 0))
        expect(step["includes"] in text, f"expected active text to include {step['includes']!r}, got {text!r}")
        return
    if kind == "activeIndex":
        index = page.evaluate(
            """(selector) => {
                const items = [...document.querySelectorAll(selector)];
                const active = items.findIndex(item => item.classList.contains('active'));
                return { active, count: items.length };
            }""",
            step.get("itemsSelector") or ".tool-timeline-step, .tool-family-row, .tool-family-batch",
        )
        expect(index["active"] == step["equals"], f"expected active index {step['equals']}, got {index}")
        return
    if kind == "thinkingPreviewTail":
        text = text_for_selector(page, ".thinking-group-preview", 0)
        expect(step["includes"] in text, f"expected thinking preview tail {step['includes']!r}, got {text!r}")
        return
    if kind == "rawPanelScrollable":
        expect_scrollable_code_panel(page, step.get("selector") or ".tool-timeline-raw-panel .copyable-code-block pre")
        return
    if kind == "tableScrollable":
        expect_scrollable_table(page, step.get("selector") or ".tool-data-table-wrap")
        return
    if kind == "articleBodyBounded":
        expect_bounded_scroll(page, step.get("selector") or ".tool-article-body")
        return
    if kind == "footerEqualHeights":
        expect_footer_equal_heights(page, step.get("selector") or ".tool-timeline-footer-row")
        return
    if kind == "expandedAfterPatch":
        selector = step.get("selector") or ".msg-tool-timeline .tool-timeline-details"
        expect(not element_hidden(page, selector), f"expected {selector} to remain expanded after patch")
        return
    if kind == "copyConfirmed":
        copied = page.evaluate("() => window.__lastCopiedText || ''")
        if "includes" in step:
            expect(step["includes"] in copied, f"expected copied text to include {step['includes']!r}, got {copied[:120]!r}")
        else:
            expect(bool(copied.strip()), "expected non-empty copied text")
        return
    if kind == "js":
        result = page.evaluate(step["expression"])
        expect(bool(result), step.get("message") or f"js assertion returned {result!r}")
        return
    raise AssertionError(f"unknown assertion kind {kind!r}")


def assert_count(count, step, label):
    if "equals" in step:
        expect(count == step["equals"], f"expected {step['selector']} count {step['equals']}, got {count}")
    if "min" in step:
        expect(count >= step["min"], f"expected {step['selector']} count >= {step['min']}, got {count}")
    if "max" in step:
        expect(count <= step["max"], f"expected {step['selector']} count <= {step['max']}, got {count}")


def text_for_selector(page, selector, index=0):
    locator = page.locator(selector)
    expect(locator.count() > index, f"missing selector {selector!r} at index {index}")
    return locator.nth(index).text_content() or ""


def lane_collapsed(page, lane):
    if lane == "thinking":
        data = page.evaluate(
            """() => {
                const group = document.querySelector('.msg-thinking-group');
                const summary = group?.querySelector(':scope > .thinking-group-summary');
                const details = group?.querySelector(':scope > .thinking-group-details');
                const preview = group?.querySelector('.thinking-group-preview');
                return {
                    exists: Boolean(group && summary && details && preview),
                    expanded: group?.classList.contains('thinking-group-expanded') || false,
                    hidden: details?.classList.contains('hidden') || false,
                    aria: summary?.getAttribute('aria-expanded') || '',
                    previewVisible: preview ? getComputedStyle(preview).display !== 'none' : false,
                };
            }"""
        )
        expect(data["exists"], "missing thinking lane")
        expect(not data["expanded"] and data["hidden"] and data["aria"] == "false" and data["previewVisible"], f"thinking lane not collapsed: {data}")
        return

    if lane == "tool":
        data = page.evaluate(
            """() => {
                const group = document.querySelector('.msg-tool-timeline');
                const summary = group?.querySelector(':scope > .tool-timeline-summary');
                const details = group?.querySelector(':scope > .tool-timeline-details');
                return {
                    exists: Boolean(group && summary && details),
                    expanded: group?.classList.contains('tool-timeline-expanded') || false,
                    hidden: details?.classList.contains('hidden') || false,
                    summaryVisible: summary ? getComputedStyle(summary).display !== 'none' : false,
                    aria: summary?.getAttribute('aria-expanded') || '',
                };
            }"""
        )
        expect(data["exists"], "missing tool lane")
        expect(not data["expanded"] and data["hidden"] and data["summaryVisible"] and data["aria"] == "false", f"tool lane not collapsed: {data}")
        return

    raise AssertionError(f"unknown lane {lane!r}")


def lane_expanded(page, lane):
    selector = ".msg-thinking-group" if lane == "thinking" else ".msg-tool-timeline"
    details_selector = ".thinking-group-details" if lane == "thinking" else ".tool-timeline-details"
    data = page.evaluate(
        """([selector, detailsSelector]) => {
            const group = document.querySelector(selector);
            const details = group?.querySelector(`:scope > ${detailsSelector}`);
            return {
                exists: Boolean(group && details),
                hidden: details?.classList.contains('hidden') || false,
            };
        }""",
        [selector, details_selector],
    )
    expect(data["exists"], f"missing {lane} lane")
    expect(not data["hidden"], f"{lane} lane is not expanded: {data}")


def single_tool_collapsed(page, selector):
    data = page.evaluate(
        """(selector) => {
            const tool = document.querySelector(selector);
            const summary = tool?.querySelector(':scope > .tool-summary');
            const details = tool?.querySelector(':scope > .tool-details');
            return {
                exists: Boolean(tool && summary && details),
                expanded: tool?.classList.contains('tool-expanded') || false,
                hidden: details?.classList.contains('hidden') || false,
                aria: summary?.getAttribute('aria-expanded') || '',
            };
        }""",
        selector,
    )
    expect(data["exists"], f"missing single tool {selector}")
    expect(not data["expanded"] and data["hidden"] and data["aria"] == "false", f"single tool not collapsed: {data}")


def single_tool_expanded(page, selector):
    data = page.evaluate(
        """(selector) => {
            const tool = document.querySelector(selector);
            const summary = tool?.querySelector(':scope > .tool-summary');
            const details = tool?.querySelector(':scope > .tool-details');
            return {
                exists: Boolean(tool && summary && details),
                expanded: tool?.classList.contains('tool-expanded') || false,
                hidden: details?.classList.contains('hidden') || false,
                aria: summary?.getAttribute('aria-expanded') || '',
            };
        }""",
        selector,
    )
    expect(data["exists"], f"missing single tool {selector}")
    expect(data["expanded"] and not data["hidden"] and data["aria"] == "true", f"single tool not expanded: {data}")


def expect_lane_order(page):
    data = page.evaluate(
        """() => {
            const thinking = document.querySelector('.msg-thinking-group');
            const tool = document.querySelector('.msg-tool-timeline, .msg-tool');
            return thinking && tool
              ? thinking.getBoundingClientRect().top < tool.getBoundingClientRect().top
              : false;
        }"""
    )
    expect(data, "thinking lane should render above tool lane")


def expect_lane_widths_aligned(page, selectors=None):
    selectors = selectors or [".thinking-group-summary", ".msg-tool-timeline > .tool-timeline-summary", ".msg-tool > .tool-summary"]
    widths = page.evaluate(
        """(selectors) => selectors
            .map(selector => document.querySelector(selector))
            .filter(Boolean)
            .map(node => Math.round(node.getBoundingClientRect().width))""",
        selectors,
    )
    expect(len(widths) >= 2, f"need at least two lane widths, got {widths}")
    expect(max(widths) - min(widths) <= 1, f"lane widths differ: {widths}")


def expect_no_horizontal_overflow(page):
    metrics = page.evaluate(
        """() => {
            const device = document.querySelector('.visual-device');
            return {
                docClient: document.documentElement.clientWidth,
                docScroll: document.documentElement.scrollWidth,
                deviceClient: device?.clientWidth || 0,
                deviceScroll: device?.scrollWidth || 0,
            };
        }"""
    )
    expect(metrics["docScroll"] <= metrics["docClient"] + 1, f"document horizontal overflow {metrics}")
    expect(metrics["deviceScroll"] <= metrics["deviceClient"] + 1, f"device horizontal overflow {metrics}")


def expect_scrollable_code_panel(page, selector):
    metrics = page.evaluate(
        """(selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return {
                clientHeight: node.clientHeight,
                scrollHeight: node.scrollHeight,
                overflowY: style.overflowY,
            };
        }""",
        selector,
    )
    expect(metrics is not None, f"missing scrollable panel {selector}")
    expect(metrics["scrollHeight"] > metrics["clientHeight"] + 8, f"panel should be scrollable {metrics}")
    expect(metrics["overflowY"] in ("auto", "scroll"), f"panel overflow should scroll {metrics}")


def expect_scrollable_table(page, selector):
    metrics = page.evaluate(
        """(selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return {
                clientWidth: node.clientWidth,
                scrollWidth: node.scrollWidth,
                clientHeight: node.clientHeight,
                scrollHeight: node.scrollHeight,
                overflowX: style.overflowX,
                overflowY: style.overflowY,
            };
        }""",
        selector,
    )
    expect(metrics is not None, f"missing scrollable table {selector}")
    scrolls_x = metrics["scrollWidth"] > metrics["clientWidth"] + 8 and metrics["overflowX"] in ("auto", "scroll")
    scrolls_y = metrics["scrollHeight"] > metrics["clientHeight"] + 8 and metrics["overflowY"] in ("auto", "scroll")
    expect(scrolls_x or scrolls_y, f"table should have internal scroll when overflowing {metrics}")


def expect_bounded_scroll(page, selector):
    metrics = page.evaluate(
        """(selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return {
                clientHeight: node.clientHeight,
                scrollHeight: node.scrollHeight,
                maxHeight: style.maxHeight,
                overflowY: style.overflowY,
            };
        }""",
        selector,
    )
    expect(metrics is not None, f"missing bounded body {selector}")
    expect(metrics["scrollHeight"] > metrics["clientHeight"] + 8, f"body should have internal scroll {metrics}")
    expect(metrics["overflowY"] in ("auto", "scroll"), f"body overflow should scroll {metrics}")
    expect(metrics["maxHeight"] != "none", f"body should have max-height {metrics}")


def expect_footer_equal_heights(page, selector):
    heights = page.evaluate(
        """(selector) => {
            const row = document.querySelector(selector);
            if (!row) return [];
            return [...row.querySelectorAll('.tool-timeline-raw-btn:not(.hidden), .tool-timeline-duration, .tool-timeline-collapse-btn, .tool-event-raw-btn:not(.hidden), .tool-event-collapse-btn')]
                .map(node => Math.round(node.getBoundingClientRect().height));
        }""",
        selector,
    )
    expect(len(heights) >= 2, f"need at least two footer actions, got {heights}")
    expect(len(set(heights)) <= 1, f"footer action heights differ: {heights}")


def element_hidden(page, selector):
    return page.evaluate(
        """(selector) => {
            const node = document.querySelector(selector);
            if (!node) return true;
            return node.classList.contains('hidden') || getComputedStyle(node).display === 'none';
        }""",
        selector,
    )


def collect_stats(page):
    return page.evaluate(
        """() => ({
            toolTimelines: document.querySelectorAll('.msg-tool-timeline').length,
            thinkingGroups: document.querySelectorAll('.msg-thinking-group').length,
            singleTools: document.querySelectorAll('.msg-tool').length,
            tables: document.querySelectorAll('.tool-data-table').length,
            codeBlocks: document.querySelectorAll('.js-code-block, .json-block').length,
            rawPanels: document.querySelectorAll('.tool-timeline-raw-panel:not(.hidden), .tool-event-raw-panel:not(.hidden)').length,
            activeSteps: document.querySelectorAll('.tool-timeline-step.active, .tool-family-row.active, .tool-family-batch.active').length,
            width: Math.round(document.querySelector('.visual-device')?.getBoundingClientRect().width || 0),
        })"""
    )


def main():
    parser = ArgumentParser(description="Run sidepanel conversation-flow E2E fixtures.")
    parser.add_argument("--fixture", action="append", help="Fixture JSON path. Defaults to all e2e fixtures.")
    parser.add_argument("--width", action="append", type=int, help="Viewport/device width override. Can repeat.")
    parser.add_argument("--screenshot-dir", help="Optional directory for final fixture screenshots.")
    parser.add_argument("--headed", action="store_true", help="Run browser headed.")
    args = parser.parse_args()

    paths = fixture_paths(args)
    expect(paths, f"no fixtures found under {FIXTURE_ROOT}")
    fixtures = [read_fixture(path) for path in paths]
    screenshot_dir = Path(args.screenshot_dir) if args.screenshot_dir else None
    if screenshot_dir:
        screenshot_dir.mkdir(parents=True, exist_ok=True)

    results = []
    with serve_sidepanel() as url:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=not args.headed,
                channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"),
            )
            page = browser.new_page(locale="zh-CN", viewport={"width": 1180, "height": 980}, device_scale_factor=1)
            page.goto(url)
            page.wait_for_selector("#messages")

            for fixture in fixtures:
                widths = args.width or fixture.get("widths") or [420]
                for width in widths:
                    result = run_fixture(page, fixture, width)
                    results.append(result)
                    if screenshot_dir:
                        page.screenshot(path=str(screenshot_dir / f"{fixture['name']}-{width}.png"), full_page=True)
            browser.close()

    print(json.dumps({
        "ok": True,
        "fixtures": len(fixtures),
        "runs": len(results),
        "results": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:
        print(json.dumps({"ok": False, "error": str(err)}, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)
