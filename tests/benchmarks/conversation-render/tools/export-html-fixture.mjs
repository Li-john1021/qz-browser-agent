import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractSessionExchangePayload } from "../../../../src/shared/session/session-exchange.js";

export function parseExportHtmlFixture(html, options = {}) {
  const source = String(html || "");
  const exchange = parseSessionExchange(source);
  const title = options.title
    || String(exchange?.session?.title || "").trim()
    || stripTags(matchFirst(source, /<title>([\s\S]*?)<\/title>/i))
    || "exported-session";
  const sessionId = safeSessionId(options.sessionId || exchange?.source?.sessionId || title || "exported-session");
  if (Array.isArray(exchange?.session?.transcript)) {
    return {
      name: title,
      sessionId,
      title,
      transcript: exchange.session.transcript.filter(Boolean),
    };
  }
  const transcript = [];

  for (const block of exportMessageBlocks(source)) {
    const className = matchFirst(block.openTag, /\bclass=["']([^"']+)["']/i);
    const body = block.body;
    const timestamp = exportTimestamp(body);
    const type = exportMessageType(block.openTag, className);
    if (type === "user") {
      transcript.push({
        type: "user",
        text: normalizeText(stripTags(body.replace(/<div class="event-meta"[\s\S]*?<\/div>/i, ""))),
        images: [],
        timestamp,
      });
      continue;
    }
    if (type === "assistant") {
      transcript.push({
        type: "assistant",
        content: normalizeText(stripTags(body.replace(/<div class="event-meta"[\s\S]*?<\/div>/i, ""))),
        timestamp,
      });
      continue;
    }
    if (type === "thinking" || type === "thinking-group") {
      transcript.push({
        type: "thinking",
        text: preTexts(body)[0] || "",
        timestamp,
      });
      continue;
    }
    if (type === "tool" || type === "tool-group") {
      transcript.push(parseToolSection(body, transcript.length, timestamp));
    }
  }

  return {
    name: title,
    sessionId,
    title,
    transcript: transcript.filter(Boolean),
  };
}

function parseSessionExchange(source) {
  try {
    return extractSessionExchangePayload(source);
  } catch (_error) {
    return null;
  }
}

function exportMessageBlocks(source) {
  const starts = Array.from(String(source || "").matchAll(
    /<(?:section|div)\b[^>]*\bclass=["']msg\s+[^"']+["'][^>]*>/gi,
  ));
  return starts.map((match, index) => {
    const bodyStart = Number(match.index) + match[0].length;
    const mainEnd = source.indexOf("</main>", bodyStart);
    const bodyEnd = index + 1 < starts.length
      ? Number(starts[index + 1].index)
      : (mainEnd >= 0 ? mainEnd : source.length);
    return {
      openTag: match[0],
      body: source.slice(bodyStart, bodyEnd),
    };
  });
}

function exportMessageType(openTag, className) {
  const explicit = matchFirst(openTag, /\bdata-transcript-type=["']([^"']+)["']/i).trim();
  if (explicit) return explicit;
  const token = String(className || "")
    .trim()
    .split(/\s+/)
    .find(value => value !== "msg" && (/^(?:user|assistant|thinking|tool)$/.test(value) || /^msg-/.test(value)));
  return String(token || "").replace(/^msg-/, "");
}

function parseToolSection(body, index, timestamp) {
  const pres = preTexts(body);
  const summary = normalizeText(stripTags(matchFirst(body, /<summary>([\s\S]*?)<\/summary>/i)));
  const name = toolNameFromSummary(summary);
  return {
    type: "tool",
    toolCallId: `export_tool_${String(index + 1).padStart(4, "0")}`,
    name,
    args: parseJsonOrText(pres[0] || "{}"),
    result: pres.length > 1 ? parseJsonOrText(pres[1]) : null,
    isError: /\berror\b/.test(body) || /错误|失败|error/i.test(summary),
    isRunning: false,
    phase: "done",
    timestamp,
    endedAt: timestamp,
  };
}

function preTexts(html) {
  return Array.from(String(html || "").matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi))
    .map(match => decodeHtml(stripTags(match[1])).trim());
}

function parseJsonOrText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch (_err) {
    return text;
  }
}

function exportTimestamp(html) {
  const meta = stripTags(matchFirst(html, /<div class="event-meta"[\s\S]*?<\/div>/i));
  const match = meta.match(/20\d{2}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
  return match ? match[0] : "";
}

function toolNameFromSummary(summary = "") {
  const label = String(summary || "").replace(/20\d{2}-\d{2}-\d{2}[\s\S]*$/u, "").trim();
  const table = new Map([
    ["加载技能", "load_skill"],
    ["扩展工具", "run_skill_script"],
    ["查找元素", "find_elements"],
    ["解析页面树", "ax_tree"],
    ["查看网络请求", "network_recent"],
    ["页面截图", "screenshot"],
    ["读取文章", "read_article"],
    ["读取页面", "read_dom"],
    ["执行脚本", "run_script"],
  ]);
  return table.get(label) || "tool";
}

function normalizeText(value) {
  return decodeHtml(String(value || ""))
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function matchFirst(value, pattern) {
  return String(value || "").match(pattern)?.[1] || "";
}

function safeSessionId(value) {
  return String(value || "exported-session")
    .normalize("NFKD")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    || "exported-session";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input) {
    console.error("Usage: node tests/benchmarks/conversation-render/tools/export-html-fixture.mjs <export.html> [fixture.json]");
    process.exit(2);
  }
  const fixture = parseExportHtmlFixture(readFileSync(resolve(input), "utf8"), {
    title: input.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""),
    sessionId: input.split(/[\\/]/).pop().replace(/\.[^.]+$/, ""),
  });
  const json = `${JSON.stringify(fixture, null, 2)}\n`;
  if (output) writeFileSync(resolve(output), json);
  else process.stdout.write(json);
}
