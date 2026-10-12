import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readTestApiKey } from "../support/local-credentials.mjs";

import { createLlmGateway } from "../../src/background/llm/index.js";
import { chatOpenAi, chatStreamOpenAi } from "../../src/capabilities/provider-openai/adapter.js";
import {
  createProviderRateGovernor,
  DEFAULT_PROVIDER_RATE_POLICY,
} from "../../src/background/llm/provider-rate-governor.js";
import { contextTokensFromUsage } from "../../src/background/llm/token-accounting.js";

const akFile = String(process.env.QINGZHOU_DEEPSEEK_AK_FILE || "").trim();
const model = String(process.env.QINGZHOU_DEEPSEEK_MODEL || "deepseek-v4-flash").trim();

const apiKey = readTestApiKey("deepseek", { keyFile: akFile, required: false });
if (!apiKey) {
  console.log("deepseek rate-governor live test skipped: set DEEPSEEK_API_KEY in .env.local or QINGZHOU_DEEPSEEK_AK_FILE");
  process.exit(0);
}

let report = { ok: false, provider: "deepseek", model };
try {
  const result = await runLiveTest(apiKey, model);
  report = result;
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const message = redact(error?.stack || error?.message || String(error), apiKey);
  report.error = message;
  console.error(message);
  process.exitCode = 1;
} finally {
  if (process.env.QINGZHOU_LIVE_REPORT) writeFileSync(process.env.QINGZHOU_LIVE_REPORT, redact(JSON.stringify(report, null, 2), apiKey));
}

async function runLiveTest(key, selectedModel) {
  const trace = [];
  const starts = [];
  const waits = [];
  Object.assign(report, { trace, starts, waits });
  const governor = createProviderRateGovernor({
    onTrace(event) {
      trace.push({ at: Date.now(), ...event });
    },
  });
  const gateway = createLlmGateway({
    rateGovernor: governor,
    adapters: {
      openai: {
        async chat(messages, tools, signal, options, config) {
          starts.push({ at: Date.now(), sessionId: String(options?.sessionId || "") });
          return chatOpenAi(messages, tools, signal, options, config);
        },
        chatStream: chatStreamOpenAi,
      },
    },
  });
  const config = {
    provider: "deepseek",
    apiKey: key,
    model: selectedModel,
    vision: false,
    contextWindow: 128_000,
    trimOldToolResults: true,
    requestRateLimit: true,
    debugMode: false,
  };

  const limitedResults = await Promise.all(Array.from({ length: 3 }, (_, index) => {
    const ordinal = index + 1;
    return gateway.chat(
      [{ role: "user", content: `不要调用工具。只回复精确文本 QZ_RATE_${ordinal}。` }],
      [],
      AbortSignal.timeout(90_000),
      {
        config,
        sessionId: `live_limited_${ordinal}`,
        runId: `run_limited_${ordinal}`,
        spanId: `span_limited_${ordinal}`,
        onRateWait(event) {
          waits.push({ at: Date.now(), ...event });
        },
      },
    );
  }));

  limitedResults.forEach((result, index) => {
    assert.match(String(result?.message?.content || ""), new RegExp(`QZ_RATE_${index + 1}`));
    assert.ok(contextTokensFromUsage(result?.usage) > 0, "DeepSeek must return token usage");
  });

  const limitedStarts = starts
    .filter(item => item.sessionId.startsWith("live_limited_"))
    .sort((left, right) => left.at - right.at);
  assert.equal(limitedStarts.length, 3);
  const limitedGapsMs = adjacentGaps(limitedStarts.map(item => item.at));
  const expectedGapMs = DEFAULT_PROVIDER_RATE_POLICY.windowMs
    / DEFAULT_PROVIDER_RATE_POLICY.requestsPerWindow;
  const limitedOffsetsMs = limitedStarts.map(item => item.at - limitedStarts[0].at);
  const minimumOffsetsMs = limitedStarts.map((_, index) => Math.max(0,
    index * expectedGapMs - DEFAULT_PROVIDER_RATE_POLICY.burstToleranceMs));
  for (const [index, offset] of limitedOffsetsMs.entries()) {
    assert.ok(
      offset >= minimumOffsetsMs[index] - 150,
      `request ${index + 1} must respect the bounded burst admission floor ${minimumOffsetsMs[index].toFixed(1)} ms; got ${offset} ms`,
    );
  }
  assert.ok(minimumOffsetsMs.at(-1) > 0, "the selected request count must exhaust initial burst headroom");
  assert.ok(trace.some(event => event.phase === "waiting" && event.sessionId === "live_limited_3"), "the third concurrent request must enter rate admission waiting");

  const admitted = trace.filter(event => event.phase === "admitted");
  const settled = trace.filter(event => event.phase === "settled");
  assert.equal(admitted.length, 3);
  assert.equal(settled.length, 3);
  assert.deepEqual(
    admitted.map(event => event.sessionId).sort(),
    ["live_limited_1", "live_limited_2", "live_limited_3"],
  );
  assert.deepEqual(
    admitted.map(event => event.runId).sort(),
    ["run_limited_1", "run_limited_2", "run_limited_3"],
  );
  assert.deepEqual(
    admitted.map(event => event.spanId).sort(),
    ["span_limited_1", "span_limited_2", "span_limited_3"],
  );
  assert.ok(trace.every(event => event.rpm <= DEFAULT_PROVIDER_RATE_POLICY.requestsPerWindow));
  assert.ok(trace.every(event => event.tpm <= DEFAULT_PROVIDER_RATE_POLICY.tokensPerWindow));

  const traceCountBeforeBypass = trace.length;
  const bypassResults = await Promise.all(Array.from({ length: 2 }, (_, index) => {
    const ordinal = index + 1;
    return gateway.chat(
      [{ role: "user", content: `不要调用工具。只回复精确文本 QZ_BYPASS_${ordinal}。` }],
      [],
      AbortSignal.timeout(90_000),
      {
        config: { ...config, requestRateLimit: false },
        sessionId: `live_bypass_${ordinal}`,
        runId: `run_bypass_${ordinal}`,
        spanId: `span_bypass_${ordinal}`,
      },
    );
  }));
  bypassResults.forEach((result, index) => {
    assert.match(String(result?.message?.content || ""), new RegExp(`QZ_BYPASS_${index + 1}`));
  });
  assert.equal(trace.length, traceCountBeforeBypass, "rateLimit=false must bypass the governor");

  const bypassStarts = starts
    .filter(item => item.sessionId.startsWith("live_bypass_"))
    .sort((left, right) => left.at - right.at);
  assert.equal(bypassStarts.length, 2);
  const bypassStartGapMs = bypassStarts[1].at - bypassStarts[0].at;
  assert.ok(bypassStartGapMs < 500, `bypassed calls should enter the adapter together; got ${bypassStartGapMs} ms`);

  const actualTokens = limitedResults.map(result => contextTokensFromUsage(result?.usage));
  return {
    ok: true,
    provider: "deepseek",
    model: selectedModel,
    policy: governor.policy,
    limited: {
      calls: limitedResults.length,
      providerStartGapsMs: limitedGapsMs,
      providerStartOffsetsMs: limitedOffsetsMs,
      minimumStartOffsetsMs: minimumOffsetsMs,
      actualTokens,
      totalActualTokens: actualTokens.reduce((sum, value) => sum + value, 0),
      waitNotices: waits.length,
      peakRpm: Math.max(...trace.map(event => event.rpm), 0),
      peakTpm: Math.max(...trace.map(event => event.tpm), 0),
      tracePhases: trace.map(event => ({
        phase: event.phase,
        sessionId: event.sessionId,
        runId: event.runId,
        spanId: event.spanId,
        rpm: event.rpm,
        tpm: event.tpm,
        waitedMs: event.waitedMs,
        waitMs: event.waitMs,
        estimatedTokens: event.estimatedTokens,
        reportedTokens: event.reportedTokens,
      })),
    },
    bypass: {
      calls: bypassResults.length,
      providerStartGapMs: bypassStartGapMs,
      governorEvents: 0,
    },
  };
}

function adjacentGaps(values) {
  return values.slice(1).map((value, index) => value - values[index]);
}

function redact(value, secret) {
  return String(value || "").split(secret).join("***");
}
