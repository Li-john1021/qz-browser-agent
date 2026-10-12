import { readStylesheetSource } from "../support/stylesheet-source.mjs";
import { stripTypeScriptTypes } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const html = ["src/sidepanel/sidepanel.html", "src/capabilities/skills/ui.html"].map(path => readFileSync(join(root, path), "utf8")).join("\n");
const css = ["src/sidepanel/sidepanel.css", "src/capabilities/skills/ui.css"].map(path => readStylesheetSource(join(root, path))).join("\n");
const chatSearchFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/chat-search-feature.ts"), "utf8"), { mode: "transform" });
const transcriptRenderer = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/chat/transcript/renderer.ts"), "utf8"), { mode: "transform" });
const appShellFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/app/app-shell-feature.ts"), "utf8"), { mode: "transform" });
const sessionNavigationFeature = stripTypeScriptTypes(readFileSync(join(root, "src/sidepanel/features/sessions/session-navigation-feature.ts"), "utf8"), { mode: "transform" });
const skillsFeature = stripTypeScriptTypes(readFileSync(join(root, "src/capabilities/skills/workspace/skills-feature.ts"), "utf8"), { mode: "transform" });
const sidepanel = [chatSearchFeature, transcriptRenderer, appShellFeature, sessionNavigationFeature, skillsFeature].join("\n");

assertChatSearchMarkup();
assertChatSearchKeyboardContract();
assertChatSearchRenderContract();
assertChatSearchLifecycleContract();
assertSkillDetailSearchContract();

console.log("chat search contract tests passed");

function assertChatSearchMarkup() {
  assert.match(html, /id="chat-search-bar"/, "chat search bar should be mounted in the side panel");
  assert.match(html, /id="chat-search-input"[^>]+type="search"/, "chat search should use a search input");
  assert.match(html, /id="chat-search-prev"/, "chat search should expose previous navigation");
  assert.match(html, /id="chat-search-next"/, "chat search should expose next navigation");
  assert.match(html, /id="chat-search-close"/, "chat search should expose a close button");
  assert.match(css, /\.chat-search-bar\s*\{[\s\S]*position:\s*absolute/, "chat search should float without shifting the message flow");
  assert.match(css, /\.chat-search-hit\s*\{[\s\S]*background:/, "chat search should highlight matches");
  assert.match(css, /\.msg:is\(\.msg-tool,\s*\.msg-tool-timeline,\s*\.msg-thinking-group\)\.chat-search-active/, "chat search active frame should be limited to tool/thinking cards");
  assert.doesNotMatch(css, /\.msg\.chat-search-active\s*\{[\s\S]*outline:/, "ordinary chat messages should not get an active search frame");
}

function assertChatSearchKeyboardContract() {
  const shortcut = extractFunction(sidepanel, "isChatSearchShortcut");
  assert.match(shortcut, /isActive\(\)/, "search shortcut should only apply while the chat feature is active");
  assert.match(shortcut, /event\.metaKey\s*\|\|\s*event\.ctrlKey/, "search shortcut should support Cmd-F and Ctrl-F");
  assert.match(shortcut, /\.toLowerCase\(\)\s*===\s*"f"/, "search shortcut should bind to F");

  const globalKeydown = extractFunction(sidepanel, "handleChatSearchGlobalKeydown");
  assert.match(globalKeydown, /event\.preventDefault\(\)/, "chat search should take over the native find shortcut inside chat");
  assert.match(globalKeydown, /openChatSearch\(\)/, "chat search shortcut should open the internal search bar");

  const searchKeydown = extractFunction(sidepanel, "handleChatSearchKeydown");
  assert.match(searchKeydown, /event\.key\s*===\s*"Escape"[\s\S]*closeChatSearch\(\)/, "Escape should close chat search");
  assert.match(searchKeydown, /event\.key\s*===\s*"Enter"[\s\S]*jumpChatSearch/, "Enter should jump between matches");
  assert.match(searchKeydown, /event\.shiftKey\s*\?\s*-1\s*:\s*1/, "Shift-Enter should jump backward");
}

function assertChatSearchRenderContract() {
  const resolveIntent = extractFunction(sidepanel, "resolveTranscriptRenderIntent");
  assert.doesNotMatch(resolveIntent, /chatSearchState\.open[\s\S]*"snapshot"/, "keeping search open should not force every live render into a full snapshot");

  const openSearch = extractFunction(sidepanel, "openChatSearch");
  assert.match(openSearch, /renderTranscript\(getSessionId\(\),\s*\{\s*force:\s*true,\s*intent:\s*"snapshot"\s*\}\)/, "opening search should render one full snapshot so old messages are searchable");

  const renderChat = extractFunction(transcriptRenderer, "renderChatTranscript");
  assert.match(renderChat, /syncSearchAfterRender\(id\)/, "rendering should resync search highlights");

  const matches = extractFunction(sidepanel, "updateChatSearchMatches");
  assert.match(matches, /projectTranscript\(history,\s*\{\s*sessionId:\s*getSessionId\(\)(?:\s*\|\|\s*"")?\s*\}\)/, "search should scan the transcript view model");
  assert.match(matches, /entry\?\._uiKey|entry\._uiKey/, "search matches should target stable transcript keys");

  const entryText = extractFunction(sidepanel, "transcriptEntrySearchText");
  assert.match(entryText, /entry\.type\s*===\s*"assistant"[\s\S]*assistantTranscriptSearchText/, "assistant search text should use the math-aware normalizer");

  const assistantText = extractFunction(sidepanel, "assistantTranscriptSearchText");
  assert.match(assistantText, /stripMarkdownMathFromSearchText/, "assistant search should strip Markdown math before matching");

  const stripMath = extractFunction(sidepanel, "stripMarkdownMathFromSearchText");
  assert.match(stripMath, /extractMarkdownMathPlaceholders/, "math stripping should reuse the production Markdown math parser");
  assert.match(stripMath, /@@QZ_MATH_\\d\+@@/, "math stripping should remove generated math placeholders from search text");

  const apply = extractFunction(sidepanel, "applyChatSearchDomState");
  assert.match(apply, /transcriptElementByKey\(match\.key\)/, "search highlights should be derived from transcript keys");
  assert.match(apply, /highlightChatSearchText\(el,\s*query\)/, "search should highlight visible text in matched entries");

  const scroll = extractFunction(sidepanel, "scrollToChatSearchMatch");
  assert.match(scroll, /querySelector\("mark\.chat-search-hit"\)\s*\|\|\s*el/, "search navigation should scroll to the visible highlighted hit before falling back to the message");
  assert.match(scroll, /scrollToMatch\(target\)/, "search navigation should delegate the resolved highlighted target to the chat scroller");

  const skipHighlight = extractFunction(sidepanel, "shouldSkipChatSearchHighlight");
  assert.match(skipHighlight, /\.math-formula/, "chat search should not inject highlight marks into rendered math");
  assert.match(skipHighlight, /mjx-container/, "chat search should skip MathJax internals");
  assert.doesNotMatch(skipHighlight, /\bpre\b|\bcode\b|markdown-code-block/, "chat search should keep code blocks searchable and highlightable");
}

function assertChatSearchLifecycleContract() {
  const switchTab = extractFunction(sidepanel, "switchTab");
  assert.match(switchTab, /options\.ui\.deactivatePage\(\)/, "switching away from chat should deactivate its page");
  const workspace = readFileSync(join(root, "src/sidepanel/features/app/workspace-composition.ts"), "utf8");
  assert.match(workspace, /deactivate:\s*\(\)\s*=>\s*chat\.search\.close\(\{\s*restoreFocus:\s*false/, "the chat page must close its search without restoring focus");

  const setSession = extractFunction(sessionNavigationFeature, "setCurrentSessionId");
  assert.match(setSession, /previous !== next[\s\S]*options\.chatSearch\?\.close\(\{\s*restoreFocus:\s*false\s*\}\)/, "changing session should close search");

  assert.match(
    sidepanel,
    /document\.addEventListener\("keydown",\s*handleChatSearchGlobalKeydown,\s*\{\s*capture:\s*true\s*\}\)/,
    "chat search shortcut should be registered in capture phase",
  );
}

function assertSkillDetailSearchContract() {
  assert.match(html, /id="skill-search-bar"[^>]+class="[^"]*\bqz-popover\b[^"]*\bchat-search-bar\b[^"]*\bskill-search-bar\b[^"]*\bhidden\b/, "skill search should reuse the shared floating search surface");
  assert.match(html, /id="skill-search-input"[^>]+class="[^"]*\bqz-field\b[^"]*\bchat-search-input\b[^>]+type="search"/, "skill search should reuse the shared field and chat search input styles");
  assert.match(css, /\.skill-detail\s*\{[\s\S]*position:\s*relative/, "skill search should anchor to the detail view");
  assert.match(css, /\.chat-search-hit\.skill-search-active/, "skill search should distinguish the active text match");

  const shortcut = extractFunction(sidepanel, "isSkillSearchShortcut");
  assert.match(shortcut, /isActive\(\)/, "skill search shortcut should only apply while the Skills feature is active");
  assert.match(shortcut, /isElementVisible\(skillDetail\)/, "skill search shortcut should require an open detail view");
  assert.match(shortcut, /!isEditingSkill/, "skill search should leave the editor's native find behavior intact");
  assert.match(shortcut, /event\.metaKey\s*\|\|\s*event\.ctrlKey/, "skill search should support Cmd-F and Ctrl-F");

  const keydown = extractFunction(sidepanel, "handleSkillSearchKeydown");
  assert.match(keydown, /event\.key\s*===\s*"Escape"[\s\S]*closeSkillSearch\(\)/, "Escape should close skill search");
  assert.match(keydown, /event\.key\s*===\s*"Enter"[\s\S]*jumpSkillSearch/, "Enter should navigate skill matches");
  assert.match(keydown, /event\.shiftKey\s*\?\s*-1\s*:\s*1/, "Shift-Enter should navigate backward");

  const matches = extractFunction(sidepanel, "updateSkillSearchMatches");
  assert.match(matches, /highlightSearchText\(skillDetailContent,\s*query\)/, "skill search should reuse the injected chat text highlighter");
  assert.match(matches, /querySelectorAll\("mark\.chat-search-hit"\)/, "skill search should navigate every visible occurrence");

  const editMode = extractFunction(sidepanel, "setSkillEditMode");
  assert.match(editMode, /if\s*\(editing\)\s*closeSkillSearch\(\{\s*restoreFocus:\s*false\s*\}\)/, "entering edit mode should close detail search");
  const closeDetail = extractFunction(sidepanel, "closeSkillDetail");
  assert.match(closeDetail, /closeSkillSearch\(\{\s*restoreFocus:\s*false\s*\}\)/, "closing the detail should clear search highlights");
  const switchTab = extractFunction(appShellFeature, "switchTab");
  assert.match(switchTab, /options\.ui\.deactivatePage\(\)/, "leaving a page should deactivate its detail UI");
  const skillsUi = readFileSync(join(root, "src/capabilities/skills/ui.ts"), "utf8");
  assert.match(skillsUi, /deactivate:\s*(?:\([^)]*\)\s*=>\s*)?skills\.deactivate/, "the Skill page should bind its detail cleanup");
  const deactivate = extractFunction(skillsFeature, "deactivate");
  assert.match(deactivate, /closeSkillSearch\(\{\s*restoreFocus:\s*false\s*\}\)/, "deactivating Skills should close detail search");
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const parenStart = source.indexOf("(", start);
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  assert.notEqual(parenEnd, -1, `unterminated signature for ${name}`);
  const braceStart = source.indexOf("{", parenEnd);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}
