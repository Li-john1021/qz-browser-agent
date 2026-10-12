import assert from "node:assert/strict";
import {
  highlightCode,
  highlightMarkdownDocument,
  highlightStreamingCode,
  inferCodeLanguage,
  LIVE_HIGHLIGHT_MAX_LENGTH,
  normalizeCodeLanguage,
} from "../../src/sidepanel/ui/code-highlighter.js";

import { hljs } from "../../src/sidepanel/ui/highlight-config.js";
const previousHljs = { getLanguage: hljs.getLanguage, highlight: hljs.highlight, highlightAuto: hljs.highlightAuto };
const calls = [];
Object.assign(hljs, {
  getLanguage(language) {
    return ["javascript", "json", "markdown", "yaml"].includes(language);
  },
  highlight(text, { language }) {
    calls.push({ language, text });
    return {
      value: `<span class="hljs-${language}">${escapeHtml(text)}</span>`,
      language,
      relevance: 3,
    };
  },
  highlightAuto(text, languages) {
    calls.push({ language: "auto", languages, text });
    throw new Error("highlightAuto must not be used");
  },
});

try {
  assert.equal(normalizeCodeLanguage("MJS"), "javascript");
  assert.equal(normalizeCodeLanguage("yml"), "yaml");
  assert.equal(inferCodeLanguage('{"ok": true}'), "json");
  assert.equal(inferCodeLanguage("const answer = 42;"), "javascript");
  assert.equal(inferCodeLanguage('queries: [\n  { query: "teacher flowers" }\n]'), "yaml");
  assert.equal(inferCodeLanguage("ordinary prose without code signals"), "");

  const javascript = highlightCode("const answer = 42;", "js", { autoDetect: false });
  assert.equal(javascript.vendor, "highlight.js");
  assert.equal(javascript.language, "javascript");
  assert.match(javascript.html, /hljs-javascript/);

  const inferredJson = highlightCode('{"answer": 42}', "", { autoDetect: true });
  assert.equal(inferredJson.language, "json");
  assert.equal(calls.at(-1).language, "json");

  const ambiguousCallCount = calls.length;
  const ambiguous = highlightCode("ordinary prose without code signals", "", { autoDetect: true });
  assert.equal(ambiguous.vendor, "plain");
  assert.equal(calls.length, ambiguousCallCount);

  const streamScope = {};
  const streamStartCallCount = calls.length;
  const firstStream = highlightStreamingCode("const answer", "js", {
    scope: streamScope,
    index: 0,
    now: 0,
  });
  assert.equal(calls.length, streamStartCallCount + 1);
  assert.equal(firstStream.provisional, undefined);
  const streamTail = highlightStreamingCode("const answer = <42>", "js", {
    scope: streamScope,
    index: 0,
    now: 20,
  });
  assert.equal(calls.length, streamStartCallCount + 1, "live tail should reuse the highlighted snapshot");
  assert.equal(streamTail.provisional, true);
  assert.match(streamTail.html, /= &lt;42&gt;$/);
  highlightStreamingCode("const answer = <42>;", "js", {
    scope: streamScope,
    index: 0,
    now: 60,
  });
  assert.equal(calls.length, streamStartCallCount + 2, "elapsed live interval should refresh one grammar");
  const finalStream = highlightStreamingCode("const answer = <42>;", "js", {
    scope: streamScope,
    index: 0,
    now: 61,
    final: true,
  });
  assert.equal(finalStream.provisional, undefined);
  assert.equal(calls.length, streamStartCallCount + 3, "completion should run one final precise highlight");

  const beforeLimitCallCount = calls.length;
  const limited = highlightCode("<very-long>", "javascript", { maxLength: 4 });
  assert.equal(calls.length, beforeLimitCallCount, "length-limited code should not invoke highlight.js");
  assert.equal(limited.vendor, "plain");
  assert.equal(limited.skipped, "length-limit");
  assert.equal(limited.html, "&lt;very-long&gt;");

  const markdownSource = [
    "---",
    'name: "demo"',
    "---",
    "# Title",
    "",
    "`code`",
  ].join("\n");
  const markdown = highlightMarkdownDocument(markdownSource);
  assert.equal(markdown.vendor, "highlight.js");
  assert.equal(markdown.language, "markdown");
  assert.deepEqual(calls.slice(-2).map(call => call.language), ["yaml", "markdown"]);
  assert.equal(stripTags(markdown.html), markdownSource, "frontmatter/body split should preserve editor geometry");

  const plainMarkdown = highlightMarkdownDocument("## Heading");
  assert.equal(calls.at(-1).language, "markdown");
  assert.equal(stripTags(plainMarkdown.html), "## Heading");

  const currentSkillSizedMarkdown = highlightMarkdownDocument("x".repeat(32_021));
  assert.equal(currentSkillSizedMarkdown.vendor, "highlight.js");
  assert.equal(calls.at(-1).language, "markdown");

  const oversizedMarkdown = highlightMarkdownDocument("x".repeat(LIVE_HIGHLIGHT_MAX_LENGTH + 1));
  assert.equal(oversizedMarkdown.vendor, "plain");
  assert.equal(oversizedMarkdown.skipped, "length-limit");
  assert.equal(calls.some(call => call.language === "auto"), false);
} finally {
  Object.assign(hljs, previousHljs);
}

console.log("code highlighter tests passed");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
