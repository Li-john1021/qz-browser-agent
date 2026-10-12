import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scrollTail = readFileSync(join(root, "src/sidepanel/ui/scroll-tail-controller.ts"), "utf8");
const chatScroll = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-scroll-feature.ts"), "utf8"), { mode: "transform" });
const chatWorkspace = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-workspace-feature.ts"), "utf8"), { mode: "transform" });
const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
const sidepanelStyles = ["sidepanel.css"].map(filename => ({
  filename,
  css: readStylesheetSource(join(root, "src/sidepanel", filename)),
}));

testToolInnerScrollTargets();
testChatWheelBoundaryHandoff();
testCollapsibleHeadersUseStableGeometry();
testStreamingPreservesPinnedViewportAnchor();
testInteractionAnchorCoversDeferredLayout();
testTailFollowingObservesMessageLayout();

console.log("scroll tail contract tests passed");

function testToolInnerScrollTargets() {
  for (const selector of [
    '"[data-tool-scroll-surface]"',
    '".markdown-code-block > pre"',
    '".copyable-code-block > pre"',
    '".tool-timeline-slot-body"',
  ]) {
    assert.ok(scrollTail.includes(selector), `inner scroll selector should include ${selector}`);
  }
  const declarations = [
    ["src/sidepanel/tools/generic-result-renderer.ts", ["trace", "markdown-", "text-", "toolScrollSurface = \"code\""]],
    ["src/sidepanel/tools/primitives/tree-renderer.ts", ["tree"]],
    ["src/sidepanel/tools/primitives/image-grid-renderer.ts", ["images"]],
    ["src/capabilities/diagnostics/browser-operations.ts", ["console"]],
    ["src/capabilities/sessions/session-details.ts", ["prompt"]],
    ["src/capabilities/page/browser-operations.ts", ["toolScrollSurface = \"article\""]],
  ];
  for (const [filename, keys] of declarations) {
    const source = readFileSync(join(root, filename), "utf8");
    for (const key of keys) assert.ok(source.includes(key.includes("=") ? key : `data-tool-scroll-surface="${key}`), `${filename} declares scroll surface ${key}`);
  }
}

function testChatWheelBoundaryHandoff() {
  const wheelHandler = extractFunction(chatScroll, "handleMessagesWheel");
  assert.match(
    chatScroll,
    /messagesEl\.addEventListener\("wheel",\s*handleMessagesWheel,\s*\{\s*passive:\s*false\s*\}\)/,
    "chat wheel listener must be non-passive so inner-boundary handoff can prevent double scrolling",
  );
  assert.match(
    wheelHandler,
    /wheelOwner\.innerCandidate && handOffWheelFromInnerBoundary\(delta\)[\s\S]*event\.preventDefault\(\)/,
    "inner scroll boundaries should hand off wheel delta to the chat scroller",
  );
  assert.match(
    wheelHandler,
    /if \(delta < 0\) pauseInnerTailTargetsForOuterHistoryScroll\(event\.target\)/,
    "only upward history intent should release nested live-tail following",
  );
  assert.equal(
    (wheelHandler.match(/pauseInnerTailTargetsForOuterHistoryScroll/g) || []).length,
    1,
    "downward boundary handoff must preserve a nested scroller that the user returned to its tail",
  );
  assert.match(
    chatScroll,
    /function handOffWheelFromInnerBoundary\(delta\)[\s\S]*messagesEl\.scrollTop = next/,
    "wheel handoff should advance the outer chat scroller directly",
  );
  assert.match(
    wheelHandler,
    /const wheelOwner = resolveWheelScrollOwner[\s\S]*if \(wheelOwner\.ownerIsInner\)[\s\S]*return;[\s\S]*beginChatUserScroll\(\)/,
    "scrolling inside a tool must not clear the outer viewport anchor",
  );
  assert.match(
    chatScroll,
    /function handleMessagesScroll\(\)[\s\S]*consumeExpectedProgrammaticChatScroll\(top\)[\s\S]*if \(!hasExplicitChatScrollIntent\(\)\)[\s\S]*scrollToBottom[\s\S]*beginChatUserScroll\(\)/,
    "layout-driven scroll events should preserve live tail while explicit user scrolling releases the viewport anchor",
  );
  assert.match(
    chatScroll,
    /function handleMessagesPointerDown\(event\)[\s\S]*CHAT_SCROLLBAR_HIT_AREA_PX[\s\S]*chatScrollbarPointerId = event\.pointerId;[\s\S]*beginChatUserScroll\(\)/,
    "dragging the native scrollbar should register explicit user scroll intent",
  );
  assert.match(
    chatScroll,
    /function consumeExpectedProgrammaticChatScroll\(top\)[\s\S]*Math\.abs\(top - expected\.top\) < CHAT_SCROLL_INTENT_PX/,
    "the programmatic grace window should ignore only the expected scroll position",
  );
}

function testCollapsibleHeadersUseStableGeometry() {
  for (const { filename, css } of sidepanelStyles) {
    for (const selector of [
      ".msg-tool.tool-expanded",
      ".msg-tool-timeline.tool-timeline-expanded",
      ".msg-thinking-group.thinking-group-expanded",
    ]) {
      const body = cssRuleBody(css, selector);
      assert.doesNotMatch(body, /animation\s*:/, `${filename} ${selector} must not restart animation when its state changes`);
      assert.doesNotMatch(body, /transform\s*:/, `${filename} ${selector} must keep its chiphead layout position stable`);
    }
  }
}

function testStreamingPreservesPinnedViewportAnchor() {
  assert.match(
    transcriptRenderer,
    /function capturePinnedTranscriptViewportAnchor\(\)/,
    "streaming transcript updates need a viewport anchor while the user reads history",
  );
  assert.equal(
    (transcriptRenderer.match(/viewportAnchor = shouldStick \? null : capturePinnedTranscriptViewportAnchor\(\)/g) || []).length,
    2,
    "both full reconciliation and live-tail patching must capture the pinned viewport",
  );
  assert.equal(
    (transcriptRenderer.match(/else if \(viewportAnchor\) scroll\.restoreAnchor\(viewportAnchor\)/g) || []).length,
    2,
    "both transcript patch paths must restore the pinned viewport",
  );
  for (const { filename, css } of sidepanelStyles) {
    assert.match(
      cssRuleBody(css, "#messages"),
      /overflow-anchor:\s*none\s*;/,
      `${filename} should leave transcript anchoring to the shared chat scroll state machine`,
    );
  }
}

function testInteractionAnchorCoversDeferredLayout() {
  assert.match(
    chatScroll,
    /const VIEWPORT_ANCHOR_MIN_SETTLE_MS = 180/,
    "expanded cards should keep their viewport anchor through deferred timeline materialization",
  );
  assert.match(
    chatScroll,
    /function acquireViewportLease\(anchor\)[\s\S]*viewportLease = \{[\s\S]*anchor,[\s\S]*settling: true/,
    "one generic viewport lease should remember the element the user most recently operated",
  );
  assert.doesNotMatch(
    chatScroll,
    /lockScrollTop|kind:\s*"(?:reading|pager)"|holdTimelinePagerViewportAnchor|maintainTimelinePagerViewportAnchor/,
    "viewport behavior should not branch on component-specific anchor kinds",
  );
  assert.match(
    chatScroll,
    /function performProgrammaticChatScroll\(update\)[\s\S]*update\(\);[\s\S]*syncScrollPosition\(\)/,
    "programmatic movement should record its expected position atomically",
  );
  assert.match(
    chatScroll,
    /function ensureViewportAnchorScrollRange\(nextTop\)[\s\S]*messagesEl\.clientHeight/,
    "collapsing content should reserve enough temporary range to avoid browser scroll clamping",
  );
  assert.match(
    transcriptRenderer,
    /const activeAnchor = scroll\.captureActiveAnchor\?\.\(\);[\s\S]*if \(activeAnchor\) return activeAnchor/,
    "streaming reconciliation should preserve the active viewport anchor before selecting a fallback",
  );
  assert.match(
    chatScroll,
    /function scrollToTarget\(target[\s\S]*releaseViewportLease\(\)[\s\S]*target\.scrollIntoView/,
    "programmatic navigation should release the previous viewport anchor before moving",
  );
  assert.match(
    chatWorkspace,
    /createMarkdownFeature\(\{[\s\S]*scrollToTarget:\s*\(?target\)?\s*=>\s*scroll\.scrollToTarget\(target,\s*\{\s*block:\s*"nearest"\s*\}\)/,
    "markdown fragment navigation should use the shared chat scroll owner",
  );
  for (const { filename, css } of sidepanelStyles) {
    assert.match(
      cssRuleBody(css, "#messages::after"),
      /var\(--viewport-anchor-after-space\)/,
      `${filename} should expose automatic after-space compensation`,
    );
    assert.match(
      cssRuleBody(css, "#messages::before"),
      /var\(--viewport-anchor-before-space\)/,
      `${filename} should expose automatic before-space compensation`,
    );
  }
}

function testTailFollowingObservesMessageLayout() {
  assert.match(
    extractFunction(chatScroll, "lockChatTailForSubmittedAction"),
    /chatUserScrollUntil = 0;[\s\S]*chatScrollbarPointerId = null;[\s\S]*setChatTailFollowing\(true\)/,
    "a new user message should supersede stale history-scroll intent before locking the live tail",
  );
  const observerBody = extractFunction(chatScroll, "installChatTailLayoutObservers");
  assert.match(
    observerBody,
    /for\s*\(const child of messagesEl\.children\)\s*observer\.observe\(child\)/,
    "tail following should observe message geometry rather than only the fixed-height scroller",
  );
  assert.match(
    observerBody,
    /new MutationObserver[\s\S]*observer\.unobserve\(node\)[\s\S]*observer\.observe\(node\)/,
    "message layout observation should track transcript replacement without retaining removed nodes",
  );
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function: ${name}`);
}

function cssRuleBody(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
  const bodyStart = css.indexOf("{", start) + 1;
  const end = css.indexOf("}", bodyStart);
  assert.notEqual(end, -1, `unterminated CSS rule: ${selector}`);
  return css.slice(bodyStart, end);
}
