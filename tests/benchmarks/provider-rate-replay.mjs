#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseOptions } from "node:util";
import {
  createProviderRateGovernor,
  DEFAULT_PROVIDER_RATE_POLICY,
} from "../../src/background/llm/provider-rate-governor.js";
import { reduceProviderRateLearning } from "../../src/background/llm/provider-rate-learning.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXCHANGE_SCRIPT_ID = "qingzhou-session-exchange";
const DEFAULT_OUTPUT_DIR = resolve(ROOT, "tests/results/provider-rate-replay");
const ACTIVE_IDLE_CAP_MS = 60_000;

export function parseSessionExportHtml(html, file = "") {
  const source = String(html || "");
  const pattern = new RegExp(
    `<script\\b[^>]*\\bid=["']${EXCHANGE_SCRIPT_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i",
  );
  const json = source.match(pattern)?.[1] || "";
  if (!json) throw new Error(`${file || "session export"}: missing ${EXCHANGE_SCRIPT_ID}`);
  let exchange;
  try {
    exchange = JSON.parse(json);
  } catch (error) {
    throw new Error(`${file || "session export"}: invalid session exchange JSON: ${error.message}`);
  }
  if (!Array.isArray(exchange?.session?.conversation?.entries)) {
    throw new Error(`${file || "session export"}: conversation entries are missing`);
  }
  return {
    file,
    exchange,
    sessionId: String(exchange?.source?.sessionId || ""),
    title: String(exchange?.session?.title || basename(file, extname(file)) || "session"),
    updatedAt: String(exchange?.session?.updatedAt || ""),
  };
}

export function discoverSessionExportHistory(targetFile) {
  const target = resolve(targetFile);
  const directory = dirname(target);
  const extension = extname(target);
  const stem = basename(target, extension);
  const match = stem.match(/^(.*?)(?: \((\d+)\))?$/u);
  const family = match?.[1] || stem;
  const targetSequence = match?.[2] == null ? 0 : Number(match[2]);
  const escaped = escapeRegExp(family);
  const familyPattern = new RegExp(`^${escaped}(?: \\((\\d+)\\))?${escapeRegExp(extension)}$`, "u");
  return readdirSync(directory)
    .map(name => {
      const candidate = name.match(familyPattern);
      if (!candidate) return null;
      const sequence = candidate[1] == null ? 0 : Number(candidate[1]);
      if (sequence > targetSequence) return null;
      return { file: join(directory, name), sequence };
    })
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence)
    .map(item => item.file);
}

export function extractUsageRequests(snapshot) {
  const messages = snapshot?.exchange?.session?.conversation?.entries
    ?.map(entry => entry?.message)
    .filter(message => message?.role === "assistant" && positiveNumber(message?._usage?.total_tokens)) || [];
  const transcript = Array.isArray(snapshot?.exchange?.session?.transcript)
    ? snapshot.exchange.session.transcript
    : [];
  const usedTranscriptIndexes = new Set();
  let transcriptCursor = 0;

  return messages.map((message, index) => {
    const toolCallIds = (Array.isArray(message.tool_calls) ? message.tool_calls : [])
      .map(call => String(call?.id || ""))
      .filter(Boolean);
    let eventIndex = -1;
    if (toolCallIds.length) {
      eventIndex = transcript.findIndex((entry, candidateIndex) => (
        !usedTranscriptIndexes.has(candidateIndex)
        && entry?.type === "tool"
        && toolCallIds.includes(String(entry?.toolCallId || ""))
      ));
    }
    if (eventIndex < 0 && message.content) {
      const content = normalizedText(message.content);
      for (let candidateIndex = transcriptCursor; candidateIndex < transcript.length; candidateIndex += 1) {
        const entry = transcript[candidateIndex];
        if (usedTranscriptIndexes.has(candidateIndex) || entry?.type !== "assistant") continue;
        if (normalizedText(entry.content) === content) {
          eventIndex = candidateIndex;
          break;
        }
      }
      if (eventIndex < 0) {
        eventIndex = transcript.findIndex((entry, candidateIndex) => (
          !usedTranscriptIndexes.has(candidateIndex)
          && entry?.type === "assistant"
          && normalizedText(entry.content) === content
        ));
      }
    }

    const event = eventIndex >= 0 ? transcript[eventIndex] : null;
    if (eventIndex >= 0) {
      usedTranscriptIndexes.add(eventIndex);
      transcriptCursor = Math.max(transcriptCursor, eventIndex);
    }
    const spanId = String(event?.parentSpanId || event?.spanId || "");
    const thinking = spanId
      ? transcript.find(entry => entry?.type === "thinking" && entry?.spanId === spanId)
      : null;
    const timestamp = String(thinking?.timestamp || event?.timestamp || "");
    const timeMs = parseTimestamp(timestamp);
    const usage = message._usage || {};
    return {
      index,
      fingerprint: requestFingerprint(message),
      timestamp,
      timeMs,
      tokens: Math.ceil(Number(usage.total_tokens)),
      promptTokens: nonNegativeNumber(usage.prompt_tokens),
      completionTokens: nonNegativeNumber(usage.completion_tokens),
      kind: toolCallIds.length ? "tool" : "answer",
      mapped: Number.isFinite(timeMs),
      sourceFile: snapshot?.file || "",
    };
  });
}

export function mergeRequestTimeline(targetSnapshot, historySnapshots = []) {
  const targetRequests = extractUsageRequests(targetSnapshot);
  if (!targetRequests.length) throw new Error(`${targetSnapshot?.file || "session export"}: no provider usage found`);
  const snapshots = uniqueSnapshots([...historySnapshots, targetSnapshot]);
  const histories = snapshots.map(snapshot => ({ snapshot, requests: extractUsageRequests(snapshot) }));
  const merged = targetRequests.map((target, index) => {
    for (const history of histories) {
      const candidate = history.requests[index];
      if (!candidate || candidate.fingerprint !== target.fingerprint || !candidate.mapped) continue;
      return {
        ...target,
        timestamp: candidate.timestamp,
        timeMs: candidate.timeMs,
        mapped: true,
        sourceFile: history.snapshot.file,
      };
    }
    return target;
  });
  const missing = merged.filter(request => !request.mapped);
  if (missing.length) {
    throw new Error(`Unable to recover timestamps for requests: ${missing.map(item => item.index + 1).join(", ")}`);
  }
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index].timeMs < merged[index - 1].timeMs) {
      throw new Error(`Request timeline moves backwards at request ${index + 1}`);
    }
  }
  return merged;
}

export async function simulateProviderRate(requests, policy = {}) {
  const normalizedPolicy = {
    ...DEFAULT_PROVIDER_RATE_POLICY,
    ...policy,
  };
  let clock = requests[0]?.timeMs || 0;
  const governor = createProviderRateGovernor({
    ...normalizedPolicy,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
  });
  let previousShapedTime = clock;
  const replay = [];

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const naturalGap = index === 0 ? 0 : Math.max(0, request.timeMs - requests[index - 1].timeMs);
    const arrivalTime = index === 0 ? request.timeMs : previousShapedTime + naturalGap;
    clock = arrivalTime;
    const admission = await governor.reserve({
      key: "session-export-replay|usage",
      estimatedTokens: request.tokens,
      sessionId: "provider-rate-replay",
      runId: "provider-rate-replay",
      spanId: `request-${index + 1}`,
    });
    governor.settle(admission.id, request.tokens);
    const shapedTime = admission.startedAt;
    replay.push({
      ...request,
      rawTimeMs: request.timeMs,
      arrivalTimeMs: arrivalTime,
      shapedTimeMs: shapedTime,
      naturalGapMs: naturalGap,
      waitMs: Math.max(0, shapedTime - arrivalTime),
    });
    previousShapedTime = shapedTime;
  }

  attachRollingRates(replay, normalizedPolicy);
  attachActiveTime(replay, ACTIVE_IDLE_CAP_MS);
  return { policy: normalizedPolicy, requests: replay };
}

export async function simulateLearningProviderRate(requests, policy = {}) {
  const fallbackPolicy = {
    ...DEFAULT_PROVIDER_RATE_POLICY,
    ...policy,
  };
  let clock = requests[0]?.timeMs || 0;
  let previousShapedTime = requests[0]?.timeMs || 0;
  let learningState = null;
  let learnedPolicy = null;
  const replay = [];
  const key = "session-export-replay|learning";
  const governor = createProviderRateGovernor({
    ...fallbackPolicy,
    now: () => clock,
    wait: async milliseconds => { clock += milliseconds; },
  });

  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const naturalGap = index === 0 ? 0 : Math.max(0, request.timeMs - requests[index - 1].timeMs);
    const arrivalTime = index === 0 ? request.timeMs : previousShapedTime + naturalGap;
    const effectivePolicy = { ...fallbackPolicy, ...(learnedPolicy || {}) };
    clock = arrivalTime;
    const admission = await governor.reserve({
      key,
      estimatedTokens: request.tokens,
      policy: effectivePolicy,
    });
    governor.settle(admission.id, request.tokens);

    const usage = governor.getUsage(key);
    const learning = reduceProviderRateLearning(learningState, {
      outcome: "success",
      usage,
      windowMs: fallbackPolicy.windowMs,
    }, {
      now: admission.startedAt,
      policy: fallbackPolicy,
    });
    learningState = learning.state;
    learnedPolicy = learning.policy;
    const nextPolicy = { ...fallbackPolicy, ...(learnedPolicy || {}) };
    replay.push({
      ...request,
      rawTimeMs: request.timeMs,
      arrivalTimeMs: arrivalTime,
      shapedTimeMs: admission.startedAt,
      naturalGapMs: naturalGap,
      waitMs: admission.startedAt - arrivalTime,
      shapedRate: { rpm: usage.requests, tpm: usage.tokens },
      rpmLimit: nextPolicy.requestsPerWindow,
      tpmLimit: nextPolicy.tokensPerWindow,
      learned: learning.changed,
    });
    previousShapedTime = admission.startedAt;
  }

  attachRawRates(replay, fallbackPolicy.windowMs);
  attachActiveTime(replay, ACTIVE_IDLE_CAP_MS);
  return { policy: fallbackPolicy, requests: replay };
}

export async function buildProviderRateReport(targetFile, options = {}) {
  const input = resolve(targetFile);
  if (!existsSync(input)) throw new Error(`Session export not found: ${input}`);
  const target = parseSessionExportHtml(readFileSync(input, "utf8"), input);
  const historyFiles = options.history === false ? [input] : discoverSessionExportHistory(input);
  const snapshots = historyFiles.map(file => parseSessionExportHtml(readFileSync(file, "utf8"), file));
  const fullTimeline = mergeRequestTimeline(target, snapshots);
  const timelineStart = options.fromRequest == null
    ? detectReliableTimelineStart(fullTimeline)
    : Math.max(1, Math.floor(Number(options.fromRequest) || 1));
  const timeline = fullTimeline.slice(timelineStart - 1);
  if (!timeline.length) throw new Error(`--from-request ${timelineStart} is beyond the ${fullTimeline.length} available requests`);
  const governedReplay = await simulateProviderRate(timeline, options.policy);
  const learningReplay = await simulateLearningProviderRate(timeline, options.policy);
  const governedRequests = governedReplay.requests;
  const learningRequests = learningReplay.requests;
  const first = governedRequests[0];
  const rawScenario = summarizeRawScenario(governedRequests);
  const governedScenario = summarizeShapedScenario(
    governedRequests,
    governedReplay.policy.waitNoticeThresholdMs,
    "固定平滑",
  );
  const learningScenario = summarizeShapedScenario(
    learningRequests,
    learningReplay.policy.waitNoticeThresholdMs,
    "学习平滑",
  );

  return {
    stage: "provider-rate-replay",
    source: input,
    title: target.title,
    sessionId: target.sessionId,
    snapshots: snapshots.map(snapshot => snapshot.file),
    policies: {
      governed: governedReplay.policy,
      learningFallback: learningReplay.policy,
    },
    methodology: {
      charge: "exported provider total_tokens used as a reproducible proxy for the unavailable request-time estimate",
      timeline: snapshots.length > 1 ? "earliest compatible export timestamp per immutable request prefix" : "target export transcript timestamps",
      activeIdleCapMs: ACTIVE_IDLE_CAP_MS,
      sourceRequestRange: [timelineStart, fullTimeline.length],
      learning: "successful virtual charges are lower-bound evidence; no provider limit or 429 response is invented",
    },
    scenarios: {
      unlimited: rawScenario,
      governed: governedScenario,
      learning: learningScenario,
    },
    histograms: {
      governed: waitHistogram(governedRequests.map(request => request.waitMs)),
      learning: waitHistogram(learningRequests.map(request => request.waitMs)),
    },
    requests: governedRequests.map((request, index) => {
      const learning = learningRequests[index];
      return {
        index: request.index + 1,
        timestamp: request.timestamp,
        sourceFile: request.sourceFile,
        kind: request.kind,
        tokens: request.tokens,
        promptTokens: request.promptTokens,
        completionTokens: request.completionTokens,
        rawOffsetMs: request.rawTimeMs - first.rawTimeMs,
        rawActiveMs: request.rawActiveMs,
        rawRpm: request.rawRate.rpm,
        rawTpm: request.rawRate.tpm,
        rawSegmentStart: request.rawSegmentStart,
        governedOffsetMs: request.shapedTimeMs - governedRequests[0].shapedTimeMs,
        governedActiveMs: request.shapedActiveMs,
        governedWaitMs: request.waitMs,
        governedRpm: request.shapedRate.rpm,
        governedTpm: request.shapedRate.tpm,
        governedSegmentStart: request.shapedSegmentStart,
        learningOffsetMs: learning.shapedTimeMs - learningRequests[0].shapedTimeMs,
        learningActiveMs: learning.shapedActiveMs,
        learningWaitMs: learning.waitMs,
        learningRpm: learning.shapedRate.rpm,
        learningTpm: learning.shapedRate.tpm,
        learningSegmentStart: learning.shapedSegmentStart,
        learningRpmLimit: learning.rpmLimit,
        learningTpmLimit: learning.tpmLimit,
        learningChanged: learning.learned,
      };
    }),
  };
}

function detectReliableTimelineStart(requests) {
  const collapsed = findCollapsedTimestampRun(requests);
  if (!collapsed) return 1;
  throw new Error(
    `Requests ${collapsed.start + 1}-${collapsed.end + 1} share the same exported timestamp (${collapsed.timestamp}); `
    + `their original timing was not preserved. Re-run with --from-request ${collapsed.end + 2} to analyze the reliable suffix, `
    + "or provide earlier compatible exports to recover the missing timeline.",
  );
}

function findCollapsedTimestampRun(requests, threshold = 10) {
  let start = 0;
  for (let index = 1; index <= requests.length; index += 1) {
    if (index < requests.length && requests[index].timeMs === requests[start].timeMs) continue;
    if (index - start >= threshold) {
      return {
        start,
        end: index - 1,
        timestamp: requests[start].timestamp,
      };
    }
    start = index;
  }
  return null;
}

function summarizeRawScenario(requests) {
  const first = requests[0];
  const last = requests.at(-1);
  return {
    label: "无限制",
    spanMs: last.rawTimeMs - first.rawTimeMs,
    activeMs: last.rawActiveMs,
    endDelayMs: 0,
    ...summarizeWaits(requests.map(() => 0), Number.POSITIVE_INFINITY),
    peakRpm: Math.max(0, ...requests.map(request => request.rawRate.rpm)),
    peakTpm: Math.max(0, ...requests.map(request => request.rawRate.tpm)),
  };
}

function summarizeShapedScenario(requests, waitNoticeThresholdMs, label) {
  const first = requests[0];
  const last = requests.at(-1);
  const rawSpanMs = last.rawTimeMs - first.rawTimeMs;
  const shapedSpanMs = last.shapedTimeMs - first.shapedTimeMs;
  return {
    label,
    spanMs: shapedSpanMs,
    activeMs: last.shapedActiveMs,
    endDelayMs: shapedSpanMs - rawSpanMs,
    ...summarizeWaits(requests.map(request => request.waitMs), waitNoticeThresholdMs),
    peakRpm: Math.max(0, ...requests.map(request => request.shapedRate.rpm)),
    peakTpm: Math.max(0, ...requests.map(request => request.shapedRate.tpm)),
  };
}

function summarizeWaits(waits, waitNoticeThresholdMs) {
  const totalWaitMs = waits.reduce((sum, value) => sum + value, 0);
  return {
    totalWaitMs,
    waitedRequests: waits.filter(value => value > 0).length,
    visibleWaitRequests: waits.filter(value => value > waitNoticeThresholdMs).length,
    zeroWaitRequests: waits.filter(value => value === 0).length,
    waitMeanMs: waits.length ? totalWaitMs / waits.length : 0,
    waitP50Ms: percentile(waits, 0.5),
    waitP75Ms: percentile(waits, 0.75),
    waitP90Ms: percentile(waits, 0.9),
    waitP95Ms: percentile(waits, 0.95),
    waitMaxMs: Math.max(0, ...waits),
  };
}

export function renderProviderRateSvg(report, options = {}) {
  const width = 960;
  const height = 820;
  const scenarios = report.scenarios;
  const policy = report.policies.governed;
  const requests = report.requests;
  const scenarioKeys = normalizeScenarioKeys(options.scenarios);
  const xMax = Math.max(
    1,
    ...scenarioKeys.map(key => scenarios[key].activeMs / 60_000),
  );
  const rpmMax = roundUp(Math.max(
    policy.requestsPerWindow,
    ...scenarioKeys.map(key => scenarios[key].peakRpm),
  ), 6);
  const tpmStep = 250_000;
  const tpmMax = roundUp(Math.max(
    policy.tokensPerWindow,
    ...scenarioKeys.map(key => scenarios[key].peakTpm),
    ...(scenarioKeys.includes("learning") ? requests.map(request => request.learningTpmLimit) : []),
  ), tpmStep);
  const rpmFrame = { x: 72, y: 70, width: 840, height: 180 };
  const tpmFrame = { x: 72, y: 330, width: 840, height: 180 };
  const waitFrame = { x: 72, y: 598, width: 840, height: 130 };
  const xTicks = numericTicks(0, xMax, 6);
  const rpmTicks = numericTicks(0, rpmMax, 4);
  const tpmTicks = numericTicks(0, tpmMax, 4);
  const waitMaxSeconds = roundUp(Math.max(
    ...scenarioKeys.map(key => scenarios[key].totalWaitMs),
    1_000,
  ) / 1_000, 60);
  const waitTicks = numericTicks(0, waitMaxSeconds, 3);
  const lineData = [
    {
      key: "unlimited",
      label: "无限制",
      className: "unlimited",
      xField: "rawActiveMs",
      segmentField: "rawSegmentStart",
      rpmField: "rawRpm",
      tpmField: "rawTpm",
    },
    {
      key: "governed",
      label: "固定平滑",
      className: "governed",
      xField: "governedActiveMs",
      segmentField: "governedSegmentStart",
      rpmField: "governedRpm",
      tpmField: "governedTpm",
    },
    {
      key: "learning",
      label: "学习平滑",
      className: "learning",
      xField: "learningActiveMs",
      segmentField: "learningSegmentStart",
      rpmField: "learningRpm",
      tpmField: "learningTpm",
    },
  ].filter(line => scenarioKeys.includes(line.key));
  const title = `${report.title} · Provider 流控回放`;
  const description = `${requests.length} 次请求；导出的 usage 作为虚拟负载代理，比较${lineData.map(line => line.label).join("、")}。限速曲线使用 ${formatSeconds(policy.burstToleranceMs)} 窗口余量平滑突发；学习平滑只把成功负载作为容量下界。`;
  const pieces = [];
  pieces.push(`<svg id="qz-provider-rate-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="qz-rate-svg-title qz-rate-svg-desc">`);
  pieces.push(`<title id="qz-rate-svg-title">${escapeXml(title)}</title><desc id="qz-rate-svg-desc">${escapeXml(description)}</desc>`);
  pieces.push(`<style>
    #qz-provider-rate-svg{--qz-text:var(--foreground,#1d1d1f);--qz-muted:var(--muted-foreground,#7b8180);--qz-grid:var(--border,#e5e7e6);--qz-unlimited:var(--viz-series-2,#c4753a);--qz-governed:var(--viz-series-3,#278b69);--qz-learning:var(--viz-series-1,#476f9f);--qz-limit:var(--muted-foreground,#7b8180);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;background:transparent;color:var(--qz-text)}
    #qz-provider-rate-svg .axis,#qz-provider-rate-svg .note{fill:var(--qz-muted);font-size:15px;font-weight:400}
    #qz-provider-rate-svg .metric{fill:var(--qz-text);font-size:16px;font-weight:500}
    #qz-provider-rate-svg .panel-title{fill:var(--qz-text);font-size:16px;font-weight:500}
    #qz-provider-rate-svg .grid{stroke:var(--qz-grid);stroke-width:1;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .unlimited-line{fill:none;stroke:var(--qz-unlimited);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .governed-line{fill:none;stroke:var(--qz-governed);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .learning-line{fill:none;stroke:var(--qz-learning);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .learning-limit-line{fill:none;stroke:var(--qz-learning);stroke-width:1.3;stroke-dasharray:2 5;stroke-linecap:round;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .limit-line{stroke:var(--qz-limit);stroke-width:1.2;stroke-dasharray:5 5;vector-effect:non-scaling-stroke}
    #qz-provider-rate-svg .legend-unlimited{stroke:var(--qz-unlimited);stroke-width:2}.legend-governed{stroke:var(--qz-governed);stroke-width:2.5}.legend-learning{stroke:var(--qz-learning);stroke-width:2.5}.legend-learning-limit{stroke:var(--qz-learning);stroke-width:1.3;stroke-dasharray:2 5}.legend-limit{stroke:var(--qz-limit);stroke-width:1.2;stroke-dasharray:5 5}
    #qz-provider-rate-svg .bar-unlimited{fill:var(--qz-unlimited);opacity:.82}.bar-governed{fill:var(--qz-governed);opacity:.88}.bar-learning{fill:var(--qz-learning);opacity:.86}
    @media(prefers-color-scheme:dark){#qz-provider-rate-svg{--qz-text:var(--foreground,#f2f3f3);--qz-muted:var(--muted-foreground,#a2a8a6);--qz-grid:var(--border,#343a38);--qz-unlimited:var(--viz-series-2,#d58a51);--qz-governed:var(--viz-series-3,#61b997);--qz-learning:var(--viz-series-1,#79a2d2);--qz-limit:var(--muted-foreground,#a2a8a6)}}
  </style>`);
  pieces.push(renderLegend({ lineData, requests: requests.length, showLearningLimit: scenarioKeys.includes("learning") }));

  pieces.push(renderLinePanel({
    title: "RPM · 最近 60 秒请求数",
    frame: rpmFrame,
    xMax,
    xTicks,
    yMax: rpmMax,
    yTicks: rpmTicks,
    limit: policy.requestsPerWindow,
    limitLabel: `${policy.requestsPerWindow}`,
    requests,
    lineData,
    metric: "rpm",
  }));
  pieces.push(renderLinePanel({
    title: "TPM · 最近 60 秒 token 总量",
    frame: tpmFrame,
    xMax,
    xTicks,
    yMax: tpmMax,
    yTicks: tpmTicks,
    limit: policy.tokensPerWindow,
    limitLabel: formatCompact(policy.tokensPerWindow),
    requests,
    lineData,
    metric: "tpm",
    learningLimitField: scenarioKeys.includes("learning") ? "learningTpmLimit" : "",
  }));
  pieces.push(renderWaitComparison({
    report,
    frame: waitFrame,
    yMax: waitMaxSeconds,
    yTicks: waitTicks,
    scenarioKeys,
  }));
  const footer = scenarioKeys.includes("learning")
    ? `活跃时间折叠自然空闲超过 60 秒的部分；峰值仍按真实 ${formatDuration(policy.windowMs)}窗口计算。学习曲线使用成功的虚拟负载代理，证据过期后保留最近采用速率并重新探测。`
    : `活跃时间折叠自然空闲超过 60 秒的部分；峰值仍按真实 ${formatDuration(policy.windowMs)}窗口计算。最大突发容忍 ${formatSeconds(policy.burstToleranceMs)}。`;
  pieces.push(`<text class="note" x="48" y="798">${escapeXml(footer)}</text>`);
  pieces.push("</svg>");
  return pieces.join("");
}

export function renderProviderRateFragment(svg) {
  return `<div id="provider-rate-replay-figure">
  <style>
    #provider-rate-replay-figure{width:100%;min-width:0;color:var(--foreground);background:transparent}
    #provider-rate-replay-figure svg{display:block;width:100%;height:auto;overflow:visible}
  </style>
  ${svg}
</div>
`;
}

function renderLegend({ lineData, requests, showLearningLimit }) {
  const pieces = ['<g aria-label="图例">'];
  lineData.forEach((line, index) => {
    const x = 48 + index * 124;
    pieces.push(`<line class="legend-${line.className}" x1="${x}" y1="28" x2="${x + 24}" y2="28"/><text class="axis" x="${x + 32}" y="33">${escapeXml(line.label)}</text>`);
  });
  const limitX = 48 + lineData.length * 124;
  pieces.push(`<line class="legend-limit" x1="${limitX}" y1="28" x2="${limitX + 24}" y2="28"/><text class="axis" x="${limitX + 32}" y="33">固定限制</text>`);
  if (showLearningLimit) {
    const learningX = limitX + 112;
    pieces.push(`<line class="legend-learning-limit" x1="${learningX}" y1="28" x2="${learningX + 24}" y2="28"/><text class="axis" x="${learningX + 32}" y="33">学习额度</text>`);
  }
  pieces.push(`<text class="note" x="912" y="33" text-anchor="end">${requests} 次请求 · 横轴为活跃时间（分钟）</text></g>`);
  return pieces.join("");
}

function renderLinePanel({ title, frame, xMax, xTicks, yMax, yTicks, limit, limitLabel, requests, lineData, metric, learningLimitField = "" }) {
  const pieces = [`<g aria-label="${escapeXml(title)}"><text class="panel-title" x="${frame.x}" y="${frame.y - 16}">${escapeXml(title)}</text>`];
  for (const tick of yTicks) {
    const y = scaleY(tick, 0, yMax, frame);
    pieces.push(`<line class="grid" x1="${frame.x}" y1="${round(y)}" x2="${frame.x + frame.width}" y2="${round(y)}"/><text class="axis" x="${frame.x - 12}" y="${round(y + 4)}" text-anchor="end">${escapeXml(metric === "tpm" ? formatCompact(tick) : String(Math.round(tick)))}</text>`);
  }
  for (const tick of xTicks) {
    const x = scaleX(tick, 0, xMax, frame);
    pieces.push(`<line class="grid" x1="${round(x)}" y1="${frame.y}" x2="${round(x)}" y2="${frame.y + frame.height}" opacity=".55"/><text class="axis" x="${round(x)}" y="${frame.y + frame.height + 22}" text-anchor="middle">${round(tick)}</text>`);
  }
  const limitY = scaleY(limit, 0, yMax, frame);
  pieces.push(`<line class="limit-line" x1="${frame.x}" y1="${round(limitY)}" x2="${frame.x + frame.width}" y2="${round(limitY)}"/><text class="axis" x="${frame.x + frame.width - 4}" y="${round(limitY - 7)}" text-anchor="end">限制 ${escapeXml(limitLabel)}</text>`);
  for (const line of lineData) {
    const path = ratePath(requests, line, metric, frame, xMax, yMax);
    pieces.push(`<path class="${line.className}-line" d="${path}"/>`);
  }
  if (learningLimitField) {
    pieces.push(`<path class="learning-limit-line" d="${stepPath(requests, "learningActiveMs", learningLimitField, "learningSegmentStart", frame, xMax, yMax)}"/>`);
  }
  pieces.push("</g>");
  return pieces.join("");
}

function renderWaitComparison({ report, frame, yMax, yTicks, scenarioKeys }) {
  const scenarios = [
    { key: "unlimited", label: "无限制", className: "unlimited" },
    { key: "governed", label: "固定平滑", className: "governed" },
    { key: "learning", label: "学习平滑", className: "learning" },
  ].filter(scenario => scenarioKeys.includes(scenario.key));
  const gap = 44;
  const barWidth = (frame.width - gap * (scenarios.length - 1)) / scenarios.length;
  const governed = report.scenarios.governed;
  const learning = scenarioKeys.includes("learning") ? report.scenarios.learning : null;
  const comparisonNote = learning
    ? `固定 ${formatDuration(governed.totalWaitMs)} · 学习 ${formatDuration(learning.totalWaitMs)} · 学习 P90 ${formatSeconds(learning.waitP90Ms)}`
    : `新增等待 ${formatDuration(governed.totalWaitMs)} · P50 ${formatSeconds(governed.waitP50Ms)} · P90 ${formatSeconds(governed.waitP90Ms)}`;
  const pieces = [`<g aria-label="累计等待时间对比"><text class="panel-title" x="${frame.x}" y="${frame.y - 18}">累计等待时间</text><text class="note" x="${frame.x + frame.width}" y="${frame.y - 18}" text-anchor="end">${escapeXml(comparisonNote)}</text>`];
  for (const tick of yTicks) {
    const y = scaleY(tick, 0, yMax, frame);
    pieces.push(`<line class="grid" x1="${frame.x}" y1="${round(y)}" x2="${frame.x + frame.width}" y2="${round(y)}"/><text class="axis" x="${frame.x - 12}" y="${round(y + 4)}" text-anchor="end">${formatDuration(tick * 1_000)}</text>`);
  }
  scenarios.forEach((scenario, index) => {
    const summary = report.scenarios[scenario.key];
    const seconds = summary.totalWaitMs / 1_000;
    const x = frame.x + index * (barWidth + gap);
    const valueY = scaleY(seconds, 0, yMax, frame);
    const height = Math.max(2, frame.y + frame.height - valueY);
    const y = frame.y + frame.height - height;
    pieces.push(`<rect class="bar-${scenario.className}" x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(height)}" rx="5"/><text class="metric" x="${round(x + barWidth / 2)}" y="${round(y - 8)}" text-anchor="middle">${escapeXml(formatDuration(summary.totalWaitMs))}</text><text class="axis" x="${round(x + barWidth / 2)}" y="${frame.y + frame.height + 22}" text-anchor="middle">${escapeXml(scenario.label)}</text>`);
  });
  pieces.push("</g>");
  return pieces.join("");
}

function ratePath(requests, line, metric, frame, xMax, yMax) {
  const valueField = metric === "rpm" ? line.rpmField : line.tpmField;
  return requests.map((request, index) => {
    const x = scaleX(request[line.xField] / 60_000, 0, xMax, frame);
    const y = scaleY(request[valueField], 0, yMax, frame);
    return `${index === 0 || request[line.segmentField] ? "M" : "L"}${round(x)},${round(y)}`;
  }).join(" ");
}

function stepPath(requests, xField, yField, segmentField, frame, xMax, yMax) {
  const parts = [];
  requests.forEach((request, index) => {
    const x = scaleX(request[xField] / 60_000, 0, xMax, frame);
    const y = scaleY(request[yField], 0, yMax, frame);
    if (index === 0 || request[segmentField]) {
      parts.push(`M${round(x)},${round(y)}`);
      return;
    }
    const previous = requests[index - 1];
    const previousY = scaleY(previous[yField], 0, yMax, frame);
    parts.push(`L${round(x)},${round(previousY)} L${round(x)},${round(y)}`);
  });
  return parts.join(" ");
}

function attachRollingRates(requests, policy) {
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    request.rawRate = rollingUsage(requests, index, "rawTimeMs", request.rawTimeMs, policy.windowMs);
    request.shapedRate = rollingUsage(requests, index, "shapedTimeMs", request.shapedTimeMs, policy.windowMs);
  }
}

function attachRawRates(requests, windowMs) {
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    request.rawRate = rollingUsage(requests, index, "rawTimeMs", request.rawTimeMs, windowMs);
  }
}

function rollingUsage(requests, lastIndex, field, timeMs, windowMs) {
  let rpm = 0;
  let tpm = 0;
  for (let index = 0; index <= lastIndex; index += 1) {
    const request = requests[index];
    if (request[field] + windowMs <= timeMs || request[field] > timeMs) continue;
    rpm += 1;
    tpm += request.tokens;
  }
  return { rpm, tpm };
}

function attachActiveTime(requests, idleCapMs) {
  let rawActiveMs = 0;
  let shapedActiveMs = 0;
  requests.forEach((request, index) => {
    if (index === 0) {
      request.rawActiveMs = 0;
      request.shapedActiveMs = 0;
      request.rawSegmentStart = true;
      request.shapedSegmentStart = true;
      return;
    }
    const previous = requests[index - 1];
    const rawGap = Math.max(0, request.rawTimeMs - previous.rawTimeMs);
    const shapedGap = Math.max(0, request.shapedTimeMs - previous.shapedTimeMs);
    rawActiveMs += Math.min(rawGap, idleCapMs);
    shapedActiveMs += Math.min(shapedGap, idleCapMs);
    request.rawActiveMs = rawActiveMs;
    request.shapedActiveMs = shapedActiveMs;
    request.rawSegmentStart = rawGap > idleCapMs;
    request.shapedSegmentStart = shapedGap > idleCapMs;
  });
}

function waitHistogram(waits) {
  const bins = [
    { label: "0", min: 0, max: 0, exact: true },
    { label: "0–1", min: 0, max: 1_000 },
    { label: "1–5", min: 1_000, max: 5_000 },
    { label: "5–10", min: 5_000, max: 10_000 },
    { label: "10–20", min: 10_000, max: 20_000 },
    { label: "20–30", min: 20_000, max: 30_000 },
    { label: "30+", min: 30_000, max: Number.POSITIVE_INFINITY },
  ].map(bin => ({
    ...bin,
    count: waits.filter(value => bin.exact ? value === 0 : value > bin.min && value <= bin.max).length,
  }));
  while (bins.length > 2 && bins.at(-1).count === 0) bins.pop();
  return bins.map(({ label, min, max, count }) => ({ label, minMs: min, maxMs: max, count }));
}

function requestFingerprint(message) {
  const usage = message?._usage || {};
  const payload = {
    usage: [usage.total_tokens, usage.prompt_tokens, usage.completion_tokens],
    content: message?.content || "",
    toolCalls: (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map(call => ({
      id: call?.id || "",
      name: call?.function?.name || "",
      arguments: call?.function?.arguments || "",
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function uniqueSnapshots(snapshots) {
  const seen = new Set();
  return snapshots.filter(snapshot => {
    const key = resolve(snapshot?.file || `snapshot-${seen.size}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  const milliseconds = Date.parse(text.replace(" ", "T"));
  return Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function numericTicks(min, max, segments) {
  if (max <= min) return [min];
  return Array.from({ length: segments + 1 }, (_unused, index) => min + (max - min) * index / segments);
}

function scaleX(value, min, max, frame) {
  return frame.x + (value - min) / Math.max(1e-9, max - min) * frame.width;
}

function scaleY(value, min, max, frame) {
  return frame.y + (1 - (value - min) / Math.max(1e-9, max - min)) * frame.height;
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "")}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(number));
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}秒`;
  if (seconds >= 3_600) {
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds - hours * 3_600) / 60);
    const remainder = Math.round(seconds - hours * 3_600 - minutes * 60);
    return `${hours}时${minutes ? `${minutes}分` : ""}${remainder ? `${remainder}秒` : ""}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return remainder ? `${minutes}分${remainder}秒` : `${minutes}分钟`;
}

function formatSeconds(milliseconds) {
  return `${((Number(milliseconds) || 0) / 1_000).toFixed(1)}s`;
}

function roundUp(value, step) {
  return Math.max(step, Math.ceil(value / step) * step);
}

function round(value) {
  return Number(value.toFixed(2));
}

function normalizedText(value) {
  return String(value || "").trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : 0;
}

function nonNegativeOption(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.ceil(number) : fallback;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeSlug(value) {
  return String(value || "provider-rate-replay")
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "provider-rate-replay";
}

function parseArgs(argv) {
  const { values, positionals } = parseOptions({ args: argv, allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, "no-history": { type: "boolean" },
    ...Object.fromEntries(["output-dir", "rpm", "tpm", "scenarios", "from-request", "window-ms", "wait-notice-ms", "name", "fragment"].map(key => [key, { type: "string" }])),
  } });
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && (!value.trim() || value.startsWith("--"))) throw new Error(`--${key} requires a value`);
  }
  if (positionals.length > 1) throw new Error("Only one rate replay fixture can be selected");
  return { ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])), _: positionals, history: !values["no-history"] };
}

function normalizeScenarioKeys(value) {
  const allowed = new Set(["unlimited", "governed", "learning"]);
  const requested = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const scenarios = requested.map(item => String(item || "").trim()).filter(item => allowed.has(item));
  return scenarios.length ? [...new Set(scenarios)] : ["unlimited", "governed", "learning"];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input || args.help) {
    console.log("Usage: npm run benchmark -- rate <session-export.html> [--output-dir <dir>] [--rpm 19] [--tpm 980000] [--scenarios unlimited,governed,learning] [--from-request 470] [--no-history]");
    process.exitCode = args.help ? 0 : 2;
    return;
  }
  const report = await buildProviderRateReport(input, {
    history: args.history !== false,
    fromRequest: args.fromRequest,
    policy: {
      windowMs: positiveNumber(args.windowMs) || DEFAULT_PROVIDER_RATE_POLICY.windowMs,
      requestsPerWindow: positiveNumber(args.rpm) || DEFAULT_PROVIDER_RATE_POLICY.requestsPerWindow,
      tokensPerWindow: positiveNumber(args.tpm) || DEFAULT_PROVIDER_RATE_POLICY.tokensPerWindow,
      waitNoticeThresholdMs: nonNegativeOption(args.waitNoticeMs, DEFAULT_PROVIDER_RATE_POLICY.waitNoticeThresholdMs),
    },
  });
  const outputDirectory = resolve(args.outputDir || DEFAULT_OUTPUT_DIR);
  mkdirSync(outputDirectory, { recursive: true });
  const slug = safeSlug(args.name || basename(input, extname(input)));
  const svgFile = resolve(outputDirectory, `${slug}.svg`);
  const jsonFile = resolve(outputDirectory, `${slug}.json`);
  const fragmentFile = args.fragment ? resolve(args.fragment) : "";
  const svg = renderProviderRateSvg(report, { scenarios: args.scenarios });
  writeFileSync(svgFile, `${svg}\n`, "utf8");
  writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (fragmentFile) {
    mkdirSync(dirname(fragmentFile), { recursive: true });
    writeFileSync(fragmentFile, renderProviderRateFragment(svg), "utf8");
  }
  console.log(JSON.stringify({
    stage: report.stage,
    source: report.source,
    snapshots: report.snapshots.length,
    scenarios: report.scenarios,
    artifacts: { svg: svgFile, json: jsonFile, ...(fragmentFile ? { fragment: fragmentFile } : {}) },
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
