import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildProviderRateReport,
  mergeRequestTimeline,
  parseSessionExportHtml,
  renderProviderRateSvg,
  simulateLearningProviderRate,
  simulateProviderRate,
} from "../benchmarks/provider-rate-replay.mjs";

test("provider rate replay restores request times from the earliest compatible snapshot", () => {
  const first = parseSessionExportHtml(exportHtml({
    title: "fixture",
    messages: [assistant("call-a", 40), assistant("call-b", 45)],
    transcript: [tool("call-a", "2026-07-21 10:00:00"), tool("call-b", "2026-07-21 10:00:02")],
  }), "/tmp/fixture.html");
  const target = parseSessionExportHtml(exportHtml({
    title: "fixture",
    messages: [assistant("call-a", 40), assistant("call-b", 45), assistant("call-c", 50)],
    transcript: [
      tool("call-a", "2026-07-21 11:00:00"),
      tool("call-b", "2026-07-21 11:00:00"),
      tool("call-c", "2026-07-21 11:00:04"),
    ],
  }), "/tmp/fixture (1).html");

  const requests = mergeRequestTimeline(target, [first, target]);
  assert.deepEqual(requests.map(request => request.timestamp), [
    "2026-07-21 10:00:00",
    "2026-07-21 10:00:02",
    "2026-07-21 11:00:04",
  ]);
  assert.deepEqual(requests.map(request => request.tokens), [40, 45, 50]);
});

test("provider rate replay rejects collapsed export time and can analyze a reliable suffix", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qingzhou-provider-rate-collapsed-"));
  const file = join(directory, "fixture.html");
  try {
    const messages = Array.from({ length: 11 }, (_unused, index) => assistant(`call-${index}`, 40 + index));
    const transcript = Array.from({ length: 11 }, (_unused, index) => tool(
      `call-${index}`,
      index < 10 ? "2026-07-21 10:00:00" : "2026-07-21 10:01:00",
    ));
    writeFileSync(file, exportHtml({ title: "collapsed", messages, transcript }));

    await assert.rejects(
      buildProviderRateReport(file, { history: false }),
      /Requests 1-10 share the same exported timestamp/u,
    );
    const suffix = await buildProviderRateReport(file, {
      history: false,
      fromRequest: 11,
    });
    assert.equal(suffix.requests.length, 1);
    assert.deepEqual(suffix.methodology.sourceRequestRange, [11, 11]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider rate replay executes the production governor with a virtual clock", async () => {
  const base = Date.parse("2026-07-21T10:00:00");
  const requests = [
    request(0, base, 60),
    request(1, base + 1_000, 60),
  ];
  const replay = await simulateProviderRate(requests, {
    windowMs: 10_000,
    requestsPerWindow: 100,
    tokensPerWindow: 100,
    waitNoticeThresholdMs: 5_000,
  });

  assert.equal(replay.requests[0].waitMs, 0);
  assert.equal(replay.requests[1].waitMs, 9_000, "the second charge must wait for the hard token window");
  assert.equal(replay.requests[1].shapedTimeMs, base + 10_000);
  assert.equal(replay.requests[1].rawRate.tpm, 120);
  assert.equal(replay.requests[1].shapedRate.tpm, 60);
});

test("production burst replay removes avoidable wait while preserving the rolling ceiling", async () => {
  const base = Date.parse("2026-07-21T10:00:00");
  const requests = [
    request(0, base, 100),
    request(1, base + 100, 100),
  ];
  const policy = {
    windowMs: 10_000,
    requestsPerWindow: 100,
    tokensPerWindow: 1000,
    waitNoticeThresholdMs: 5_000,
  };
  const governedReplay = await simulateProviderRate(requests, policy);

  assert.equal(governedReplay.policy.burstToleranceMs, 6_000);
  assert.equal(governedReplay.requests[1].waitMs, 0);
  assert.equal(governedReplay.requests[1].shapedRate.tpm, 200);
  assert.ok(governedReplay.requests.every(item => item.shapedRate.tpm <= policy.tokensPerWindow));
});

test("learning replay raises only a proven capacity lower bound and reduces later waits", async () => {
  const base = Date.parse("2026-07-21T10:00:00");
  const requests = Array.from({ length: 11 }, (_unused, index) => request(index, base + index * 100, 100));
  const policy = {
    windowMs: 10_000,
    requestsPerWindow: 100,
    tokensPerWindow: 1_000,
    burstToleranceMs: 6_000,
    waitNoticeThresholdMs: 5_000,
  };
  const fixed = await simulateProviderRate(requests, policy);
  const learning = await simulateLearningProviderRate(requests, policy);

  assert.equal(learning.requests[7].tpmLimit, 1_000, "low utilization must leave the fallback untouched");
  assert.equal(learning.requests[8].tpmLimit, 1_125, "a successful 90% window becomes a lower bound plus one probe step");
  assert.ok(learning.requests.every(item => item.shapedRate.tpm <= item.tpmLimit));
  assert.ok(
    learning.requests.reduce((sum, item) => sum + item.waitMs, 0)
      < fixed.requests.reduce((sum, item) => sum + item.waitMs, 0),
  );
});

test("provider rate replay renders a finite, self-contained SVG", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qingzhou-provider-rate-"));
  const file = join(directory, "fixture.html");
  try {
    writeFileSync(file, exportHtml({
      title: "<fixture>",
      messages: [assistant("call-a", 60), assistant("call-b", 60)],
      transcript: [
        tool("call-a", "2026-07-21 10:00:00"),
        tool("call-b", "2026-07-21 10:00:01"),
      ],
    }));
    const report = await buildProviderRateReport(file, {
      history: false,
      policy: {
        windowMs: 10_000,
        requestsPerWindow: 100,
        tokensPerWindow: 100,
        waitNoticeThresholdMs: 5_000,
      },
    });
    const svg = renderProviderRateSvg(report);

    assert.match(svg, /^<svg\b/u);
    assert.match(svg, /RPM · 最近 60 秒请求数/u);
    assert.match(svg, /累计等待时间/u);
    assert.match(svg, /无限制/u);
    assert.match(svg, /固定平滑/u);
    assert.match(svg, /学习平滑/u);
    assert.match(svg, /学习额度/u);
    assert.doesNotMatch(svg, /旧算法|新算法/u);
    assert.match(svg, /&lt;fixture&gt;/u);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/u);

    const focusedSvg = renderProviderRateSvg(report, {
      scenarios: ["unlimited", "governed"],
    });
    assert.match(focusedSvg, /无限制/u);
    assert.match(focusedSvg, /固定平滑/u);
    assert.doesNotMatch(focusedSvg, /学习额度/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function exportHtml({ title, messages, transcript }) {
  const exchange = {
    format: "qingzhou.session",
    source: { sessionId: "fixture-session" },
    session: {
      title,
      conversation: {
        entries: messages.map(message => ({ type: "message", message })),
      },
      transcript,
    },
  };
  return `<script id="qingzhou-session-exchange" type="application/json">${JSON.stringify(exchange)}</script>`;
}

function assistant(callId, tokens) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: callId,
      type: "function",
      function: { name: "fixture_tool", arguments: "{}" },
    }],
    _usage: {
      total_tokens: tokens,
      prompt_tokens: tokens - 1,
      completion_tokens: 1,
    },
  };
}

function tool(toolCallId, timestamp) {
  return { type: "tool", toolCallId, timestamp };
}

function request(index, timeMs, tokens) {
  return {
    index,
    fingerprint: `request-${index}`,
    timestamp: "",
    timeMs,
    tokens,
    promptTokens: tokens - 1,
    completionTokens: 1,
    kind: "tool",
    mapped: true,
    sourceFile: "fixture.html",
  };
}
