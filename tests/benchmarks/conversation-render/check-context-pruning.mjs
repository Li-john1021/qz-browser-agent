#!/usr/bin/env node
import { createTestAgentOptions } from "../../support/agent-services.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../../../src/background/agent/compaction.js";
import {
  deserializeConversationWithRepair,
  serializeConversation,
  transcriptFromConversation,
} from "../../../src/shared/session/session-codec.js";
import { repairToolMessageSequence } from "../../../src/shared/tools/tool-message-protocol.js";
import { parseExportHtmlFixture } from "./tools/export-html-fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_DIR = resolve(ROOT, "tests/benchmarks/conversation-render/fixtures");
const CONTEXT_WINDOW = positiveNumber(process.env.QINGZHOU_PRUNE_CONTEXT_WINDOW, 262000);
const RESERVE_TOKENS = 16000;
const RECENT_ROUNDS = 2;

installChromeStub();
const { Agent } = await import(`../../../src/background/agent/agent.js?fixture-prune=${Date.now()}`);
const inputs = resolveInputs(process.argv.slice(2));
const reports = [];

for (const input of inputs) {
  reports.push(await checkFixture(input));
}

console.log(JSON.stringify({
  stage: "context-pruning-correctness",
  contextWindow: CONTEXT_WINDOW,
  fixtures: reports,
  totals: {
    fixtures: reports.length,
    messages: sum(reports, "messages"),
    toolResults: sum(reports, "toolResults"),
    trimmedToolResults: sum(reports, "trimmedToolResults"),
    sendTokensBefore: sum(reports, "sendTokensBefore"),
    sendTokensAfter: sum(reports, "sendTokensAfter"),
  },
}, null, 2));

async function checkFixture(file) {
  const fixture = readFixture(file);
  const messages = fixtureMessages(fixture);
  const agent = new Agent(`fixture-prune-${safeName(fixture.sessionId || basename(file))}`, createTestAgentOptions());
  agent.messages = messages;
  agent._runProfile = {
    model: { contextWindow: CONTEXT_WINDOW, trimOldToolResults: true },
    features: { imageInput: true },
  };
  let persistWrites = 0;
  agent._persistConversation = async () => { persistWrites++; };

  assertProtocol(messages, `${file}: stored before`);
  const canonicalBefore = digest(withoutTrimMarkers(messages));
  const uiBefore = digest(uiTranscript(messages));
  const sendBefore = agent._buildSendMessages();
  const sendBeforeDigest = digest(sendBefore);
  const sendTokensBefore = estimateTokens(sendBefore);
  const pressureBefore = toolPressure(agent, messages);

  const changed = await agent._pruneOldToolResultsIfNeeded();
  const trimmedTools = messages.filter(msg => msg?.role === "tool" && msg.trim === true);
  const trimmedImages = messages.filter(msg => msg?.role === "user" && msg.trim === true);
  const sendAfter = agent._buildSendMessages();
  const sendAfterDigest = digest(sendAfter);
  const sendTokensAfter = estimateTokens(sendAfter);
  const pressureAfter = toolPressure(agent, messages);

  assert.equal(digest(withoutTrimMarkers(messages)), canonicalBefore, `${file}: pruning changed canonical messages`);
  assert.equal(digest(uiTranscript(messages)), uiBefore, `${file}: pruning changed reconstructed UI transcript`);
  assertProtocol(messages, `${file}: stored after`);
  assertProtocol(sendAfter, `${file}: projected after`);
  assertRecentRoundsProtected(messages, file);
  assertProtectedToolsIntact(messages, file);
  assertMarkersAreScoped(messages, file);
  assert.ok(sendTokensAfter <= sendTokensBefore, `${file}: projected context grew after pruning`);
  if (trimmedTools.length) {
    assert.ok(sendTokensAfter < sendTokensBefore, `${file}: trimmed tools did not reduce projected tokens`);
    assert.ok(pressureAfter.remainingTokens <= pressureBefore.protectTokens, `${file}: untrimmed eligible tools exceed the protected budget`);
  }
  if (pressureBefore.shouldPrune) {
    assert.equal(changed, true, `${file}: fixture exceeds the pruning watermark but no batch ran`);
    assert.ok(trimmedTools.length > 0, `${file}: fixture exceeds the pruning watermark but no tool result was marked`);
  }
  assert.equal(persistWrites, changed ? 1 : 0, `${file}: pruning should persist at most once`);

  const writesAfterFirstPass = persistWrites;
  assert.equal(await agent._pruneOldToolResultsIfNeeded(), false, `${file}: second pruning pass should be stable`);
  assert.equal(persistWrites, writesAfterFirstPass, `${file}: stable pass rewrote storage`);
  assert.equal(digest(agent._buildSendMessages()), sendAfterDigest, `${file}: stable pass changed the model projection`);

  agent._runProfile.model.trimOldToolResults = false;
  assert.equal(digest(agent._buildSendMessages()), sendBeforeDigest, `${file}: disabling pruning did not restore the original projection`);

  return {
    fixture: fixture.name || fixture.title || basename(file),
    source: file,
    messages: messages.length,
    userRounds: messages.filter(isUserRound).length,
    toolResults: messages.filter(msg => msg?.role === "tool").length,
    eligibleToolTokens: pressureBefore.eligibleTokens,
    protectedToolBudget: pressureBefore.protectTokens,
    pruneBatchMinimum: pressureBefore.pruneMinimum,
    changed,
    trimmedToolResults: trimmedTools.length,
    trimmedImages: trimmedImages.length,
    trimmedToolChars: trimmedTools.reduce((total, msg) => total + String(msg.content || "").length, 0),
    sendTokensBefore,
    sendTokensAfter,
    sendTokenReduction: sendTokensBefore - sendTokensAfter,
    persistWrites,
    canonicalDigest: canonicalBefore,
    uiTranscriptDigest: uiBefore,
  };
}

function fixtureMessages(fixture = {}) {
  const stored = fixture.conversation || fixture.record?.conversation || fixture.sessionRecord?.conversation;
  if ((Array.isArray(stored) && stored.length) || (!Array.isArray(stored) && stored && typeof stored === "object")) {
    return deserializeConversationWithRepair(stored, "fixture system prompt").messages;
  }

  const messages = [{ role: "system", content: "fixture system prompt" }];
  const usedCallIds = new Set();
  for (const [index, entry] of (Array.isArray(fixture.transcript) ? fixture.transcript : []).entries()) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "user") {
      const images = normalizeImages(entry.images);
      messages.push({
        role: "user",
        _origin: "user",
        content: images.length
          ? [{ type: "text", text: String(entry.text || "") }, ...images]
          : String(entry.text || ""),
      });
      continue;
    }
    if (entry.type === "assistant") {
      const content = String(entry.content || "");
      if (content) messages.push({ role: "assistant", content });
      continue;
    }
    if (entry.type !== "tool") continue;

    const callId = uniqueCallId(entry.toolCallId || `fixture_tool_${index + 1}`, usedCallIds);
    const name = String(entry.name || "tool").trim() || "tool";
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: callId,
        type: "function",
        function: { name, arguments: jsonText(entry.args ?? {}) },
      }],
    });
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: typeof entry.result === "string" ? entry.result : jsonText(entry.result ?? ""),
    });
  }
  return messages;
}

function toolPressure(agent, messages) {
  const protectedStart = protectedStartIndex(messages);
  const names = toolNamesByCallId(messages);
  const eligible = messages.filter((msg, index) => (
    index < protectedStart
    && msg?.role === "tool"
    && names.get(String(msg.tool_call_id || "")) !== "load_skill"
  ));
  const eligibleTokens = eligible.reduce((total, msg) => total + agent._estimateStoredMessageTokens(msg), 0);
  const threshold = Math.max(1, CONTEXT_WINDOW - RESERVE_TOKENS);
  const protectTokens = Math.max(1, Math.floor(threshold * 0.2));
  const pruneMinimum = Math.max(1, Math.floor(protectTokens * 0.5));
  const remainingTokens = eligible
    .filter(msg => msg.trim !== true)
    .reduce((total, msg) => total + agent._estimateStoredMessageTokens(msg), 0);
  return {
    eligibleTokens,
    remainingTokens,
    protectTokens,
    pruneMinimum,
    shouldPrune: eligibleTokens > protectTokens + pruneMinimum,
  };
}

function assertRecentRoundsProtected(messages, file) {
  const start = protectedStartIndex(messages);
  for (let i = start; i < messages.length; i++) {
    assert.notEqual(messages[i]?.trim, true, `${file}: recent message ${i} was marked for pruning`);
  }
}

function assertProtectedToolsIntact(messages, file) {
  const names = toolNamesByCallId(messages);
  for (const msg of messages) {
    if (msg?.role !== "tool") continue;
    if (names.get(String(msg.tool_call_id || "")) !== "load_skill") continue;
    assert.notEqual(msg.trim, true, `${file}: load_skill result was marked for pruning`);
  }
}

function assertMarkersAreScoped(messages, file) {
  for (const [index, msg] of messages.entries()) {
    if (msg?.trim !== true) continue;
    const valid = msg.role === "tool" || (msg.role === "user" && hasImage(msg));
    assert.equal(valid, true, `${file}: trim marker leaked to message ${index} (${msg.role})`);
  }
}

function assertProtocol(messages, label) {
  const repaired = repairToolMessageSequence(messages);
  assert.equal(
    repaired.changed,
    false,
    `${label}: invalid tool protocol (inserted=${repaired.inserted}, dropped=${repaired.dropped})`,
  );
}

function protectedStartIndex(messages) {
  const users = [];
  for (let i = 0; i < messages.length; i++) if (isUserRound(messages[i])) users.push(i);
  if (!users.length) return messages.length;
  return users[Math.max(0, users.length - RECENT_ROUNDS)];
}

function toolNamesByCallId(messages) {
  const names = new Map();
  for (const msg of messages) {
    if (msg?.role !== "assistant") continue;
    for (const call of msg.tool_calls || []) {
      const id = String(call?.id || "").trim();
      if (id) names.set(id, String(call.function?.name || "").trim());
    }
  }
  return names;
}

function uiTranscript(messages) {
  return stripVolatile(transcriptFromConversation(serializeConversation(messages)));
}

function withoutTrimMarkers(messages) {
  return messages.map(msg => {
    if (!msg || typeof msg !== "object") return msg;
    const { trim: _trim, ...rest } = msg;
    return rest;
  });
}

function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (["timestamp", "startedAt", "endedAt", "durationMs"].includes(key)) continue;
    out[key] = stripVolatile(item);
  }
  return out;
}

function normalizeImages(images) {
  return (Array.isArray(images) ? images : []).flatMap(image => {
    const url = typeof image === "string" ? image : String(image?.dataUrl || image?.url || "");
    if (!url.startsWith("data:image/")) return [];
    return [{ type: "image_url", image_url: { url, detail: "auto" } }];
  });
}

function hasImage(msg) {
  return Array.isArray(msg?.content) && msg.content.some(part => part?.type === "image_url");
}

function isUserRound(msg) {
  return msg?.role === "user" && (!msg._origin || msg._origin === "user");
}

function uniqueCallId(value, used) {
  const base = String(value || "fixture_tool").trim() || "fixture_tool";
  let id = base;
  let suffix = 1;
  while (used.has(id)) id = `${base}_${++suffix}`;
  used.add(id);
  return id;
}

function jsonText(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch (_err) {
    return String(value ?? "");
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function readFixture(file) {
  const text = readFileSync(file, "utf8");
  if (/\.html?$/i.test(file)) {
    return parseExportHtmlFixture(text, {
      sessionId: safeName(basename(file, extname(file))),
      title: basename(file, extname(file)),
    });
  }
  return JSON.parse(text);
}

function resolveInputs(args) {
  const requested = args.filter(arg => !arg.startsWith("-")).map(file => resolve(file));
  const files = requested.length
    ? requested
    : readdirSync(FIXTURE_DIR)
      .filter(file => file.endsWith(".json"))
      .sort()
      .map(file => resolve(FIXTURE_DIR, file));
  assert.ok(files.length, "No conversation benchmark fixtures found");
  for (const file of files) assert.ok(existsSync(file), `Fixture not found: ${file}`);
  return files;
}

function installChromeStub() {
  const storage = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: storage[key] };
          if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, storage[item]]));
          return { ...storage };
        },
        async set(value) { Object.assign(storage, value || {}); },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) delete storage[item];
        },
      },
    },
    runtime: { getURL: path => path },
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeName(value) {
  return String(value || "fixture").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "fixture";
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}
