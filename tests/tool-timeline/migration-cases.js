const clone = value => structuredClone(value);
const IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#24845d"/><circle cx="40" cy="30" r="18" fill="#fff"/></svg>')}`;
const ROWS = [{ title: "候选 A", count: 12 }, { title: "候选 B", count: 8 }];
const IMAGES = [{ src: IMAGE, title: "本地样图", width: 80, height: 60 }];
const START = "2026-06-13 10:00:02";
const END = "2026-06-13 10:00:10";

/** The same protocol fixtures feed both revisions; no renderer internals are imported. */
export function createMigrationCases(harness) {
  const cases = harness.allToolNames().map((name, index) => ({
    id: `builtin-${name}`, event: clone(harness.sampleToolEvent(name, index)),
  }));
  const add = (id, name, args, result) => {
    const event = clone(harness.sampleToolEvent(name));
    Object.assign(event, { _uiKey: id, toolCallId: id, args: clone(args), result: clone(result),
      isRunning: false, isError: false, argsIncomplete: false, phase: "done", timestamp: START, endedAt: END });
    cases.push({ id, event });
  };
  add("data-write-table", "data_store", { action: "insert", table: "candidates", rows: ROWS },
    { table: "candidates", inserted: 2, totalRows: 2, rows: ROWS });
  add("data-query-table", "data_store", { action: "query", table: "candidates", limit: 10 },
    { table: "candidates", totalRows: 2, rows: ROWS });
  add("data-empty", "data_store", { action: "query", table: "candidates" },
    { table: "candidates", totalRows: 0, rows: [] });
  // Document tables branch on rows; Skill resources additionally require document metadata.
  add("document-chunk-table", "document_read_chunk", { docModelId: "doc-table", sheetName: "候选", offset: 0, limit: 10 },
    { docModelId: "doc-table", type: "table", sheetName: "候选", rows: ROWS, columns: ["title", "count"], totalRows: 2, offset: 0, limit: 10 });
  add("skill-resource-table", "load_skill_resource", { name: "research", path: "references/candidates.xlsx" },
    { name: "research", path: "references/candidates.xlsx", type: "document", format: "xlsx", sheetName: "候选",
      document: { docModelId: "skill-table", format: "xlsx" }, rows: ROWS, truncated: false });
  // The discovery tool is named list_images in both revisions, and renders a grid, not a table.
  add("list-images-grid", "list_images", { selector: "img" },
    { count: 1, pageTitle: "本地图片样例", images: IMAGES, note: "图片来自固定 data URI。" });
  add("collect-images-with-failures", "collect_images", { table: "gallery", urls: [IMAGE] },
    { table: "gallery", collected: 1, failed: 1, inserted: 1, totalRows: 1, images: IMAGES,
      failures: [{ target: "missing-image", code: "IMAGE_NOT_FOUND", message: "页面未找到图片" }] });
  return cases;
}

/** Keep call identity stable so callers can patch preparing → completed/error in place. */
export function makeStateCase(item, state) {
  if (!["preparing", "completed", "error"].includes(state)) throw new Error(`Unknown migration state: ${state}`);
  const event = clone(item.event);
  Object.assign(event, { isRunning: state === "preparing", argsIncomplete: state === "preparing",
    isError: state === "error", phase: state === "completed" ? "done" : state,
    timestamp: START, endedAt: state === "preparing" ? "" : END });
  if (state !== "completed") {
    delete event.image;
    event.result = state === "preparing" ? null
      : { ok: false, code: "MIGRATION_FIXTURE_ERROR", message: "固定错误样例", retryable: false };
  }
  return { id: `${item.id}-${state}`, event };
}

/** 3 calls use steps; 14 exceed both revisions' 12-call family threshold. */
export function makeGroupEvents(item, mode = "timeline") {
  if (!["timeline", "family"].includes(mode)) throw new Error(`Unknown migration group: ${mode}`);
  const events = Array.from({ length: mode === "family" ? 13 : 2 }, (_, index) => {
    const id = `${item.event.toolCallId || item.id}-${mode}-context-${index}`;
    return { type: "tool", _uiKey: id, toolCallId: id, runId: item.event.runId || "visual-run",
      name: index % 2 ? "navigate" : "open_tab", args: { url: "https://example.test/fixture" },
      result: { title: "上下文样例", url: "https://example.test/fixture" },
      timestamp: START, endedAt: END, phase: "done" };
  });
  // The target is the last call so the real timeline selects it by default.
  return [...events, clone(item.event)];
}

function supplements(inputs) {
  const items = inputs.filter(item => !item.id.startsWith("builtin-"));
  if (items.length !== 7) throw new Error(`Expected 7 structural fixtures, received ${items.length}`);
  return items;
}

function isolated(item, id) {
  return { id, event: { ...clone(item.event), _uiKey: id, toolCallId: id, runId: `${id}-run` } };
}

function assertGroup(element, mode, target) {
  const details = element.querySelector(":scope > .tool-timeline-details");
  if (details?.dataset.timelineMode !== (mode === "family" ? "family" : "steps")
    || details?.dataset.activeToolKey !== target.event._uiKey
    || Number(details?.dataset.activeToolIndex) !== (mode === "family" ? 13 : 2)) {
    throw new Error(`Wrong timeline mode or active tool: ${target.id} / ${mode}`);
  }
}

/** Exercise real updates, with separate identities for every independent card. */
export async function renderMigrationStateMatrix(inputs) {
  const { renderToolEvent, patchToolEvent } = await import("/extension/sidepanel/tools/tool-renderer.js");
  const { createToolTimelineGroupElement, patchToolTimelineGroupElement } = await import("/extension/sidepanel/tools/tool-timeline-renderer.js");
  const host = document.querySelector("#messages");
  host.replaceChildren();
  const ids = [];
  for (const item of supplements(inputs)) for (const mode of ["single", "timeline", "family"]) {
    for (const state of ["preparing", "completed", "error"]) {
      const target = isolated(item, `${item.id}-${mode}-${state}`);
      const preparing = makeStateCase(target, "preparing");
      const final = makeStateCase(target, state);
      const options = { lazyDetails: false, presentationState: { userToggled: true, expanded: true, activeToolKey: target.event._uiKey } };
      const group = value => ({ type: "tool-group", entries: makeGroupEvents(value, mode) });
      const element = mode === "single" ? renderToolEvent(preparing.event, options)
        : createToolTimelineGroupElement(group(preparing), options);
      const card = document.createElement("section");
      card.className = "visual-tool-component"; card.dataset.toolName = target.id;
      card.append(element); host.append(card);
      if (state !== "preparing") {
        const patched = mode === "single" ? patchToolEvent(element, final.event, options)
          : patchToolTimelineGroupElement(element, group(final), options);
        if (!patched || card.firstElementChild !== element) throw new Error(`Expected in-place patch: ${target.id}`);
      }
      if (mode !== "single") assertGroup(element, mode, target);
      if (element.querySelector(":scope > .tool-details")?.classList.contains("hidden")) throw new Error(`Collapsed fixture: ${target.id}`);
      ids.push(target.id);
    }
  }
  return ids;
}

/** Export through each revision's real feature; only annotate its finished cards. */
export async function exportMigrationMatrix(inputs) {
  const { createSessionExportFeature } = await import("/extension/sidepanel/features/export/session-export-feature.js");
  const transcript = [], targets = [];
  for (const item of supplements(inputs)) for (const mode of ["single", "timeline", "family"]) {
    const target = isolated(item, `${item.id}-export-${mode}`);
    const completed = makeStateCase(target, "completed");
    targets.push({ target, mode });
    transcript.push({ type: "user", _uiKey: `${target.id}-boundary`, text: target.id, timestamp: START });
    transcript.push(...(mode === "single" ? [completed.event] : makeGroupEvents(completed, mode)));
  }
  const feature = createSessionExportFeature({
    request: async () => { throw new Error("Snapshot export must not request session data"); },
    renderTranscriptElement: () => null,
    runtime: { getURL: path => new URL(`/extension/${path}`, location.href).href },
    getAppVersion: () => "0.0.0",
  });
  let result;
  try {
    result = await feature.createDocumentFromSnapshot({
      session: { id: "migration-export", title: "Renderer migration audit" }, transcript,
      exportedAt: "2026-09-18T04:00:00.000Z",
    });
  } finally { feature.dispose(); }
  const document = new DOMParser().parseFromString(result.html, "text/html");
  const cards = [...document.querySelectorAll("#messages > .msg-tool")];
  if (cards.length !== targets.length) throw new Error(`Expected ${targets.length} exported cards, received ${cards.length}`);
  cards.forEach((card, index) => {
    const { target, mode } = targets[index];
    if (mode !== "single") {
      const count = mode === "family" ? 14 : 3;
      if (card.querySelector(":scope > .tool-timeline-details")?.dataset.timelineMode !== (mode === "family" ? "family" : "steps")
        || card.querySelectorAll(":scope > template.static-transcript-template[data-static-tool-index]").length !== count) {
        throw new Error(`Wrong exported timeline mode or template count: ${target.id}`);
      }
      card.dataset.migrationTargetIndex = String(count - 1);
    }
    card.classList.add("visual-tool-component"); card.dataset.toolName = target.id;
  });
  return { html: `<!doctype html>\n${document.documentElement.outerHTML}`, ids: targets.map(({ target }) => target.id) };
}
