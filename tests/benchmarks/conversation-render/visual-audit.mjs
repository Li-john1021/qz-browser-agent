import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_ACTIONS = 64;
const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_SETTLE_MS = 240;
const CONTROL_TARGET_ATTR = "data-qz-visual-audit-target";

const ROOTS = Object.freeze([
  { id: "conversation", setup: "conversation" },
  { id: "expanded", setup: "expanded" },
  { id: "search", setup: "search" },
  { id: "composer", setup: "composer" },
  { id: "running", setup: "running" },
  { id: "queued", setup: "queued" },
  { id: "welcome", setup: "welcome" },
]);

export async function runConversationVisualAudit(page, fixture, options = {}) {
  const artifactDir = String(options.artifactDir || "");
  const viewport = options.viewport || { width: 430, height: 900 };
  const maxActions = positiveInteger(options.maxActions, DEFAULT_MAX_ACTIONS);
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  const settleMs = positiveInteger(options.settleMs, DEFAULT_SETTLE_MS);
  const screenshotDir = artifactDir ? join(artifactDir, "interactions") : "";
  if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });

  await installVisualAuditRuntime(page);
  let activeAction = "";
  const runtimeErrors = [];
  const onPageError = error => runtimeErrors.push({ actionId: activeAction, type: "pageerror", message: error?.message || String(error) });
  const onConsole = message => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/^Failed to load resource: the server responded with a status of 404 \(Not Found\)/.test(text)) return;
    runtimeErrors.push({ actionId: activeAction, type: "console", message: text });
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole);

  const coverage = new Map();
  const tasks = [];
  const scheduled = new Set();
  const actions = [];
  const snapshots = [];
  const anomalies = [];
  let initialMetrics = null;

  try {
    for (const root of ROOTS) {
      const metrics = await prepareAuditRoot(page, fixture, root.setup, settleMs);
      if (!initialMetrics && metrics?.perfTrace) initialMetrics = metrics;
      const inventory = await readControlInventory(page, true);
      mergeCoverage(coverage, inventory, root.id);
      scheduleInventoryTasks(tasks, scheduled, inventory, {
        rootId: root.id,
        rootSetup: root.setup,
        path: [],
        depth: 0,
      });
    }

    while (tasks.length && actions.length < maxActions) {
      const task = tasks.shift();
      activeAction = task.actionId;
      const action = await exerciseControl(page, fixture, task, {
        screenshotDir,
        viewport,
        settleMs,
      });
      actions.push(action);
      snapshots.push(...action.snapshots);
      anomalies.push(...action.anomalies);
      const row = coverage.get(task.signature);
      if (row) {
        row.exercised = action.clicked;
        row.attempts += 1;
        if (action.clickError) row.errors.push(action.clickError);
      }

      if (action.clicked && task.depth < maxDepth) {
        mergeCoverage(coverage, action.afterInventory, `${task.rootId}:${task.actionId}`);
        scheduleInventoryTasks(tasks, scheduled, action.afterInventory, {
          rootId: task.rootId,
          rootSetup: task.rootSetup,
          path: [...task.path, task.descriptor],
          depth: task.depth + 1,
        });
      }
    }

    if (tasks.length) {
      anomalies.push({
        severity: "error",
        code: "action-budget-exhausted",
        message: `${tasks.length} 个可点击控件因 action budget 未执行`,
      });
    }
  } finally {
    activeAction = "";
    page.off("pageerror", onPageError);
    page.off("console", onConsole);
    await page.evaluate(() => window.__qzVisualAudit?.clearMarks?.()).catch(() => {});
  }

  for (const error of runtimeErrors) {
    anomalies.push({
      severity: "error",
      code: error.type === "pageerror" ? "page-error" : "console-error",
      actionId: error.actionId,
      message: error.message,
    });
  }

  const coverageRows = Array.from(coverage.values())
    .map(row => ({
      ...row,
      roots: Array.from(row.roots).sort(),
      states: Array.from(row.states).sort(),
    }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
  const actionableRows = coverageRows.filter(row => row.visible && row.enabled);
  const unexercised = actionableRows.filter(row => !row.exercised);
  const clickFailures = actions.filter(action => !action.clicked || action.clickError).length;
  const errorCount = anomalies.filter(item => item.severity === "error").length;
  const warningCount = anomalies.filter(item => item.severity === "warning").length;
  const maxStableMovementPx = actions.reduce((max, action) => Math.max(max, Number(action.stableMovementPx) || 0), 0);
  const maxUnexpectedLayoutShift = actions.reduce((max, action) => (
    Math.max(max, Number(action.layoutShift?.withoutRecentInput) || 0)
  ), 0);

  await prepareAuditRoot(page, fixture, "conversation", settleMs);
  const finalMetrics = await page.evaluate(() => window.qingzhouConversationBenchmark.collectMetrics({ phase: "visual-audit" }));
  return {
    ...(initialMetrics || finalMetrics || {}),
    benchmark: "visual-audit",
    visualAudit: {
      version: 1,
      roots: ROOTS.map(root => root.id),
      maxDepth,
      maxActions,
      discoveredKinds: coverageRows.length,
      actionableKinds: actionableRows.length,
      exercisedKinds: actionableRows.filter(row => row.exercised).length,
      unexercisedKinds: unexercised.length,
      disabledOnlyKinds: coverageRows.filter(row => row.visible && !row.enabled).length,
      hiddenOnlyKinds: coverageRows.filter(row => !row.visible).length,
      actionCount: actions.length,
      clickFailures,
      errorCount,
      warningCount,
      maxStableMovementPx,
      maxUnexpectedLayoutShift,
      coverage: coverageRows,
      unexercised: unexercised.map(row => ({ signature: row.signature, label: row.label, roots: row.roots })),
      anomalies,
      actions,
      snapshots,
    },
  };
}

async function installVisualAuditRuntime(page) {
  await page.evaluate(() => {
    if (window.__qzVisualAudit) return;
    const CHAT_CONTAINER_SELECTOR = [
      "#messages",
      "#chat-dock",
      "#session-title-bar",
      "#chat-search-bar",
      "#notifications-panel",
    ].join(",");
    const CHAT_HEADER_CONTROL_SELECTOR = [
      ".tab-btn[data-tab='chat']",
      "#btn-case-recording",
      "#btn-new",
      "#btn-notifications",
      "#btn-settings",
    ].join(",");
    const CONTROL_SELECTOR = "button, [role='button']";
    const STATE_CLASSES = new Set([
      "active", "hidden", "running", "waiting", "error", "aborted", "resolved",
      "is-confirmed", "is-entering", "is-resending", "selected", "disabled",
    ]);
    const CLASS_PRIORITY = [
      "tool-timeline-summary", "thinking-group-summary", "tool-summary",
      "tool-timeline-nav-btn", "thinking-group-nav-btn", "tool-timeline-step",
      "tool-family-row", "tool-family-batch", "tool-timeline-raw-btn",
      "tool-event-raw-btn", "tool-timeline-collapse-btn", "tool-event-collapse-btn",
      "waiting-continue-btn", "waiting-cancel-btn", "msg-user-edit-btn",
      "msg-user-edit-cancel", "msg-user-edit-submit", "msg-action-btn",
      "code-copy-btn", "artifact-strip-open", "artifact-solid-btn",
      "queued-followup-steer", "queued-followup-delete", "recovery-action-btn", "onboarding-action",
      "onboarding-primary-btn", "onboarding-link",
      "model-combobox-toggle", "chat-search-btn", "send-btn", "abort-btn", "icon-btn",
    ];
    const IDENTITY_DATA_KEYS = [
      "action", "waitAction", "artifactAction", "onboardingAction", "timelineNavDirection",
      "thinkingNavDirection", "sessionAction", "steerFollowUp", "deleteFollowUp", "deleteSteering",
    ];
    const PANEL_SELECTORS = [
      "#notifications-panel", "#settings-panel", "#chat-search-bar", "#artifacts-panel",
      "#automation-editor", "[role='dialog']",
    ];
    const BLOCKING_PANEL_SELECTORS = [
      "#notifications-panel", "#settings-panel", "#artifacts-panel",
      "#automation-editor", "[role='dialog']",
    ];
    let shiftObserver = null;
    let shifts = [];

    function allChatControls() {
      const controls = [];
      for (const element of document.querySelectorAll(CONTROL_SELECTOR)) {
        if (element.matches(CHAT_HEADER_CONTROL_SELECTOR) || element.closest(CHAT_CONTAINER_SELECTOR)) controls.push(element);
      }
      return controls;
    }

    function isVisible(element) {
      if (!element?.isConnected || element.hidden || element.closest("[hidden], .hidden")) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }

    function isBlockedByOpenPanel(element, visible) {
      if (!visible) return false;
      return BLOCKING_PANEL_SELECTORS.some(selector => (
        Array.from(document.querySelectorAll(selector)).some(panel => (
          isVisible(panel) && panel !== element && !panel.contains(element)
        ))
      ));
    }

    function controlSignature(element) {
      let identity = "";
      if (element.id) identity = `id:${element.id}`;
      if (!identity) {
        for (const key of IDENTITY_DATA_KEYS) {
          if (element.dataset?.[key] != null && String(element.dataset[key]) !== "") {
            identity = `data:${key}=${String(element.dataset[key])}`;
            break;
          }
        }
      }
      if (!identity) {
        const classes = Array.from(element.classList || []).filter(name => !STATE_CLASSES.has(name));
        const preferred = CLASS_PRIORITY.find(name => classes.includes(name));
        identity = preferred ? `class:${preferred}` : `class:${classes.sort().join(".") || element.tagName.toLowerCase()}`;
      }
      const direction = element.dataset?.timelineNavDirection ?? element.dataset?.thinkingNavDirection;
      if (direction != null && direction !== "") identity += `|direction=${direction}`;
      if (element.hasAttribute("aria-expanded")) identity += `|expanded=${element.getAttribute("aria-expanded")}`;
      return identity;
    }

    function controlLabel(element) {
      return String(
        element.getAttribute("aria-label")
        || element.getAttribute("title")
        || element.textContent
        || controlSignature(element)
      ).replace(/\s+/g, " ").trim().slice(0, 120);
    }

    function inventory(includeHidden = false) {
      const counts = new Map();
      const visibleCounts = new Map();
      return allChatControls().map(element => {
        const signature = controlSignature(element);
        const allOccurrence = counts.get(signature) || 0;
        counts.set(signature, allOccurrence + 1);
        const visible = isVisible(element);
        const blockedByPanel = isBlockedByOpenPanel(element, visible);
        const occurrence = visible ? (visibleCounts.get(signature) || 0) : allOccurrence;
        if (visible) visibleCounts.set(signature, occurrence + 1);
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          signature,
          occurrence,
          label: controlLabel(element),
          visible,
          blockedByPanel,
          enabled: !element.disabled && element.getAttribute("aria-disabled") !== "true",
          latent: visible && Number(style.opacity || 1) < 0.1,
          tag: element.tagName.toLowerCase(),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          state: element.getAttribute("aria-expanded") != null ? `expanded:${element.getAttribute("aria-expanded")}` : "default",
        };
      }).filter(item => includeHidden || item.visible);
    }

    function findControl(signature, occurrence = 0) {
      const element = allChatControls().filter(item => (
        controlSignature(item) === signature && isVisible(item)
      ))[occurrence] || null;
      if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") return null;
      return element;
    }

    function markControl(signature, occurrence, token) {
      clearMarks();
      const element = findControl(signature, occurrence);
      if (!element) return null;
      element.setAttribute("data-qz-visual-audit-target", token);
      const waiting = element.closest(".waiting-card");
      if (waiting) {
        waiting.querySelectorAll("input, textarea, select").forEach(control => {
          if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) control.checked = true;
          else if (control instanceof HTMLSelectElement && control.options.length) control.selectedIndex = Math.min(1, control.options.length - 1);
          else control.value = control.value || "视觉审计测试";
          control.dispatchEvent(new Event("input", { bubbles: true }));
          control.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      return { signature, label: controlLabel(element), latent: Number(getComputedStyle(element).opacity || 1) < 0.1 };
    }

    function clearMarks() {
      document.querySelectorAll("[data-qz-visual-audit-target]").forEach(element => element.removeAttribute("data-qz-visual-audit-target"));
    }

    function rectObject(rect) {
      return { x: rect.x, y: rect.y, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }

    function intersectsViewport(rect) {
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    }

    function clippedByViewport(rect, tolerance = 1) {
      return rect.left < -tolerance || rect.top < -tolerance || rect.right > innerWidth + tolerance || rect.bottom > innerHeight + tolerance;
    }

    function collectState(token = "") {
      const target = token ? document.querySelector(`[data-qz-visual-audit-target="${CSS.escape(token)}"]`) : null;
      const targetRect = target?.getBoundingClientRect?.() || null;
      const targetPoint = targetRect ? {
        x: Math.max(0, Math.min(innerWidth - 1, targetRect.left + targetRect.width / 2)),
        y: Math.max(0, Math.min(innerHeight - 1, targetRect.top + targetRect.height / 2)),
      } : null;
      const hit = targetPoint ? document.elementFromPoint(targetPoint.x, targetPoint.y) : null;
      const visibleControls = allChatControls().filter(isVisible).filter(element => intersectsViewport(element.getBoundingClientRect()));
      const signatureCounts = new Map();
      const geometry = {};
      for (const element of visibleControls) {
        const signature = controlSignature(element);
        const occurrence = signatureCounts.get(signature) || 0;
        signatureCounts.set(signature, occurrence + 1);
        geometry[`${signature}@${occurrence}`] = rectObject(element.getBoundingClientRect());
      }
      const overlaps = [];
      for (let i = 0; i < visibleControls.length; i += 1) {
        for (let j = i + 1; j < visibleControls.length; j += 1) {
          const a = visibleControls[i];
          const b = visibleControls[j];
          if (a.parentElement !== b.parentElement || a.contains(b) || b.contains(a)) continue;
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const width = Math.min(ar.right, br.right) - Math.max(ar.left, br.left);
          const height = Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top);
          if (width > 1 && height > 1) {
            overlaps.push({ a: controlSignature(a), b: controlSignature(b), width, height });
          }
        }
      }
      const duplicateIds = Array.from(document.querySelectorAll("[id]"))
        .map(element => element.id)
        .filter((id, index, ids) => id && ids.indexOf(id) !== index)
        .filter((id, index, ids) => ids.indexOf(id) === index);
      const panels = [];
      for (const selector of PANEL_SELECTORS) {
        document.querySelectorAll(selector).forEach((element, index) => {
          if (!isVisible(element)) return;
          const rect = element.getBoundingClientRect();
          panels.push({ selector, index, rect: rectObject(rect), clipped: clippedByViewport(rect, 2) });
        });
      }
      const textOverflow = visibleControls.filter(element => {
        const text = String(element.textContent || "").trim();
        if (!text) return false;
        const style = getComputedStyle(element);
        if (style.textOverflow === "ellipsis") return false;
        return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
      }).map(element => ({
        signature: controlSignature(element),
        label: controlLabel(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      const messages = document.querySelector("#messages");
      return {
        viewport: { width: innerWidth, height: innerHeight },
        horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
        messagesHorizontalOverflowPx: messages ? Math.max(0, messages.scrollWidth - messages.clientWidth) : 0,
        duplicateIds,
        overlaps,
        panels,
        textOverflow,
        visibleControlCount: visibleControls.length,
        geometry,
        target: targetRect ? {
          rect: rectObject(targetRect),
          connected: Boolean(target?.isConnected),
          clipped: clippedByViewport(targetRect, 1),
          hit: Boolean(hit && (hit === target || target.contains(hit))),
          hitTag: hit?.tagName?.toLowerCase?.() || "",
          hitClass: String(hit?.className || "").slice(0, 120),
        } : null,
      };
    }

    function startShiftMonitor() {
      shifts = [];
      shiftObserver?.disconnect?.();
      try {
        shiftObserver = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) shifts.push({ value: entry.value, hadRecentInput: entry.hadRecentInput });
        });
        shiftObserver.observe({ type: "layout-shift", buffered: false });
      } catch (_error) {
        shiftObserver = null;
      }
    }

    function stopShiftMonitor() {
      shiftObserver?.disconnect?.();
      shiftObserver = null;
      const rows = shifts.slice();
      shifts = [];
      return {
        count: rows.length,
        total: rows.reduce((sum, item) => sum + (Number(item.value) || 0), 0),
        withoutRecentInput: rows.filter(item => !item.hadRecentInput).reduce((sum, item) => sum + (Number(item.value) || 0), 0),
      };
    }

    window.__qzVisualAudit = {
      inventory,
      markControl,
      clearMarks,
      collectState,
      startShiftMonitor,
      stopShiftMonitor,
    };
  });
}

async function prepareAuditRoot(page, fixture, setup, settleMs = DEFAULT_SETTLE_MS) {
  let metrics = null;
  await page.evaluate(() => window.qingzhouConversationBenchmark.configureVisualState({
    running: false,
    pendingFollowUps: [],
    resetOnboarding: true,
  }));
  await page.keyboard.press("Escape");
  if (setup === "welcome") {
    metrics = await page.evaluate(() => window.qingzhouConversationBenchmark.reset({ debug: false, clearStorage: false }));
  } else {
    metrics = await page.evaluate(input => window.qingzhouConversationBenchmark.runSnapshotRender(input, { debug: false, clearStorage: false }), fixture);
  }
  if (setup === "expanded") {
    await page.evaluate(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      for (const button of Array.from(document.querySelectorAll([
        ".msg-tool > .tool-summary[aria-expanded='false']",
        ".msg-tool-timeline > .tool-timeline-summary[aria-expanded='false']",
        ".msg-thinking-group > .thinking-group-summary[aria-expanded='false']",
      ].join(",")))) button.click();
      await frame();
      await frame();
    });
  }
  if (setup === "search") {
    await page.keyboard.press("Control+f");
    const input = page.locator("#chat-search-input");
    await input.fill("测试");
  }
  if (setup === "composer") {
    await page.locator("#input").fill("视觉审计：验证发送按钮状态");
  }
  if (setup === "running" || setup === "queued") {
    await page.evaluate(({ queued }) => window.qingzhouConversationBenchmark.configureVisualState({
      running: true,
      pendingFollowUps: queued ? [
        { clientMessageId: "visual-queue-1", text: "继续整理第二批结果", index: 0 },
        { clientMessageId: "visual-queue-2", text: "再补一份对比摘要", index: 1 },
      ] : [],
    }), { queued: setup === "queued" });
  }
  await page.waitForTimeout(Math.max(90, Number(settleMs) || DEFAULT_SETTLE_MS));
  await page.evaluate(() => {
    document.querySelectorAll("[data-qz-visual-audit-target]").forEach(element => {
      element.removeAttribute("data-qz-visual-audit-target");
    });
  });
  return metrics;
}

async function readControlInventory(page, includeHidden = false) {
  return page.evaluate(value => window.__qzVisualAudit.inventory(value), includeHidden);
}

function mergeCoverage(coverage, inventory, rootId) {
  for (const item of inventory) {
    let row = coverage.get(item.signature);
    if (!row) {
      row = {
        signature: item.signature,
        label: item.label,
        visible: false,
        enabled: false,
        exercised: false,
        attempts: 0,
        roots: new Set(),
        states: new Set(),
        errors: [],
      };
      coverage.set(item.signature, row);
    }
    if (item.label && (!row.label || row.label === row.signature)) row.label = item.label;
    row.visible ||= Boolean(item.visible);
    row.enabled ||= Boolean(item.visible && item.enabled && item.blockedByPanel !== true);
    row.roots.add(rootId);
    row.states.add(item.state || "default");
  }
}

function scheduleInventoryTasks(tasks, scheduled, inventory, context) {
  for (const item of inventory) {
    if (!item.visible || !item.enabled || item.blockedByPanel === true || scheduled.has(item.signature)) continue;
    scheduled.add(item.signature);
    const descriptor = { signature: item.signature, occurrence: item.occurrence || 0, label: item.label || item.signature };
    tasks.push({
      ...context,
      signature: item.signature,
      descriptor,
      actionId: stableActionId(item.signature),
    });
  }
}

async function exerciseControl(page, fixture, task, options) {
  const snapshots = [];
  const anomalies = [];
  let clickError = "";
  let clicked = false;
  await prepareAuditRoot(page, fixture, task.rootSetup, options.settleMs);
  for (const step of task.path) {
    const replay = await markAndPrepareControl(page, step, `replay-${task.actionId}`);
    if (!replay.found || !replay.preparation.ready) {
      clickError = replay.preparation?.error || `无法重放前置控件 ${step.signature}`;
      break;
    }
    try {
      await replay.locator.click({ timeout: 5000 });
      await page.waitForTimeout(Math.max(90, Number(options.settleMs) || DEFAULT_SETTLE_MS));
    } catch (error) {
      clickError = `前置控件点击失败 ${step.signature}: ${error?.message || String(error)}`;
      break;
    }
  }

  const token = `target-${task.actionId}`;
  const target = clickError ? { found: false } : await markAndPrepareControl(page, task.descriptor, token);
  if (!target.found) {
    clickError ||= `未找到控件 ${task.signature}`;
  } else {
    await page.evaluate(() => window.__qzVisualAudit.startShiftMonitor());
    const before = await page.evaluate(value => window.__qzVisualAudit.collectState(value), token);
    snapshots.push(...await captureFrame(page, options, task, "before"));
    anomalies.push(...stateAnomalies(before, task, "before", { requireTarget: true }));
    try {
      if (!target.preparation.ready) throw new Error(target.preparation.error);
      await target.locator.click({ timeout: 1500 });
      clicked = true;
    } catch (error) {
      clickError = error?.message || String(error);
    }
    await nextFrame(page);
    const immediate = await page.evaluate(value => window.__qzVisualAudit.collectState(value), token);
    snapshots.push(...await captureFrame(page, options, task, "frame-1"));
    anomalies.push(...stateAnomalies(immediate, task, "frame-1"));
    await page.waitForTimeout(options.settleMs);
    const settled = await page.evaluate(value => window.__qzVisualAudit.collectState(value), token);
    snapshots.push(...await captureFrame(page, options, task, "settled"));
    anomalies.push(...stateAnomalies(settled, task, "settled"));
    await nextFrame(page);
    await nextFrame(page);
    const stable = await page.evaluate(value => window.__qzVisualAudit.collectState(value), token);
    const shift = await page.evaluate(() => window.__qzVisualAudit.stopShiftMonitor());
    const stableMovementPx = geometryMovement(settled.geometry, stable.geometry);
    if (stableMovementPx > 1) {
      anomalies.push({
        severity: "error",
        code: "unstable-after-settle",
        actionId: task.actionId,
        signature: task.signature,
        phase: "stable",
        value: stableMovementPx,
        message: `稳定帧之间仍移动 ${stableMovementPx.toFixed(2)}px`,
      });
    }
    if (clickError && before?.target && !before.target.hit) {
      anomalies.push({
        severity: "error",
        code: "target-occluded",
        actionId: task.actionId,
        signature: task.signature,
        phase: "before",
        message: `点击目标被 ${before.target.hitTag || "其他元素"} 遮挡`,
        target: before.target,
      });
    }
    if (clickError) {
      anomalies.push({
        severity: "error",
        code: "click-failed",
        actionId: task.actionId,
        signature: task.signature,
        message: clickError,
      });
    }
    const afterInventory = await readControlInventory(page, true);
    await page.evaluate(() => window.__qzVisualAudit.clearMarks());
    return {
      actionId: task.actionId,
      rootId: task.rootId,
      signature: task.signature,
      label: task.descriptor.label,
      depth: task.depth,
      path: task.path,
      descriptor: task.descriptor,
      preparation: target.preparation,
      clicked,
      clickError,
      stableMovementPx,
      layoutShift: shift,
      before,
      immediate,
      settled,
      stable,
      afterInventory,
      anomalies,
      snapshots,
    };
  }

  anomalies.push({
    severity: "error",
    code: "target-missing",
    actionId: task.actionId,
    signature: task.signature,
    message: clickError || `未找到控件 ${task.signature}`,
  });
  return {
    actionId: task.actionId,
    rootId: task.rootId,
    signature: task.signature,
    label: task.descriptor.label,
    depth: task.depth,
    path: task.path,
    descriptor: task.descriptor,
    clicked: false,
    clickError,
    stableMovementPx: 0,
    layoutShift: { count: 0, total: 0, withoutRecentInput: 0 },
    afterInventory: [],
    anomalies,
    snapshots,
  };
}

async function markAndPrepareControl(page, descriptor, token) {
  const marked = await page.evaluate(({ descriptor: value, token: marker }) => (
    window.__qzVisualAudit.markControl(value.signature, value.occurrence || 0, marker)
  ), { descriptor, token });
  if (!marked) return { found: false, locator: null };
  const locator = page.locator(`[${CONTROL_TARGET_ATTR}="${token}"]`);
  const preparation = await prepareAuditControl(page, locator);
  return { found: true, locator, marked, preparation };
}

/** Use user scroll intent before positioning a historical control: programmatic
 * scrolling alone is correctly undone by the application's tail-follow policy. */
export async function prepareAuditControl(page, locator) {
  const started = Date.now();
  let stableSince = started;
  let previous = null;
  let wheelCount = 0;
  while (Date.now() - started < 1500) {
    const state = await locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const messages = element.closest("#messages");
      const scrollRect = messages?.getBoundingClientRect();
      const viewport = {
        top: Math.max(0, scrollRect?.top ?? 0), bottom: Math.min(innerHeight, scrollRect?.bottom ?? innerHeight),
        left: Math.max(0, scrollRect?.left ?? 0), right: Math.min(innerWidth, scrollRect?.right ?? innerWidth),
      };
      return {
        top: rect.top, left: rect.left, width: rect.width, height: rect.height,
        visible: rect.width > 0 && rect.height > 0 && rect.top >= viewport.top - 1
          && rect.bottom <= viewport.bottom + 1 && rect.left >= viewport.left - 1 && rect.right <= viewport.right + 1,
        viewport, inMessages: Boolean(messages),
      };
    });
    if (!state.visible) {
      previous = null;
      if (state.inMessages && wheelCount === 0) {
        // The scroller's padding avoids nested code/detail scroll surfaces.
        await page.mouse.move(state.viewport.left + 2, (state.viewport.top + state.viewport.bottom) / 2);
        const delta = state.top < state.viewport.top ? state.top - state.viewport.top - 40 : state.top - state.viewport.bottom + state.height + 40;
        await page.mouse.wheel(0, delta);
        wheelCount += 1;
        await nextFrame(page);
      }
      await locator.scrollIntoViewIfNeeded({ timeout: 200 }).catch(() => {});
    } else {
      // Hover the visible target, not its potentially much taller message host.
      await page.mouse.move(state.left + state.width / 2, state.top + state.height / 2);
      const unchanged = previous && ["top", "left", "width", "height"].every(key => Math.abs(state[key] - previous[key]) <= 1);
      if (!unchanged) { stableSince = Date.now(); previous = state; }
      if (unchanged && Date.now() - stableSince >= 64) {
        return { ready: true, wheelCount, elapsedMs: Date.now() - started, stableMs: Date.now() - stableSince };
      }
    }
    await nextFrame(page);
  }
  return { ready: false, wheelCount, elapsedMs: Date.now() - started, error: "Audit target did not become visible and stable within 1500 ms" };
}

function stateAnomalies(state, task, phase, { requireTarget = false } = {}) {
  const rows = [];
  const push = (severity, code, message, detail = {}) => rows.push({
    severity,
    code,
    actionId: task.actionId,
    signature: task.signature,
    phase,
    message,
    ...detail,
  });
  if (Number(state?.horizontalOverflowPx) > 1) push("error", "viewport-horizontal-overflow", `页面横向溢出 ${state.horizontalOverflowPx}px`, { value: state.horizontalOverflowPx });
  if (Number(state?.messagesHorizontalOverflowPx) > 1) push("error", "chat-horizontal-overflow", `对话区横向溢出 ${state.messagesHorizontalOverflowPx}px`, { value: state.messagesHorizontalOverflowPx });
  if (state?.duplicateIds?.length) push("error", "duplicate-dom-id", `出现重复 DOM id：${state.duplicateIds.join(", ")}`, { ids: state.duplicateIds });
  for (const overlap of state?.overlaps || []) push("error", "sibling-control-overlap", `${overlap.a} 与 ${overlap.b} 发生重叠`, overlap);
  for (const panel of state?.panels || []) {
    if (panel.clipped) push("error", "panel-clipped", `${panel.selector} 超出视口`, { panel });
  }
  if (requireTarget && !state?.target) push("error", "target-disappeared-before-click", "点击前目标控件已消失");
  if (requireTarget && state?.target?.clipped) push("error", "target-clipped", "点击目标超出视口", { rect: state.target.rect });
  for (const item of (state?.textOverflow || []).slice(0, 8)) {
    push("warning", "control-text-overflow", `${item.label || item.signature} 的文字超出控件`, { control: item });
  }
  return rows;
}

function geometryMovement(a = {}, b = {}) {
  let max = 0;
  for (const [key, first] of Object.entries(a || {})) {
    const second = b?.[key];
    if (!second) continue;
    max = Math.max(
      max,
      Math.abs((Number(first.x) || 0) - (Number(second.x) || 0)),
      Math.abs((Number(first.y) || 0) - (Number(second.y) || 0)),
      Math.abs((Number(first.width) || 0) - (Number(second.width) || 0)),
      Math.abs((Number(first.height) || 0) - (Number(second.height) || 0)),
    );
  }
  return max;
}

async function captureFrame(page, options, task, phase) {
  if (!options.screenshotDir) return [];
  const filename = `${task.actionId}--${phase}.png`;
  const path = join(options.screenshotDir, filename);
  await page.screenshot({ path, fullPage: false });
  return [{
    name: `${task.actionId}--${phase}`,
    actionId: task.actionId,
    signature: task.signature,
    phase,
    path,
    relativePath: `interactions/${filename}`,
    hash: fileHash(path),
    width: options.viewport.width,
    height: options.viewport.height,
  }];
}

async function nextFrame(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
}

function stableActionId(signature) {
  const slug = String(signature || "control")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54)
    || "control";
  const digest = createHash("sha1").update(String(signature || "")).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}
