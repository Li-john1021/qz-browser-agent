export function installConversationBenchmark(host, globalObject = globalThis) {
  if (!host || typeof host !== "object") throw new Error("conversation benchmark host is required");
  if (globalObject.qingzhouConversationBenchmark) return globalObject.qingzhouConversationBenchmark;

  const api = {
    reset,
    seedSession: host.seedSession,
    switchToSession: host.switchToSession,
    runLiveReplay,
    runToolPresentationStateRegression,
    runSessionSwitch,
    runSnapshotRender,
    collectMetrics,
    collectViewportAnchorState: host.collectViewportAnchorState,
    configureVisualState: host.configureVisualState,
    dispatchBackgroundEvent: host.dispatchBackgroundEvent,
    exportSessionDocument: host.exportSessionDocument,
    renderSessionDocument: host.renderSessionDocument,
  };
  globalObject.qingzhouConversationBenchmark = api;
  globalObject.dispatchEvent?.(new CustomEvent("qingzhou-conversation-benchmark-ready"));
  return api;

  async function reset(options = {}) {
    await host.reset(options);
    return collectMetrics();
  }

  async function runSessionSwitch(fixture = {}, options = {}) {
    await host.reset({ debug: options.debug !== false, clearStorage: options.clearStorage !== false });
    const { sessionId } = await host.seedSession(fixture);
    resetLongTasks();
    const startedAt = host.perfNow();
    await host.switchToSession(sessionId, { source: "benchmark" });
    await host.settleFrame();
    return collectMetrics({
      benchmark: "session-switch",
      elapsedMs: host.perfNow() - startedAt,
    });
  }

  async function runSnapshotRender(fixture = {}, options = {}) {
    await host.reset({ debug: options.debug !== false, clearStorage: options.clearStorage !== false });
    const { sessionId } = await host.seedSession(fixture);
    host.setCurrentSessionId(sessionId);
    host.resetUI();
    host.setSessionTranscript(sessionId, Array.isArray(fixture.transcript) ? fixture.transcript : []);
    resetLongTasks();
    const startedAt = host.perfNow();
    host.renderCurrentTranscript();
    await host.settleFrame();
    return collectMetrics({
      benchmark: "snapshot-render",
      elapsedMs: host.perfNow() - startedAt,
    });
  }

  async function runLiveReplay(fixture = {}, options = {}) {
    await host.reset({ debug: options.debug !== false, clearStorage: options.clearStorage !== false });
    const { sessionId } = await host.seedSession(fixture);
    const baseTranscript = Array.isArray(fixture.baseTranscript)
      ? fixture.baseTranscript
      : (Array.isArray(fixture.transcript) ? fixture.transcript : []);
    const events = Array.isArray(fixture.events) ? fixture.events : [];
    host.setCurrentSessionId(sessionId);
    host.resetUI();
    host.setSessionTranscript(sessionId, baseTranscript);
    host.renderCurrentTranscript();
    const runId = String(options.runId || events.find(event => event?.runId)?.runId || "benchmark-live-run");
    host.startRun(runId, { sessionId, requireConversation: false });

    resetLongTasks();
    const eventDispatchDurations = [];
    const interactionProbe = startInteractionProbe(options);
    const playbackProbe = startPlaybackProbe();
    const visualStabilityProbe = startVisualStabilityProbe(options);
    const expandTimelines = options.expandToolTimelines === true;
    const expandEveryEvents = Math.max(
      1,
      Math.round(Number(options.expandToolTimelineEveryEvents) || Number(options.yieldEveryEvents) || 25),
    );
    const expandedTimelineStats = {
      attempts: 0,
      changed: 0,
      expanded: 0,
      maxExpanded: 0,
      last: null,
    };
    let firstUpdateElapsedMs = null;
    let lastEventAtMs = 0;
    const startedAt = host.perfNow();
    const yieldEveryEvents = Math.max(0, Math.round(Number(options.yieldEveryEvents) || 0));
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (options.timed === true) {
        const targetAtMs = Number.isFinite(Number(event.atMs)) ? Math.max(0, Number(event.atMs)) : lastEventAtMs;
        const waitMs = Math.max(0, targetAtMs - lastEventAtMs) * clampNumber(options.paceScale, 0, 10, 1);
        lastEventAtMs = targetAtMs;
        if (waitMs > 0) await waitMsDelay(waitMs);
      } else if (Number(options.eventDelayMs) > 0) {
        await waitMsDelay(Number(options.eventDelayMs));
      }
      const eventStartedAt = host.perfNow();
      const nextEvent = { ...event, sessionId, runId: event.runId || runId };
      const changed = host.recordSessionTranscriptEvent(nextEvent);
      if (changed || options.renderUnchanged === true) {
        host.scheduleTranscriptCacheRender(sessionId, { delay: 0 });
      }
      if (
        expandTimelines
        && (changed || options.renderUnchanged === true)
        && ((index + 1) % expandEveryEvents === 0 || index === events.length - 1)
      ) {
        recordExpandedTimelineStats(expandedTimelineStats, expandToolTimelines(options));
      }
      if (firstUpdateElapsedMs == null && event.type === "message_update") {
        firstUpdateElapsedMs = host.perfNow() - startedAt;
      }
      eventDispatchDurations.push(host.perfNow() - eventStartedAt);
      if (options.framePerEvent === true || (yieldEveryEvents > 0 && (index + 1) % yieldEveryEvents === 0)) {
        await host.settleFrame();
      }
    }
    await host.settleFrame();
    if (expandTimelines) {
      recordExpandedTimelineStats(expandedTimelineStats, expandToolTimelines(options));
      await host.settleFrame();
    }
    if (options.finishRun === true) host.finishRun();
    const replayElapsedMs = host.perfNow() - startedAt;
    const playbackSettleStartedAt = host.perfNow();
    const playbackSettle = await settleAssistantPlayback();
    playbackSettle.elapsedMs = host.perfNow() - playbackSettleStartedAt;
    const playbackConcurrency = playbackProbe.stop();
    const interaction = interactionProbe.stop();
    const visualStability = visualStabilityProbe.stop();
    const metrics = collectMetrics({
      benchmark: "live-replay",
      elapsedMs: replayElapsedMs,
      totalElapsedMs: host.perfNow() - startedAt,
      eventCount: events.length,
      firstUpdateElapsedMs,
    });
    metrics.eventDispatchDurations = summarizeDurations(eventDispatchDurations);
    metrics.stream = collectStreamMetrics({
      expectedText: fixture.expectedText || fixture.stream?.expectedText || "",
      expectedTranscriptDigest: fixture.expectedTranscriptDigest || fixture.expectedTranscript?.digest || "",
      eventCount: events.length,
      startedAt,
    });
    metrics.renderDurations = metrics.stream.renderDurations;
    metrics.interaction = interaction;
    if (visualStability) metrics.visualStability = visualStability;
    if (expandTimelines) metrics.expandedToolTimelines = expandedTimelineStats;
    metrics.playbackSettle = playbackSettle;
    metrics.playbackConcurrency = playbackConcurrency;
    return metrics;
  }

  async function runToolPresentationStateRegression() {
    const scenarios = [];
    scenarios.push(await runToolPresentationScenario("expand-to-timeline", async flow => {
      await flow.start("tool-1", "open_tab");
      const initial = readToolPresentationDom();
      await clickToolPresentationSummary();
      const expandedSingle = readToolPresentationDom();
      await flow.end("tool-1", "open_tab");
      await flow.start("tool-2", "read_page");
      const grouped = readToolPresentationDom();
      return {
        ok: initial.kind === "tool"
          && expandedSingle.expanded
          && grouped.kind === "tool-group"
          && grouped.userToggled
          && grouped.expanded
          && grouped.activeToolKey === initial.activeToolKey,
        initial,
        expandedSingle,
        grouped,
      };
    }));

    scenarios.push(await runToolPresentationScenario("collapse-to-timeline", async flow => {
      await flow.start("tool-1", "open_tab");
      await clickToolPresentationSummary();
      await clickToolPresentationSummary();
      const collapsedSingle = readToolPresentationDom();
      await flow.end("tool-1", "open_tab");
      await flow.start("tool-2", "read_page");
      const grouped = readToolPresentationDom();
      return {
        ok: collapsedSingle.userToggled
          && !collapsedSingle.expanded
          && grouped.kind === "tool-group"
          && grouped.userToggled
          && !grouped.expanded,
        collapsedSingle,
        grouped,
      };
    }));

    scenarios.push(await runToolPresentationScenario("family-batch-upgrade", async flow => {
      await flow.start("tool-1", "open_tab");
      await flow.end("tool-1", "open_tab");
      await flow.start("tool-2", "read_page");
      await flow.end("tool-2", "read_page");
      await flow.start("tool-3", "run_script");
      await clickToolPresentationSummary();
      await clickToolTimelineIndex(1);
      const selected = readToolPresentationDom();
      const names = ["open_tab", "read_page", "run_script", "data_store"];
      for (let index = 4; index <= 13; index += 1) {
        await flow.end(`tool-${index - 1}`, names[(index - 2) % names.length]);
        await flow.start(`tool-${index}`, names[(index - 1) % names.length]);
      }
      const upgraded = readToolPresentationDom();
      upgraded.familyBatchCount = host.getMessagesElement().querySelectorAll(".tool-family-batch").length;
      return {
        ok: selected.expanded
          && upgraded.kind === "tool-group"
          && upgraded.mode === "family"
          && upgraded.familyBatchCount > 0
          && upgraded.expanded
          && upgraded.activeToolKey === selected.activeToolKey,
        selected,
        upgraded,
      };
    }));

    scenarios.push(await runToolPresentationScenario("component-rebuild", async flow => {
      await flow.start("tool-1", "open_tab");
      await flow.end("tool-1", "open_tab");
      await flow.start("tool-2", "read_page");
      await clickToolPresentationSummary();
      await clickToolTimelineIndex(0);
      const before = readToolPresentationDom();
      const previousCard = currentToolPresentationCard();
      host.resetUI();
      host.renderCurrentTranscript();
      await host.settleFrame();
      await host.settleFrame();
      const after = readToolPresentationDom();
      return {
        ok: before.expanded
          && after.kind === "tool-group"
          && after.userToggled
          && after.expanded
          && after.activeToolKey === before.activeToolKey
          && currentToolPresentationCard() !== previousCard,
        rebuilt: currentToolPresentationCard() !== previousCard,
        before,
        after,
      };
    }));

    const failed = scenarios.filter(scenario => !scenario.ok);
    if (failed.length) {
      throw new Error(`Tool presentation streaming regression failed: ${JSON.stringify(failed)}`);
    }
    return collectMetrics({
      benchmark: "tool-presentation-streaming",
      ok: true,
      scenarios,
    });
  }

  async function runToolPresentationScenario(name, execute) {
    await host.reset({ debug: true, clearStorage: false });
    const sessionId = `tool-presentation-${name}`;
    const runId = `run-${name}`;
    await host.seedSession({ sessionId, title: name, transcript: [] });
    host.setCurrentSessionId(sessionId);
    host.resetUI();
    host.setSessionTranscript(sessionId, []);
    host.renderCurrentTranscript();
    host.startRun(runId, { sessionId, requireConversation: false });
    let eventSeq = 0;

    const dispatch = async event => {
      eventSeq += 1;
      const changed = host.recordSessionTranscriptEvent({
        ...event,
        sessionId,
        runId,
        eventSeq,
      });
      if (changed) host.scheduleTranscriptCacheRender(sessionId, { delay: 0 });
      await host.settleFrame();
      await host.settleFrame();
    };
    const flow = {
      start: (toolCallId, toolName) => dispatch({
        type: "tool_execution_start",
        toolCallId,
        spanId: `span-${toolCallId}`,
        toolName,
        args: { target: `https://example.com/${toolCallId}` },
      }),
      end: (toolCallId, toolName) => dispatch({
        type: "tool_execution_end",
        toolCallId,
        spanId: `span-${toolCallId}`,
        toolName,
        args: { target: `https://example.com/${toolCallId}` },
        result: { ok: true, toolCallId },
        isError: false,
      }),
    };
    const result = await execute(flow);
    host.finishRun();
    return { name, ...result };
  }

  async function clickToolPresentationSummary() {
    const summary = currentToolPresentationCard()?.querySelector(":scope > .tool-summary");
    if (!summary) throw new Error("Tool presentation summary is missing");
    summary.click();
    await host.settleFrame();
    await host.settleFrame();
  }

  async function clickToolTimelineIndex(index) {
    const selector = `.tool-timeline-step[data-tool-timeline-index="${Number(index)}"], .tool-family-row[data-tool-timeline-index="${Number(index)}"], .tool-family-batch[data-tool-timeline-index="${Number(index)}"]`;
    const target = currentToolPresentationCard()?.querySelector(selector);
    if (!target) throw new Error(`Tool timeline index ${index} is missing`);
    target.click();
    await host.settleFrame();
    await host.settleFrame();
  }

  function currentToolPresentationCard() {
    const cards = host.getMessagesElement().querySelectorAll(".msg-tool[data-transcript-type='tool'], .msg-tool-timeline[data-transcript-type='tool-group']");
    return cards[cards.length - 1] || null;
  }

  function readToolPresentationDom() {
    const card = currentToolPresentationCard();
    const summary = card?.querySelector(":scope > .tool-summary");
    const details = card?.querySelector(":scope > .tool-details");
    return {
      kind: card?.dataset.transcriptType || "",
      userToggled: details?.dataset.userToggled === "true",
      expanded: summary?.getAttribute("aria-expanded") === "true" && !details?.classList.contains("hidden"),
      activeToolKey: details?.dataset.activeToolKey || card?.dataset.activeToolKey || card?.dataset.transcriptKey || "",
      mode: details?.dataset.timelineMode || "single",
    };
  }

  function startPlaybackProbe() {
    let stopped = false;
    let frame = 0;
    let samples = 0;
    let maxActive = 0;
    let overlapSamples = 0;
    const sample = () => {
      const active = countActiveAssistantPlayback();
      samples += 1;
      maxActive = Math.max(maxActive, active);
      if (active > 1) overlapSamples += 1;
    };
    const tick = () => {
      if (stopped) return;
      sample();
      frame = requestAnimationFrame(tick);
    };
    sample();
    frame = requestAnimationFrame(tick);
    return {
      stop() {
        if (!stopped) {
          stopped = true;
          cancelAnimationFrame(frame);
          sample();
        }
        return { samples, maxActive, overlapSamples };
      },
    };
  }

  function startVisualStabilityProbe(options = {}) {
    if (options.visualStabilityProbe !== true) return { stop: () => null };
    const root = host.getMessagesElement();
    if (!root) return { stop: () => null };

    const startedAt = host.perfNow();
    const nodeState = new WeakMap();
    const latestNodeByKey = new Map();
    const animationNames = {};
    const hostAnimationSamples = [];
    const replacementSamples = [];
    const layoutShiftSamples = [];
    let nodeSequence = 0;
    let directAdded = 0;
    let directRemoved = 0;
    let reinserted = 0;
    let replacedKeys = 0;
    let hostAnimationStarts = 0;
    let repeatedHostAnimationStarts = 0;
    let agedHostAnimationStarts = 0;
    let descendantAnimationStarts = 0;
    let frames = 0;
    let framesWithHostMotion = 0;
    let framesWithAgedHostMotion = 0;
    let maxConcurrentHostAnimations = 0;
    let maxConcurrentAgedHostAnimations = 0;
    let layoutShiftCount = 0;
    let layoutShiftValue = 0;
    let maxLayoutShift = 0;
    const frameIntervals = [];
    const slowFrameSamples = [];
    let firstFrame = null;
    let previousRafTimestamp = null;
    let longFrameCount = 0;
    let severeFrameCount = 0;
    let lastFrameAt = host.perfNow();
    let frame = 0;

    const messageKey = node => String(node?.dataset?.transcriptKey || "").trim();
    const elapsed = () => Math.max(0, host.perfNow() - startedAt);
    const pushSample = (rows, value, limit = 40) => {
      if (rows.length < limit) rows.push(value);
    };
    const registerMessage = (node, source = "frame") => {
      if (!(node instanceof Element) || !node.matches(".msg")) return null;
      let state = nodeState.get(node);
      if (!state) {
        state = {
          id: ++nodeSequence,
          key: "",
          firstSeenAt: host.perfNow(),
          hostAnimationStarts: 0,
          removed: false,
        };
        nodeState.set(node, state);
      } else if (state.removed && source === "added") {
        state.removed = false;
        reinserted += 1;
      }
      const key = messageKey(node);
      if (key && key !== state.key) {
        const previous = latestNodeByKey.get(key);
        if (previous && previous !== node) {
          replacedKeys += 1;
          pushSample(replacementSamples, {
            atMs: elapsed(),
            key,
            previousNodeId: nodeState.get(previous)?.id || 0,
            nextNodeId: state.id,
          });
        }
        latestNodeByKey.set(key, node);
        state.key = key;
      }
      return state;
    };

    for (const node of root.querySelectorAll(":scope > .msg")) registerMessage(node, "initial");

    const mutationObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof Element) || !node.matches(".msg")) continue;
          directRemoved += 1;
          const state = registerMessage(node, "removed");
          if (state) state.removed = true;
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element) || !node.matches(".msg")) continue;
          directAdded += 1;
          registerMessage(node, "added");
        }
      }
    });
    mutationObserver.observe(root, { childList: true });

    const handleAnimationStart = event => {
      const target = event.target instanceof Element ? event.target : null;
      const message = target?.closest?.(".msg");
      if (!message || !root.contains(message)) return;
      const state = registerMessage(message, "animation");
      const animationName = String(event.animationName || "unknown");
      animationNames[animationName] = (animationNames[animationName] || 0) + 1;
      if (target !== message) {
        descendantAnimationStarts += 1;
        return;
      }
      const ageMs = Math.max(0, host.perfNow() - state.firstSeenAt);
      const repeated = state.hostAnimationStarts > 0;
      state.hostAnimationStarts += 1;
      hostAnimationStarts += 1;
      if (repeated) repeatedHostAnimationStarts += 1;
      if (ageMs > 250) agedHostAnimationStarts += 1;
      pushSample(hostAnimationSamples, {
        atMs: elapsed(),
        nodeId: state.id,
        key: state.key || messageKey(message),
        type: message.dataset.transcriptType || "",
        animationName,
        ageMs,
        repeated,
      });
    };
    root.addEventListener("animationstart", handleAnimationStart, { capture: true });

    let layoutShiftObserver = null;
    if (
      typeof PerformanceObserver === "function"
      && PerformanceObserver.supportedEntryTypes?.includes?.("layout-shift")
    ) {
      layoutShiftObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          const value = Number(entry.value) || 0;
          layoutShiftCount += 1;
          layoutShiftValue += value;
          maxLayoutShift = Math.max(maxLayoutShift, value);
          pushSample(layoutShiftSamples, { atMs: elapsed(), value }, 24);
        }
      });
      layoutShiftObserver.observe({ type: "layout-shift", buffered: false });
    }

    const sampleFrame = rafTimestamp => {
      frames += 1;
      const now = host.perfNow();
      const frameInterval = Math.max(0, now - lastFrameAt);
      if (frames === 1 || frameInterval > 50) {
        const sample = {
          frame: frames,
          atMs: now - startedAt,
          intervalMs: frameInterval,
          performanceNow: now,
          rafTimestamp,
          rafIntervalMs: previousRafTimestamp == null ? null : rafTimestamp - previousRafTimestamp,
          visibility: root.ownerDocument.visibilityState,
          focused: root.ownerDocument.hasFocus(),
        };
        if (frames === 1) firstFrame = sample;
        if (frameInterval > 50) pushSample(slowFrameSamples, sample, 12);
      }
      previousRafTimestamp = rafTimestamp;
      lastFrameAt = now;
      frameIntervals.push(frameInterval);
      if (frameInterval > 32) longFrameCount += 1;
      if (frameInterval > 50) severeFrameCount += 1;
      for (const node of root.querySelectorAll(":scope > .msg")) registerMessage(node, "frame");
      const hostAnimations = typeof root.getAnimations === "function"
        ? root.getAnimations({ subtree: true }).filter(animation => {
          const target = animation.effect?.target;
          return animation.playState === "running" && target instanceof Element && target.matches(".msg");
        })
        : [];
      const agedAnimations = hostAnimations.filter(animation => {
        const state = nodeState.get(animation.effect?.target);
        return state && now - state.firstSeenAt > 250;
      });
      if (hostAnimations.length) framesWithHostMotion += 1;
      if (agedAnimations.length) framesWithAgedHostMotion += 1;
      maxConcurrentHostAnimations = Math.max(maxConcurrentHostAnimations, hostAnimations.length);
      maxConcurrentAgedHostAnimations = Math.max(maxConcurrentAgedHostAnimations, agedAnimations.length);
      frame = requestAnimationFrame(sampleFrame);
    };
    frame = requestAnimationFrame(sampleFrame);

    return {
      stop() {
        cancelAnimationFrame(frame);
        mutationObserver.disconnect();
        layoutShiftObserver?.disconnect();
        root.removeEventListener("animationstart", handleAnimationStart, { capture: true });
        return {
          elapsedMs: elapsed(),
          observedNodes: nodeSequence,
          directAdded,
          directRemoved,
          reinserted,
          replacedKeys,
          hostAnimationStarts,
          repeatedHostAnimationStarts,
          agedHostAnimationStarts,
          descendantAnimationStarts,
          animationNames,
          frames,
          framesWithHostMotion,
          framesWithAgedHostMotion,
          maxConcurrentHostAnimations,
          maxConcurrentAgedHostAnimations,
          frameInterval: summarizeDurations(frameIntervals),
          firstFrame,
          slowFrameSamples,
          longFrameCount,
          severeFrameCount,
          layoutShiftCount,
          layoutShiftValue,
          maxLayoutShift,
          hostAnimationSamples,
          replacementSamples,
          layoutShiftSamples,
        };
      },
    };
  }

  function countActiveAssistantPlayback() {
    return Array.from(host.getMessagesElement().querySelectorAll(".msg-assistant"))
      .filter(element => host.hasAssistantPlaybackState(element))
      .length;
  }

  function startInteractionProbe(options = {}) {
    if (options.interactionProbe === false) return { stop: () => null };
    const intervalMs = clampNumber(options.interactionProbeIntervalMs, 8, 1000, 24);
    const eventLoopDelays = [];
    const inputHandlerDurations = [];
    const scrollHandlerDurations = [];
    let stopped = false;
    let timer = 0;
    let expectedAt = host.perfNow();
    const sample = () => {
      if (stopped) return;
      const startedAt = host.perfNow();
      eventLoopDelays.push(Math.max(0, startedAt - expectedAt));
      const inputStartedAt = host.perfNow();
      host.getInputElement()?.dispatchEvent(new Event("input", { bubbles: true }));
      inputHandlerDurations.push(host.perfNow() - inputStartedAt);
      const scrollStartedAt = host.perfNow();
      host.getMessagesElement().dispatchEvent(new Event("scroll"));
      scrollHandlerDurations.push(host.perfNow() - scrollStartedAt);
      expectedAt = host.perfNow() + intervalMs;
      timer = setTimeout(sample, intervalMs);
    };
    timer = setTimeout(sample, 0);
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
        return {
          samples: eventLoopDelays.length,
          eventLoopDelay: summarizeDurations(eventLoopDelays),
          inputHandler: summarizeDurations(inputHandlerDurations),
          scrollHandler: summarizeDurations(scrollHandlerDurations),
        };
      },
    };
  }

  function resetLongTasks() {
    if (Array.isArray(globalObject.__qzBenchLongTasks)) globalObject.__qzBenchLongTasks.length = 0;
  }

  function expandToolTimelines(options = {}) {
    const limit = Math.max(1, Math.round(Number(options.expandToolTimelineLimit) || 4));
    const groups = Array.from(host.getMessagesElement().querySelectorAll(".msg-tool-timeline"));
    const candidates = groups
      .map((element, index) => {
        const tools = host.timelineGroupTools(element.__toolTimelineGroupEntry);
        return {
          element,
          index,
          tools,
          expanded: element.classList.contains("tool-timeline-expanded")
            && element.querySelector(":scope > .tool-timeline-summary")?.getAttribute("aria-expanded") === "true",
          score: toolTimelineScore(element, tools),
        };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
    let expanded = candidates.filter(item => item.expanded).length;
    let changed = false;
    const touched = [];
    for (const item of candidates) {
      if (expanded >= limit) break;
      if (item.expanded) continue;
      const summary = item.element.querySelector(":scope > .tool-timeline-summary");
      if (!summary) continue;
      summary.click();
      changed = true;
      expanded += 1;
      touched.push({
        index: item.index,
        score: item.score,
        steps: item.tools.length,
        title: summary.textContent?.trim().slice(0, 80) || "",
      });
    }
    return normalizeNumbers({
      total: groups.length,
      expanded,
      limit,
      changed,
      touched,
      top: candidates.slice(0, limit).map(item => ({
        index: item.index,
        score: item.score,
        expanded: item.expanded || touched.some(row => row.index === item.index),
        steps: item.tools.length,
        title: item.element.querySelector(":scope > .tool-timeline-summary")?.textContent?.trim().slice(0, 80) || "",
      })),
    });
  }

  function collectMetrics(extra = {}) {
    const id = host.normalizeSessionId(host.getCurrentSessionId());
    const transcript = host.getCurrentTranscript();
    const visible = id ? host.projectTranscript(transcript, { sessionId: id }) : [];
    const root = host.getMessagesElement();
    return normalizeNumbers({
      ...extra,
      sessionId: id || "",
      runStatus: host.getRunStatus(),
      transcriptCount: transcript.length,
      visibleCount: visible.length,
      partial: id ? host.hasPartialTranscript(id) : false,
      dom: {
        nodes: root.querySelectorAll("*").length,
        messages: root.querySelectorAll(".msg").length,
        toolCards: root.querySelectorAll(".msg-tool").length,
        toolTimelineGroups: root.querySelectorAll(".msg-tool-timeline").length,
        toolDetails: root.querySelectorAll(".tool-details").length,
        hiddenToolDetails: root.querySelectorAll(".tool-details.hidden").length,
        rawPanels: root.querySelectorAll(".tool-timeline-raw-panel, .tool-raw-details").length,
        rawLazySources: root.querySelectorAll(".tool-raw-lazy-source").length,
        jsonBlocks: root.querySelectorAll(".json-block").length,
        pre: root.querySelectorAll("pre").length,
        spans: root.querySelectorAll("span").length,
        textChars: root.textContent?.length || 0,
      },
      perfTrace: host.getPerfTraceBuffer().slice(),
    });
  }

  async function settleAssistantPlayback({ maxFrames = 600 } = {}) {
    let frames = 0;
    let pending = countPendingAssistantPlayback();
    while (pending > 0 && frames < maxFrames) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      frames += 1;
      pending = countPendingAssistantPlayback();
    }
    await host.settleFrame();
    return { settled: pending === 0, frames, pending };
  }

  function countPendingAssistantPlayback() {
    return Array.from(host.getMessagesElement().querySelectorAll(".msg-assistant[data-final-content]"))
      .filter(element => (element.dataset.content || "") !== (element.dataset.finalContent || ""))
      .length;
  }

  function collectStreamMetrics({ expectedText = "", expectedTranscriptDigest = "", eventCount = 0, startedAt = 0 } = {}) {
    const transcript = host.getCurrentTranscript();
    const assistantEntries = transcript.filter(entry => entry?.type === "assistant");
    const finalAssistant = assistantEntries[assistantEntries.length - 1] || null;
    const finalText = String(finalAssistant?.content || "");
    const expected = String(expectedText || "");
    const transcriptDigest = digestTranscript(transcript);
    const expectedDigest = String(expectedTranscriptDigest || "");
    const trace = host.getPerfTraceBuffer().slice();
    const livePatch = summarizeLivePatch(trace);
    const renderTrace = trace.filter(entry => entry?.name === "chat.renderTranscript");
    const reconcileTrace = trace.filter(entry => entry?.name === "chat.renderTranscript.reconcile");
    const updateEvents = Number(eventCount) > 0 ? Math.max(0, Number(eventCount) - 2) : 0;
    return normalizeNumbers({
      eventCount,
      updateEvents,
      assistantMessages: assistantEntries.length,
      finalTextChars: finalText.length,
      expectedTextChars: expected.length,
      finalTextHash: host.hashText(finalText),
      expectedTextHash: host.hashText(expected),
      finalTextMatches: expected ? finalText === expected : null,
      transcriptDigest,
      expectedTranscriptDigest: expectedDigest,
      transcriptMatches: expectedDigest ? transcriptDigest.digest === expectedDigest : null,
      charsPerSecond: finalText.length && startedAt
        ? finalText.length / Math.max(0.001, (host.perfNow() - startedAt) / 1000)
        : 0,
      renderCalls: renderTrace.length,
      renderPerEvent: eventCount ? renderTrace.length / eventCount : 0,
      fullReconcileDuringLive: reconcileTrace.length,
      renderDurations: summarizeDurations(renderTrace.map(entry => Number(entry.ms) || 0)),
      livePatch,
    });
  }

  function digestTranscript(transcript = []) {
    const entries = (Array.isArray(transcript) ? transcript : [])
      .filter(entry => ["user", "assistant", "thinking", "tool"].includes(entry?.type))
      .map(entry => {
        if (entry.type === "user") {
          return {
            type: "user",
            textHash: host.hashText(entry.text || ""),
            images: Array.isArray(entry.images) ? entry.images.length : 0,
          };
        }
        if (entry.type === "assistant") {
          return {
            type: "assistant",
            contentHash: host.hashText(entry.content || ""),
            contentChars: String(entry.content || "").length,
          };
        }
        if (entry.type === "thinking") {
          return {
            type: "thinking",
            textHash: host.hashText(entry.text || ""),
            textChars: String(entry.text || "").length,
          };
        }
        return {
          type: "tool",
          name: entry.name || "tool",
          argsHash: host.hashText(stableJson(entry.args ?? {})),
          resultHash: host.hashText(stableJson(entry.result ?? null)),
          isError: entry.isError === true,
        };
      });
    return {
      digest: host.hashText(stableJson(entries)),
      count: entries.length,
      roles: entries.reduce((accumulator, entry) => {
        accumulator[entry.type] = (accumulator[entry.type] || 0) + 1;
        return accumulator;
      }, {}),
    };
  }

  function summarizeLivePatch(trace = []) {
    const items = (Array.isArray(trace) ? trace : []).filter(entry => entry?.name === "chat.livePatchTail");
    const successes = items.filter(entry => entry?.meta?.patched === true);
    const expectedFallbackReasons = new Set(["no-live-entry", "no-existing-dom", "projection-mismatch"]);
    const skipped = items.filter(entry => entry?.meta?.patched !== true && expectedFallbackReasons.has(entry?.meta?.fallbackReason));
    const failures = items.filter(entry => entry?.meta?.patched !== true && !expectedFallbackReasons.has(entry?.meta?.fallbackReason));
    const fallbackReasons = {};
    for (const item of items.filter(entry => entry?.meta?.patched !== true)) {
      const reason = item?.meta?.fallbackReason || "unknown";
      fallbackReasons[reason] = (fallbackReasons[reason] || 0) + 1;
    }
    const actionable = successes.length + failures.length;
    return normalizeNumbers({
      attempts: items.length,
      success: successes.length,
      skipped: skipped.length,
      fallback: failures.length,
      successRate: actionable ? successes.length / actionable : 0,
      fallbackReasons,
      durations: summarizeDurations(items.map(entry => Number(entry.ms) || 0)),
      touched: items.reduce((sum, entry) => sum + (Number(entry?.meta?.touched) || 0), 0),
      moved: items.reduce((sum, entry) => sum + (Number(entry?.meta?.moved) || 0), 0),
      maxPatchStart: items.reduce((max, entry) => Math.max(max, Number(entry?.meta?.patchStart) || 0), 0),
    });
  }
}

function recordExpandedTimelineStats(stats, expanded) {
  stats.attempts += 1;
  if (expanded.changed) stats.changed += 1;
  stats.expanded = expanded.expanded;
  stats.maxExpanded = Math.max(stats.maxExpanded, expanded.expanded);
  stats.last = expanded;
}

function toolTimelineScore(element, tools = []) {
  const steps = Array.isArray(tools) ? tools.length : 0;
  const payloadChars = (Array.isArray(tools) ? tools : []).reduce((sum, tool) => (
    sum + valueSize(tool?.args) + valueSize(tool?.result) + String(tool?.argsText || tool?.rawArgsText || "").length
  ), 0);
  return payloadChars + steps * 5000 + String(element?.textContent || "").length;
}

function valueSize(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try { return JSON.stringify(value).length; }
  catch (_error) { return String(value).length; }
}

function summarizeDurations(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  const sum = sorted.reduce((total, value) => total + value, 0);
  return normalizeNumbers({
    count: sorted.length,
    totalMs: sum,
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function waitMsDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function percentile(sorted, ratio) {
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] || 0;
}

function normalizeNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeNumbers(item)]));
}
