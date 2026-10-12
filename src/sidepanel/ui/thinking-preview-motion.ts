import { t } from "../i18n/index.js";
import { escapeHtml } from "./ui-utils.js";

interface MotionState { track: HTMLElement; textEl: HTMLElement; target: number; running: boolean; offset: number; raf?: number; lastTime?: number }
const motionStates = new WeakMap<HTMLElement, MotionState>();
const observedPreviewEls = new WeakSet<HTMLElement>();

export function renderThinkingSummaryPreview(preview: unknown, running = false) {
  return renderThinkingPreviewTrack(preview, running);
}

function renderThinkingPreviewTrack(preview: unknown, _running = false) {
  const safePreview = escapeHtml(preview || t("recorded"));
  return `
    <span class="thinking-group-preview-track">
      <span class="thinking-group-preview-text" style="--thinking-preview-offset: 0px">${safePreview}</span>
    </span>
  `;
}

export function setThinkingSummaryPreview(el: HTMLElement | null, preview: unknown, running = false) {
  if (!el) return;
  const text = String(preview || t("recorded"));
  if (el.dataset.preview === text && el.dataset.runningPreview === String(Boolean(running))) {
    syncThinkingPreviewMotion(el, { running, animate: running });
    return;
  }
  const track = ensureThinkingPreviewTrack(el, text, running);
  const textEl = track?.querySelector<HTMLElement>(".thinking-group-preview-text");
  const hadPreview = Boolean(el.dataset.preview);
  if (!track || !textEl) {
    el.innerHTML = renderThinkingSummaryPreview(text, running);
    el.dataset.preview = text;
    el.dataset.runningPreview = String(Boolean(running));
    requestAnimationFrame(() => syncThinkingPreviewMotion(el, { running, animate: false }));
    return;
  }
  textEl.textContent = text;
  el.dataset.preview = text;
  el.dataset.runningPreview = String(Boolean(running));
  if (!hadPreview) {
    requestAnimationFrame(() => syncThinkingPreviewMotion(el, { running, animate: false }));
    return;
  }
  syncThinkingPreviewMotion(el, { running, animate: running && hadPreview });
}

function ensureThinkingPreviewTrack(el: HTMLElement, text: string, running = false) {
  let track = el.querySelector<HTMLElement>(".thinking-group-preview-track");
  if (!track) {
    el.innerHTML = renderThinkingSummaryPreview(text, running);
    track = el.querySelector<HTMLElement>(".thinking-group-preview-track");
  }
  return track;
}

function syncThinkingPreviewMotion(el: HTMLElement, { running = false, animate = false } = {}) {
  observeThinkingPreviewResize(el);
  const track = el?.querySelector<HTMLElement>(".thinking-group-preview-track");
  const textEl = track?.querySelector<HTMLElement>(".thinking-group-preview-text");
  if (!track || !textEl) return;
  const target = thinkingPreviewTailOffset(track, textEl);
  const state = motionStates.get(el) || { track, textEl, target, running, offset: currentThinkingPreviewOffset(textEl) };
  state.track = track;
  state.textEl = textEl;
  state.target = target;
  state.running = Boolean(running);
  state.offset = Number.isFinite(state.offset) ? state.offset : currentThinkingPreviewOffset(textEl);
  motionStates.set(el, state);

  if (!running || !animate || prefersReducedThinkingPreviewMotion()) {
    stopThinkingPreviewMotion(el);
    applyThinkingPreviewOffset(textEl, target);
    state.offset = target;
    return;
  }

  if (target >= -0.5) {
    stopThinkingPreviewMotion(el);
    applyThinkingPreviewOffset(textEl, 0);
    state.offset = 0;
    return;
  }

  if (state.offset < target) state.offset = target;
  if (target < state.offset - 120) state.offset = target + 120;
  applyThinkingPreviewOffset(textEl, state.offset);
  if (!state.raf) {
    state.raf = requestAnimationFrame(time => stepThinkingPreviewMotion(el, time));
  }
}

function stepThinkingPreviewMotion(el: HTMLElement, time: number) {
  const state = motionStates.get(el);
  const track = state?.track;
  const textEl = state?.textEl;
  if (!state || !track || !textEl) return;
  const target = thinkingPreviewTailOffset(track, textEl);
  state.target = target;
  if (!state.running || prefersReducedThinkingPreviewMotion() || target >= -0.5) {
    stopThinkingPreviewMotion(el);
    applyThinkingPreviewOffset(textEl, Math.min(0, target));
    state.offset = Math.min(0, target);
    return;
  }
  const previousTime = state.lastTime || time;
  state.lastTime = time;
  const elapsed = Math.min(80, Math.max(8, time - previousTime));
  const current = Number.isFinite(state.offset) ? state.offset : currentThinkingPreviewOffset(textEl);
  const distance = target - current;
  if (Math.abs(distance) <= 0.5) {
    applyThinkingPreviewOffset(textEl, target);
    state.offset = target;
    state.raf = 0;
    return;
  }
  const follow = 1 - Math.exp(-elapsed / 120);
  const minStep = Math.min(Math.abs(distance), elapsed * 0.28);
  const easedStep = Math.abs(distance) * follow;
  const step = Math.max(minStep, easedStep);
  const next = current + Math.sign(distance) * Math.min(Math.abs(distance), step);
  applyThinkingPreviewOffset(textEl, next);
  state.offset = next;
  state.raf = requestAnimationFrame(nextTime => stepThinkingPreviewMotion(el, nextTime));
}

function stopThinkingPreviewMotion(el: HTMLElement | null) {
  const state = el ? motionStates.get(el) : null;
  if (state?.raf) cancelAnimationFrame(state.raf);
  if (state) state.raf = 0;
}

function thinkingPreviewTailOffset(track: HTMLElement, textEl: HTMLElement) {
  const overflow = textEl.scrollWidth - track.clientWidth;
  return overflow > 0 ? -overflow : 0;
}

function currentThinkingPreviewOffset(textEl: HTMLElement) {
  const raw = textEl?.style?.getPropertyValue("--thinking-preview-offset") || "0";
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

function applyThinkingPreviewOffset(textEl: HTMLElement, offset: number) {
  textEl?.style?.setProperty("--thinking-preview-offset", `${Math.round(offset * 100) / 100}px`);
}

function prefersReducedThinkingPreviewMotion() {
  return Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

const thinkingPreviewResizeObserver = typeof globalThis.ResizeObserver === "function"
  ? new globalThis.ResizeObserver(entries => {
    for (const entry of entries) {
      const el = entry.target;
      if (!(el instanceof HTMLElement) || !el.isConnected) {
        thinkingPreviewResizeObserver?.unobserve(el);
        continue;
      }
      syncThinkingPreviewMotion(el, {
        running: el.dataset.runningPreview === "true",
        animate: el.dataset.runningPreview === "true",
      });
    }
  })
  : null;

function observeThinkingPreviewResize(el: HTMLElement | null) {
  if (!el || observedPreviewEls.has(el) || !thinkingPreviewResizeObserver) return;
  observedPreviewEls.add(el);
  thinkingPreviewResizeObserver.observe(el);
}
