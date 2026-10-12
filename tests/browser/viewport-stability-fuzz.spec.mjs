import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./sidepanel-fixtures.mjs";
import { loadFuzzCorpus } from "../support/fuzz-corpus.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const privateCorpus = process.env.QINGZHOU_FUZZ_CORPUS;
const paintedFramesPerAction = 12;
const syntheticHistoryTurns = 6;
const chatTextSizes = ["small", "compact", "standard", "comfortable", "large", "xlarge"];
// The default verification suite must work from a checkout, without private session exports.
const fixturePaths = [
  "tests/benchmarks/conversation-render/fixtures/smoke.json",
  "tests/tool-timeline/fixtures/conversations/single-tool-long-raw.json",
  "tests/tool-timeline/fixtures/conversations/family-batch-member-navigation.json",
  "tests/tool-timeline/fixtures/conversations/document-network-console.json",
  "tests/tool-timeline/fixtures/conversations/thinking-tools-stream.json",
  "tests/tool-timeline/fixtures/conversations/turn-boundary-grouping.json",
  "tests/tool-timeline/fixtures/conversations/wide-data-table.json",
];
const fixtures = loadFuzzCorpus(root, privateCorpus, fixturePaths);


test.describe("seeded viewport stability fuzz", () => {
  test("measures painted viewport geometry across 60 repository-fixture and six-size cases", async ({ page }, testInfo) => {
    test.setTimeout(privateCorpus ? 600_000 : 240_000);
    const reportDir = privateCorpus
      ? testInfo.outputPath("viewport-fuzz")
      : join(root, "tests/results/viewport-stability-fuzz");
    const profiles = [
      { width: 360, height: 640 },
      { width: 430, height: 844 },
      { width: 560, height: 760 },
    ];
    for (const fixture of fixtures) {
      expect(fixture.transcript.some(entry => entry?.type === "tool"), `${fixture.path} must supply tool entries`).toBe(true);
    }
    const cases = buildCases(60, fixtures, testInfo.repeatEachIndex * 60 * 7919);
    for (const fixture of fixtures) {
      const sourceCases = cases.filter(item => item.fixturePath === fixture.path);
      expect(new Set(sourceCases.map(item => item.profile.width)).size, fixture.path).toBe(profiles.length);
      expect(new Set(sourceCases.map(item => item.live)).size, fixture.path).toBe(2);
    }
    const results = [];

    for (const profile of profiles) {
      await page.setViewportSize(profile);
      const profileCases = cases.filter(item => item.profile.width === profile.width);
      for (const fuzzCase of profileCases) {
        await page.emulateMedia({ colorScheme: fuzzCase.colorScheme });
        results.push(await page.evaluate(runFuzzCase, fuzzCase));
      }
    }

    const report = buildReport(results, fixtures);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(reportDir, "report.md"), renderMarkdownReport(report));
    await testInfo.attach("viewport-stability-fuzz-report.json", {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: "application/json",
    });

    expect(report.summary.executed).toBe(60);
    expect(report.summary.runtimeErrors, JSON.stringify(report.failures, null, 2)).toBe(0);
    expect(report.summary.nodeReplacementCases, JSON.stringify(report.failures, null, 2)).toBe(0);
    expect(report.summary.actions).toBeGreaterThan(300);
    expect(report.summary.textSizeActions).toBeGreaterThanOrEqual(60);
    expect(report.summary.historyTextSizeActions).toBeGreaterThan(0);
    expect(report.summary.directionReversalCases, JSON.stringify(report.failures, null, 2)).toBe(0);
    expect(report.summary.unstableCases, JSON.stringify(report.failures, null, 2)).toBe(0);
    expect(report.summary.maxInteractionDriftPx, JSON.stringify(report.failures, null, 2)).toBeLessThan(0.5);
    expect(report.summary.maxTextSizeDriftPx, JSON.stringify(report.failures, null, 2)).toBeLessThanOrEqual(2);
    expect(report.summary.maxHorizontalOverflowPx, JSON.stringify(report.failures, null, 2)).toBeLessThanOrEqual(1);
    expect(report.textSizeBreakdown.map(item => item.textSize)).toEqual(chatTextSizes);
    expect(report.textSizeBreakdown.every(item => item.cases > 0 && item.unstableCases === 0)).toBe(true);
    expect(report.summary.streamActionsWithContentChange).toBeGreaterThan(0);
    expect(report.summary.streamActionsWithLayoutChange).toBeGreaterThan(0);
  });
});

function buildCases(count, sources, seedOffset = 0) {
  const profiles = [
    { width: 360, height: 640 },
    { width: 430, height: 844 },
    { width: 560, height: 760 },
  ];
  return Array.from({ length: count }, (_item, index) => {
    const seed = 0x51f15e + seedOffset + index * 7919;
    const random = seededRandom(seed);
    const fixture = sources[index % sources.length];
    const toolIndexes = fixture.transcript.flatMap((entry, entryIndex) => entry?.type === "tool" ? [entryIndex] : []);
    const targetIndex = toolIndexes[Math.floor(random() * toolIndexes.length)];
    const live = privateCorpus ? Math.floor(index / (sources.length * profiles.length)) % 2 === 0 : index % 2 === 0;
    const before = 8 + Math.floor(random() * 24);
    const after = live ? 0 : 6 + Math.floor(random() * 20);
    const start = Math.max(0, targetIndex - before);
    const end = Math.min(fixture.transcript.length, targetIndex + after + 1);
    // Explicit synthetic history keeps short fixtures scrollable even with tools collapsed.
    const history = Array.from({ length: syntheticHistoryTurns }, (_entry, turn) => [
      { type: "user", text: `合成历史第 ${turn + 1} 轮：请整理本轮结果。` },
      { type: "assistant", content: Array.from({ length: 3 }, (_paragraph, paragraph) => (
        `第 ${paragraph + 1} 项结果：这是用于滚动锚点验证的固定测试内容。切换字号或展开工具时，应保留用户正在阅读的位置。`
      )).join("\n\n") },
    ]).flat();
    return {
      caseId: `case-${String(index + 1).padStart(2, "0")}`,
      seed,
      fixture: fixture.name,
      fixturePath: fixture.path,
      profile: profiles[privateCorpus ? Math.floor(index / sources.length) % profiles.length : index % profiles.length],
      colorScheme: Math.floor(index / (sources.length * profiles.length * 2)) % 2 ? "dark" : "light",
      textSize: chatTextSizes[(Math.floor(index / profiles.length) + (index % profiles.length) * 2) % chatTextSizes.length],
      textSizeMode: live ? "tail" : "history",
      live,
      paintedFramesPerAction,
      scrollRatio: random(),
      toggleCount: 3 + Math.floor(random() * 5),
      targetOffset: history.length + targetIndex - start,
      transcript: [...history, ...structuredClone(fixture.transcript.slice(start, end))],
    };
  });
}

async function runFuzzCase(input) {
  const sampleFrameCount = Math.max(1, Number(input.paintedFramesPerAction) || 1);
  const textSizes = ["small", "compact", "standard", "comfortable", "large", "xlarge"];
  function randomFromSeed(seed) {
    let state = Number(seed) >>> 0;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x100000000;
    };
  }
  function waitFrames(count) {
    return new Promise(resolve => {
      const tick = remaining => requestAnimationFrame(() => remaining <= 1 ? resolve() : tick(remaining - 1));
      tick(Math.max(1, count));
    });
  }
  async function settleInitialLayout(messages) {
    let previous = "";
    let stableFrames = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      await waitFrames(1);
      const geometry = `${messages.scrollHeight}:${messages.clientHeight}`;
      const animating = messages.getAnimations({ subtree: true }).some(animation => (
        (animation.playState === "running" || animation.pending)
          && Number.isFinite(animation.effect?.getComputedTiming().endTime)
      ));
      stableFrames = geometry === previous && !animating ? stableFrames + 1 : 0;
      if (stableFrames >= 3) return;
      previous = geometry;
    }
    throw new Error("fixture initialization layout did not settle");
  }
  function summaryFor(card) {
    return card?.querySelector(":scope > .tool-summary, :scope > .tool-timeline-summary, :scope > .thinking-group-summary") || null;
  }
  function visibleIn(element, viewport) {
    const rect = element.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return rect.top >= bounds.top + 2 && rect.bottom <= bounds.bottom - 2;
  }
  function streamContentSignature() {
    const text = Array.from(document.querySelectorAll(".msg-thinking-group"), element => element.textContent || "").join("\n");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${hash >>> 0}`;
  }
  function visibleTranscriptAnchor(messages) {
    const viewport = messages.getBoundingClientRect();
    return Array.from(messages.children).find(element => {
      if (!(element instanceof Element) || !element.dataset.transcriptKey) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top + 2 && rect.top < viewport.bottom - 2;
    }) || null;
  }
  async function measureTextSizeStep(messages, requestedMode, fromSize, toSize, mutate) {
    const mode = requestedMode === "history"
      && messages.scrollHeight > messages.clientHeight + 2
      ? "history"
      : "tail";
    if (mode === "history") {
      messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, bubbles: true, cancelable: true }));
    }
    const anchor = mode === "history" ? visibleTranscriptAnchor(messages) : null;
    if (mode === "history" && !anchor) throw new Error("text-size transition has no visible transcript anchor");
    const position = () => mode === "history"
      ? anchor.getBoundingClientRect().top
      : Math.max(0, messages.scrollHeight - messages.scrollTop - messages.clientHeight);
    const baseline = position();
    const baselineScrollTop = messages.scrollTop;
    const baselineScrollHeight = messages.scrollHeight;
    const samples = [];
    mutate();
    for (let frame = 0; frame < sampleFrameCount; frame += 1) {
      await waitFrames(1);
      samples.push({
        frame,
        top: position(),
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        sameNode: !anchor || messages.contains(anchor),
        horizontalOverflowPx: Math.max(0, messages.scrollWidth - messages.clientWidth),
      });
    }
    const positions = [baseline, ...samples.map(sample => sample.top)];
    const moves = positions.slice(1).map((value, index) => value - positions[index]).filter(delta => Math.abs(delta) >= 0.5);
    return {
      kind: "text-size",
      mode,
      requestedMode,
      fromSize,
      toSize,
      targetKey: anchor?.dataset.transcriptKey || "",
      baselineTop: baseline,
      baselineScrollTop,
      baselineScrollHeight,
      contentChanged: false,
      layoutChanged: samples.some(sample => sample.scrollHeight !== baselineScrollHeight),
      maxDriftPx: Math.max(0, ...samples.map(sample => Math.abs(sample.top - baseline))),
      maxViewportDriftPx: 0,
      maxHorizontalOverflowPx: Math.max(0, ...samples.map(sample => sample.horizontalOverflowPx)),
      directionReversals: moves.slice(1).filter((move, index) => Math.sign(move) !== Math.sign(moves[index])).length,
      nodeReplacements: samples.filter(sample => !sample.sameNode).length,
      samples,
    };
  }
  async function applyTextSize(messages, targetSize, mode, actions) {
    const targetIndex = textSizes.indexOf(targetSize);
    let currentIndex = textSizes.indexOf(messages.dataset.chatTextSize || "standard");
    if (targetIndex < 0 || currentIndex < 0) throw new Error(`unknown chat text size: ${targetSize}`);
    const route = [];
    if (currentIndex === targetIndex) route.push(targetIndex === textSizes.length - 1 ? targetIndex - 1 : targetIndex + 1);
    while ((route.at(-1) ?? currentIndex) !== targetIndex) {
      const index = route.at(-1) ?? currentIndex;
      route.push(index + Math.sign(targetIndex - index));
    }
    const trigger = document.querySelector("#btn-chat-text-size");
    const popover = document.querySelector("#chat-text-size-popover");
    if (!trigger || !popover) throw new Error("chat text size control is unavailable");
    if (popover.classList.contains("hidden")) trigger.click();
    for (const nextIndex of route) {
      const action = nextIndex > currentIndex ? "increase" : "decrease";
      const button = popover.querySelector(`[data-chat-text-size-action="${action}"]`);
      if (!button) throw new Error(`chat text size action is unavailable: ${action}`);
      actions.push(await measureTextSizeStep(
        messages,
        mode,
        textSizes[currentIndex],
        textSizes[nextIndex],
        () => button.click(),
      ));
      currentIndex = nextIndex;
    }
    if (!popover.classList.contains("hidden")) trigger.click();
  }
  async function measure(context, mutate) {
    const { messages, target, summary, actionIndex, kind } = context;
    if (!summary.isConnected || !messages.contains(summary)) throw new Error("Measurement target is detached before action");
    const targetKey = target.dataset.transcriptKey;
    const baseline = summary.getBoundingClientRect().top;
    const baselineViewport = messages.getBoundingClientRect().top;
    const baselineScrollTop = messages.scrollTop;
    const baselineScrollHeight = messages.scrollHeight;
    const baselineContentSignature = kind === "stream" ? streamContentSignature() : "";
    const samples = [];
    mutate();
    for (let frame = 0; frame < sampleFrameCount; frame += 1) {
      await waitFrames(1);
      const liveTarget = Array.from(messages.children).find(element => element.dataset.transcriptKey === targetKey);
      const liveSummary = liveTarget ? summaryFor(liveTarget) : null;
      samples.push({
        frame,
        top: liveSummary?.getBoundingClientRect().top ?? null,
        viewportTop: messages.getBoundingClientRect().top,
        scrollTop: messages.scrollTop,
        scrollHeight: messages.scrollHeight,
        contentSignature: kind === "stream" ? streamContentSignature() : "",
        viewportCompensation: getComputedStyle(messages).getPropertyValue("--viewport-anchor-after-space").trim(),
        sameNode: liveSummary === summary && summary.isConnected,
      });
    }
    const tops = samples.map(sample => sample.top).filter(Number.isFinite);
    const paintedTops = [baseline, ...tops];
    const moves = paintedTops.slice(1).map((top, index) => top - paintedTops[index]).filter(delta => Math.abs(delta) >= 0.5);
    let directionReversals = 0;
    for (let index = 1; index < moves.length; index += 1) {
      if (Math.sign(moves[index]) !== Math.sign(moves[index - 1])) directionReversals += 1;
    }
    return {
      kind,
      actionIndex,
      expanded: summary.getAttribute("aria-expanded") === "true",
      targetKey,
      baselineTop: baseline,
      baselineScrollTop,
      baselineScrollHeight,
      contentChanged: kind === "stream" && samples.some(sample => sample.contentSignature !== baselineContentSignature),
      layoutChanged: samples.some(sample => sample.scrollHeight !== baselineScrollHeight),
      maxDriftPx: Math.max(0, ...tops.map(top => Math.abs(top - baseline))),
      maxViewportDriftPx: Math.max(0, ...samples.map(sample => Math.abs(sample.viewportTop - baselineViewport))),
      directionReversals,
      nodeReplacements: samples.filter(sample => !sample.sameNode).length,
      samples,
    };
  }
  const random = randomFromSeed(input.seed);
  const sessionId = `viewport_fuzz_${input.caseId}`;
  const targetEntry = input.transcript[input.targetOffset];
  const result = {
    caseId: input.caseId,
    seed: input.seed,
    fixture: input.fixture,
    fixturePath: input.fixturePath,
    profile: input.profile,
    colorScheme: input.colorScheme,
    textSize: input.textSize,
    textSizeMode: input.textSizeMode,
    live: input.live,
    transcriptEntries: input.transcript.length,
    targetTool: targetEntry?.name || "",
    actions: [],
    error: "",
  };
  try {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId,
      title: `${input.fixture} ${input.caseId}`,
      transcript: input.transcript,
    });
    window.qingzhouConversationBenchmark.configureVisualState({ running: input.live });
    const messages = document.querySelector("#messages");
    // Finish setup-only transitions (e.g. artifact-card exit) before measuring user actions.
    await settleInitialLayout(messages);
    if (input.textSizeMode === "tail") {
      messages.scrollTop = messages.scrollHeight;
      messages.dispatchEvent(new WheelEvent("wheel", { deltaY: 4, bubbles: true, cancelable: true }));
      messages.dispatchEvent(new Event("scroll"));
      await waitFrames(3);
      await applyTextSize(messages, input.textSize, "tail", result.actions);
    }
    const cards = Array.from(messages.querySelectorAll(".msg-tool, .msg-tool-timeline, .msg-thinking-group"));
    let target = cards.find(card => card.__toolEntry === targetEntry)
      || cards.find(card => targetEntry?.toolCallId && card.dataset.transcriptKey?.includes(String(targetEntry.toolCallId)))
      || cards.at(-1);
    if (!target) throw new Error("fixture rendered no expandable card");
    const streamTargetKey = target.dataset.transcriptKey || "";
    target.scrollIntoView({ block: ["start", "center", "end"][Math.floor(random() * 3)] });
    messages.scrollTop = Math.max(0, Math.min(
      messages.scrollHeight - messages.clientHeight,
      messages.scrollTop + (random() - 0.5) * messages.clientHeight * 0.35,
    ));
    messages.dispatchEvent(new Event("scroll"));
    await waitFrames(3);
    if (input.textSizeMode === "history") {
      await applyTextSize(messages, input.textSize, "history", result.actions);
    }

    for (let actionIndex = 0; actionIndex < input.toggleCount; actionIndex += 1) {
      const candidates = Array.from(messages.querySelectorAll(".msg-tool, .msg-tool-timeline, .msg-thinking-group"));
      if (random() < 0.38) target = candidates[Math.floor(random() * candidates.length)] || target;
      const summary = summaryFor(target);
      if (!summary) continue;
      if (!visibleIn(summary, messages)) {
        messages.dispatchEvent(new WheelEvent("wheel", { deltaY: -4, bubbles: true, cancelable: true }));
        summary.scrollIntoView({ block: "center" });
        messages.dispatchEvent(new Event("scroll"));
        await waitFrames(2);
      }
      const action = await measure({ messages, target, summary, actionIndex, kind: "toggle" }, () => summary.click());
      result.actions.push(action);

      if (random() < 0.7) {
        const nudge = Math.round((random() - 0.5) * Math.min(120, messages.clientHeight * 0.24));
        messages.scrollTop = Math.max(0, Math.min(messages.scrollHeight - messages.clientHeight, messages.scrollTop + nudge));
        messages.dispatchEvent(new Event("scroll"));
        await waitFrames(2);
      }
    }

    if (input.live) {
      const targetCard = Array.from(messages.querySelectorAll(".msg-tool, .msg-tool-timeline")).find(card => (
        streamTargetKey && card.dataset.transcriptKey === streamTargetKey
      )) || target;
      const summary = summaryFor(targetCard);
      if (summary) {
        if (summary.getAttribute("aria-expanded") === "true") {
          summary.click();
          await waitFrames(3);
        }
        summary.scrollIntoView({ block: "center" });
        messages.dispatchEvent(new Event("scroll"));
        await waitFrames(3);
        summary.click();
        await waitFrames(12);
        // Append a new thinking span; never overwrite a historical span from the export.
        const runId = "benchmark-visual-run";
        let eventSeq = 1;
        for (let update = 1; update <= 5; update += 1) {
          const action = await measure({ messages, target: targetCard, summary, actionIndex: update, kind: "stream" }, () => {
            window.qingzhouConversationBenchmark.dispatchBackgroundEvent({
              type: "thinking_update",
              spanId: `fuzz-thinking-${input.caseId}`,
              sessionId,
              runId,
              eventSeq: eventSeq++,
              thinking: Array.from({ length: update }, (_row, line) => `fixture ${input.fixture} 流式分析 ${line + 1}`).join("\n\n"),
            });
          });
          result.actions.push(action);
        }
      }
    }
  } catch (error) {
    result.error = error?.stack || error?.message || String(error);
  }
  const actionDrifts = result.actions.map(action => action.maxDriftPx || 0);
  const interactionActions = result.actions.filter(action => action.kind !== "text-size");
  const textSizeActions = result.actions.filter(action => action.kind === "text-size");
  result.maxDriftPx = Math.max(0, ...actionDrifts);
  result.maxInteractionDriftPx = Math.max(0, ...interactionActions.map(action => action.maxDriftPx || 0));
  result.maxTextSizeDriftPx = Math.max(0, ...textSizeActions.map(action => action.maxDriftPx || 0));
  result.directionReversals = interactionActions.reduce((sum, action) => sum + (action.directionReversals || 0), 0);
  result.nodeReplacements = result.actions.reduce((sum, action) => sum + (action.nodeReplacements || 0), 0);
  result.maxHorizontalOverflowPx = Math.max(0, ...result.actions.map(action => action.maxHorizontalOverflowPx || 0));
  result.unstable = Boolean(
    result.error
    || result.maxInteractionDriftPx >= 0.5
    || result.maxTextSizeDriftPx > 2
    || result.maxHorizontalOverflowPx > 1
    || result.directionReversals
    || result.nodeReplacements
  );
  result.pinnedMotion = interactionActions.some(action => action.maxDriftPx >= 0.5 && action.baselineScrollTop > 1);
  return result;
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function buildReport(results, sources) {
  const failures = results.filter(result => result.unstable);
  const allActions = results.flatMap(result => result.actions);
  const motionActions = allActions.filter(action => action.maxDriftPx >= 0.5);
  const scrollDelta = action => {
    const values = [action.baselineScrollTop, ...action.samples.map(sample => sample.scrollTop)].filter(Number.isFinite);
    return values.length ? Math.max(...values) - Math.min(...values) : 0;
  };
  const fixtureBreakdown = Object.values(results.reduce((rows, result) => {
    const row = rows[result.fixture] ||= { fixture: result.fixture, cases: 0, motionCases: 0, pinnedMotionCases: 0, maxDriftPx: 0 };
    row.cases += 1;
    row.motionCases += result.unstable ? 1 : 0;
    row.pinnedMotionCases += result.pinnedMotion ? 1 : 0;
    row.maxDriftPx = Math.max(row.maxDriftPx, result.maxDriftPx || 0);
    return rows;
  }, {}));
  const textSizeBreakdown = chatTextSizes.map(textSize => {
    const cases = results.filter(result => result.textSize === textSize);
    return {
      textSize,
      cases: cases.length,
      tailCases: cases.filter(result => result.textSizeMode === "tail").length,
      historyCases: cases.filter(result => result.textSizeMode === "history").length,
      unstableCases: cases.filter(result => result.unstable).length,
      maxDriftPx: Math.max(0, ...cases.map(result => result.maxTextSizeDriftPx || 0)),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    methodology: {
      seeds: "0x51f15e + (repeatIndex * 60 + caseIndex) * 7919; exact seeds in cases",
      cases: results.length,
      paintedFramesPerAction,
      interactionDriftThresholdPx: 0.5,
      textSizeDriftThresholdPx: 2,
      chatTextSizes,
      syntheticHistoryTurns,
      fixtures: sources.map(source => ({ name: source.name, path: source.path, entries: source.transcript.length })),
    },
    summary: {
      executed: results.length,
      actions: allActions.length,
      toggleActions: allActions.filter(action => action.kind === "toggle").length,
      streamActions: allActions.filter(action => action.kind === "stream").length,
      textSizeActions: allActions.filter(action => action.kind === "text-size").length,
      historyTextSizeActions: allActions.filter(action => action.kind === "text-size" && action.mode === "history").length,
      historyFallbackTextSizeActions: allActions.filter(action => (
        action.kind === "text-size"
        && action.requestedMode === "history"
        && action.mode === "tail"
      )).length,
      streamActionsWithContentChange: allActions.filter(action => action.kind === "stream" && action.contentChanged).length,
      streamActionsWithLayoutChange: allActions.filter(action => action.kind === "stream" && action.layoutChanged).length,
      runtimeErrors: results.filter(result => result.error).length,
      unstableCases: failures.length,
      pinnedMotionCases: results.filter(result => result.pinnedMotion).length,
      directionReversalCases: results.filter(result => result.directionReversals > 0).length,
      nodeReplacementCases: results.filter(result => result.nodeReplacements > 0).length,
      maxDriftPx: Math.max(0, ...results.map(result => result.maxDriftPx || 0)),
      maxInteractionDriftPx: Math.max(0, ...results.map(result => result.maxInteractionDriftPx || 0)),
      maxTextSizeDriftPx: Math.max(0, ...results.map(result => result.maxTextSizeDriftPx || 0)),
      maxHorizontalOverflowPx: Math.max(0, ...results.map(result => result.maxHorizontalOverflowPx || 0)),
      motionActions: motionActions.length,
      motionActionsWithScrollClamp: motionActions.filter(action => scrollDelta(action) >= 0.5).length,
      motionActionsWithStaticScrollTop: motionActions.filter(action => scrollDelta(action) < 0.5).length,
      motionActionsAtLeast10Px: motionActions.filter(action => action.maxDriftPx >= 10).length,
      motionActionsAtLeast50Px: motionActions.filter(action => action.maxDriftPx >= 50).length,
    },
    fixtureBreakdown,
    textSizeBreakdown,
    failures,
    cases: results,
  };
}

function renderMarkdownReport(report) {
  const lines = [
    "# 轻舟 Viewport 稳定性随机压力测试",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    "## 结论",
    "",
    `- 执行案例：${report.summary.executed}`,
    `- 展开/收起操作：${report.summary.toggleActions}`,
    `- 流式更新操作：${report.summary.streamActions}`,
    `- 字号切换操作：${report.summary.textSizeActions}`,
    `- 实际历史锚点字号操作：${report.summary.historyTextSizeActions}`,
    `- 确认内容发生变化：${report.summary.streamActionsWithContentChange}`,
    `- 确认布局高度发生变化：${report.summary.streamActionsWithLayoutChange}`,
    `- 最大可见锚点漂移：${report.summary.maxDriftPx.toFixed(3)} px`,
    `- 展开/流式最大漂移：${report.summary.maxInteractionDriftPx.toFixed(3)} px`,
    `- 字号切换最大漂移：${report.summary.maxTextSizeDriftPx.toFixed(3)} px`,
    `- 最大水平溢出：${report.summary.maxHorizontalOverflowPx.toFixed(3)} px`,
    `- 方向反转案例：${report.summary.directionReversalCases}`,
    `- 节点替换案例：${report.summary.nodeReplacementCases}`,
    `- 不稳定案例：${report.summary.unstableCases}`,
    `- scrollTop > 1 时仍发生移动：${report.summary.pinnedMotionCases}`,
    `- 运行错误：${report.summary.runtimeErrors}`,
    `- 发生位移的操作：${report.summary.motionActions}（scrollTop 同步变化 ${report.summary.motionActionsWithScrollClamp}，scrollTop 不变 ${report.summary.motionActionsWithStaticScrollTop}）`,
    `- 位移 ≥10px：${report.summary.motionActionsAtLeast10Px}；位移 ≥50px：${report.summary.motionActionsAtLeast50Px}`,
    "",
    report.summary.unstableCases
      ? "测试检测到肉眼可见的抽动。常见轨迹包括收起后 scrollTop 被钳制，以及 scrollTop 不变但异步布局使标题跳动。"
      : "本轮没有检测到可见抽动：展开/流式操作低于 0.5px，字号切换不超过 2px，且没有方向反转或节点替换。",
    "",
    "## 方法",
    "",
    `使用 ${report.methodology.fixtures.length} 个已入库 fixture，按固定种子生成 ${report.methodology.cases} 个可复现案例。每次操作后采样 ${report.methodology.paintedFramesPerAction} 个 animation frame；展开/流式锚点达到 ${report.methodology.interactionDriftThresholdPx}px、字号切换超过 ${report.methodology.textSizeDriftThresholdPx}px、发生非字号方向反转或节点替换即判失败。`,
    `每个案例前置 ${report.methodology.syntheticHistoryTurns} 轮明确标注的合成历史，让工具收起时仍有可滚动内容；不依赖私有会话导出。`,
    "",
    "视口覆盖：360×640、430×844、560×760；六档对话字号分别覆盖历史锚点与尾随底部。每个案例随机选择 fixture 工具位置、截取窗口、初始滚动位置、滚动扰动、目标卡片及 3–7 次展开/收起；半数案例追加 5 轮 think 流式增长。",
    "",
    "## Fixture",
    "",
    "| Fixture | Transcript 条目 | 路径 |",
    "| --- | ---: | --- |",
    ...report.methodology.fixtures.map(item => `| ${item.name} | ${item.entries} | \`${item.path}\` |`),
    "",
    "## Fixture 结果",
    "",
    "| Fixture | 案例 | 位移案例 | 非顶部位移 | 最大漂移(px) |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.fixtureBreakdown.map(item => `| ${item.fixture} | ${item.cases} | ${item.motionCases} | ${item.pinnedMotionCases} | ${item.maxDriftPx.toFixed(3)} |`),
    "",
    "## 字号结果",
    "",
    "| 字号 | 案例 | 尾随 | 历史锚点 | 不稳定 | 最大漂移(px) |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.textSizeBreakdown.map(item => `| ${item.textSize} | ${item.cases} | ${item.tailCases} | ${item.historyCases} | ${item.unstableCases} | ${item.maxDriftPx.toFixed(3)} |`),
    "",
    "## 失败案例",
    "",
    report.failures.length ? "详见 report.json 中 failures 的逐帧轨迹。" : "无。",
    "",
    "## 全部案例",
    "",
    "| Case | Seed | Fixture | Viewport | 字号 | 锚定 | 模式 | 操作 | 最大漂移(px) | 反转 | 替换 | 结果 |",
    "| --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...report.cases.map(item => `| ${item.caseId} | ${item.seed} | ${item.fixture} | ${item.profile.width}×${item.profile.height} | ${item.textSize} | ${item.textSizeMode} | ${item.live ? "交互+流式" : "交互"} | ${item.actions.length} | ${(item.maxDriftPx || 0).toFixed(3)} | ${item.directionReversals} | ${item.nodeReplacements} | ${item.unstable ? "失败" : "通过"} |`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
