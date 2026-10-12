#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../../support/typescript-loader.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sources = [
  "tests/benchmarks/conversation-render/fixtures/smoke.json",
  "tests/tool-timeline/fixtures/conversations/family-batch-member-navigation.json",
  "tests/tool-timeline/fixtures/conversations/document-network-console.json",
  "tests/tool-timeline/fixtures/conversations/wide-data-table.json",
].map(path => {
  const fixture = JSON.parse(readFileSync(join(root, path), "utf8"));
  return fixture.transcript || fixture.conversation.entries;
});

// Authored synthetic rounds provide scrollable history and ongoing output while
// the real runner exercises both step and family pagers. No private exports.
const transcript = Array.from({ length: 8 }, (_item, round) => [
  { type: "user", text: `合成交互测试第 ${round + 1} 轮：读取示例证据并整理结果。` },
  ...sources[round % sources.length].filter(entry => ["thinking", "tool"].includes(entry.type)).map((entry, index) => ({
    ...entry,
    ...(entry.type === "tool" ? { toolCallId: `synthetic_round_${round}_tool_${index}` } : {}),
  })),
  {
    type: "assistant",
    content: Array.from({ length: 28 }, (_paragraph, index) => (
      `第 ${round + 1} 轮，第 ${index + 1} 项：这是明确构造的流式交互测试内容，并非用户会话。` +
      "示例页面、正文、脚本和表格提供不同工具展示形态；阅读历史时应保持当前位置，回到底部后应继续跟随最新输出。"
    )).join("\n\n"),
  },
]).flat();

const fixturePath = join(root, "tests/results/conversation-stream-interaction/fixture.json");
mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, `${JSON.stringify({
  name: "synthetic-stream-interaction",
  sessionId: "synthetic_stream_interaction",
  title: "Synthetic streaming interaction coverage",
  transcript,
}, null, 2)}\n`);

const child = spawnSync(process.execPath, [
  join(root, "tests/benchmarks/conversation-render/run.mjs"),
  "--mode", "stream-fixture-interaction",
  "--stream-pace-scale", "0.05",
  "--json",
  "--fail-on-health",
  fixturePath,
], { cwd: root, stdio: "inherit" });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
