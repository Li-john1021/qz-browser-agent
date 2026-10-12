import { sessionIdText as normalizeSessionId } from "../../sessions/session-id.js";
import type { TranscriptEntry, ToolPresentation } from "../../../tools/renderer-input.js";
type Entry = TranscriptEntry | null | undefined;
interface PresentationRecord extends Required<ToolPresentation> { revision: number; aliases: Set<string> }

export function createToolPresentationState() {
  const aliasesBySession = new Map<string, Map<string, PresentationRecord>>();
  let revision = 0;

  function resolve(sessionId: unknown, entry: Entry) {
    const tools = toolPresentationEntries(entry);
    const aliases = toolPresentationAliases(entry, tools);
    const record = findRecord(sessionId, aliases);
    const activeToolKey = record
      ? resolveToolPresentationActiveKey(tools, record.activeToolKey)
      : "";
    if (record && record.activeToolKey !== activeToolKey) record.activeToolKey = activeToolKey;
    return {
      anchor: toolPresentationAnchor(entry, tools),
      userToggled: record?.userToggled === true,
      expanded: record?.userToggled === true && record.expanded === true,
      activeToolKey,
    };
  }

  function update(sessionId: unknown, entry: Entry, patch: ToolPresentation = {}) {
    const id = normalizeSessionId(sessionId);
    const tools = toolPresentationEntries(entry);
    const aliases = toolPresentationAliases(entry, tools);
    if (!id || !aliases.length || !tools.length) return resolve(sessionId, entry);

    const record = findRecord(id, aliases) || createRecord(id, aliases);
    revision += 1;
    record.revision = revision;
    record.userToggled = patch.userToggled !== false;
    if (Object.prototype.hasOwnProperty.call(patch, "expanded")) {
      record.expanded = Boolean(patch.expanded);
    }
    const requestedActiveKey = Object.prototype.hasOwnProperty.call(patch, "activeToolKey")
      ? patch.activeToolKey
      : record.activeToolKey;
    record.activeToolKey = resolveToolPresentationActiveKey(tools, requestedActiveKey);
    bindAliases(id, record, aliases);
    return resolve(id, entry);
  }

  function forgetSession(sessionId: unknown) {
    aliasesBySession.delete(normalizeSessionId(sessionId));
  }

  function reset() {
    aliasesBySession.clear();
    revision = 0;
  }

  function inspect(sessionId: unknown, entry: Entry) {
    const aliases = toolPresentationAliases(entry);
    const record = findRecord(sessionId, aliases);
    return record ? {
      userToggled: record.userToggled,
      expanded: record.expanded,
      activeToolKey: record.activeToolKey,
      revision: record.revision,
      aliases: Array.from(record.aliases).sort(),
    } : null;
  }

  function createRecord(sessionId: string, aliases: string[]) {
    const record = {
      userToggled: false,
      expanded: false,
      activeToolKey: "",
      revision: 0,
      aliases: new Set<string>(),
    };
    bindAliases(sessionId, record, aliases);
    return record;
  }

  function findRecord(sessionId: unknown, aliases: string[]) {
    const records = aliasesBySession.get(normalizeSessionId(sessionId));
    if (!records) return null;
    const matches = Array.from(new Set(aliases.map(alias => records.get(alias)).filter((item): item is PresentationRecord => item !== undefined)));
    if (!matches.length) return null;
    const winner = matches.reduce((latest, item) => (
      item.revision > latest.revision ? item : latest
    ));
    for (const record of matches) {
      if (record === winner) continue;
      bindAliases(sessionId, winner, Array.from(record.aliases));
    }
    bindAliases(sessionId, winner, aliases);
    return winner;
  }

  function bindAliases(sessionId: unknown, record: PresentationRecord, aliases: string[]) {
    const id = normalizeSessionId(sessionId);
    if (!id || !record) return;
    let records = aliasesBySession.get(id);
    if (!records) {
      records = new Map();
      aliasesBySession.set(id, records);
    }
    for (const alias of aliases) {
      if (!alias) continue;
      record.aliases.add(alias);
      records.set(alias, record);
    }
  }

  return { resolve, update, inspect, forgetSession, reset };
}

export function resolveToolPresentationActiveKey(tools: TranscriptEntry[], preferredKey: unknown = "") {
  const entries = Array.isArray(tools) ? tools.filter(Boolean) : [];
  if (!entries.length) return "";
  const preferred = String(preferredKey || "");
  if (preferred && entries.some(tool => toolPresentationToolKey(tool) === preferred)) return preferred;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (isActiveTool(entries[index])) return toolPresentationToolKey(entries[index]);
  }
  return toolPresentationToolKey(entries[entries.length - 1]);
}

export function toolPresentationAnchor(entry: Entry, tools = toolPresentationEntries(entry)) {
  return String(entry?._toolPresentationAnchor || toolPresentationToolKey(tools[0]) || "");
}

export function toolPresentationToolKey(tool: Entry) {
  const uiKey = String(tool?._uiKey || "").trim();
  if (uiKey) return uiKey;
  const callId = String(tool?.toolCallId || "").trim();
  const runId = String(tool?.runId || "").trim();
  if (callId) return runId ? `${runId}:${callId}` : callId;
  return "";
}

function toolPresentationEntries(entry: Entry): TranscriptEntry[] {
  if (entry?.type === "tool-group") {
    return Array.isArray(entry.entries) ? entry.entries.filter(item => item?.type === "tool") : [];
  }
  return entry?.type === "tool" ? [entry] : [];
}

function toolPresentationAliases(entry: Entry, tools = toolPresentationEntries(entry)) {
  const aliases = [];
  const turnAnchor = String(entry?._toolPresentationAnchor || "").trim();
  if (turnAnchor) aliases.push(`turn:${turnAnchor}`);
  for (const tool of tools) {
    const key = toolPresentationToolKey(tool);
    if (key) aliases.push(`tool:${key}`);
  }
  return Array.from(new Set(aliases));
}

function isActiveTool(tool: Entry) {
  return Boolean(
    tool?.isRunning
    || tool?.argsIncomplete
    || tool?.argsGenerating
    || tool?.phase === "preparing"
    || tool?.phase === "running"
  );
}

