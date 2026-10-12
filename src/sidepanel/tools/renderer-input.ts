import type { ToolEvent, TranscriptEntry } from "../../sdk/sidepanel/renderers.js";
export type { ToolEvent, TranscriptEntry } from "../../sdk/sidepanel/renderers.js";

export interface ToolPresentation {
  userToggled?: boolean;
  expanded?: boolean;
  activeToolKey?: string;
}
export interface ToolRenderOptions {
  expanded?: boolean;
  lazyDetails?: boolean;
  static?: boolean;
  deferMount?: boolean;
  standaloneFooter?: boolean;
  presentationState?: ToolPresentation;
  onPresentationChange?: (state: ToolPresentation) => void;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


export function timelineGroupTools(entry?: { entries?: TranscriptEntry[] }) {
  return Array.isArray(entry?.entries) ? entry.entries.filter(item => item?.type === "tool") : [];
}

