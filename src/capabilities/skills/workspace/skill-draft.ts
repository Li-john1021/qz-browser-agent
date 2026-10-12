import type { SkillResource } from "#sdk/shared/skills";
export interface SkillDraftInput extends Record<string, unknown> {
  metadata?: Record<string, unknown>; body?: unknown; content?: unknown; resources?: Partial<SkillResource>[];
  mcp?: unknown; sourceText?: unknown; sourceRevision?: unknown; authority?: unknown;
}
type DraftState = ReturnType<typeof normalizeSkillDraft>;
export type SkillDraftSnapshot = DraftState & { dirty: boolean; revision: number; authority: "source" | "structured" };
interface DraftOptions {
  serialize?(value: SkillDraftSnapshot): string;
  parse?(source: string, current: SkillDraftSnapshot): SkillDraftInput;
}
interface RevisionOptions { expectedRevision?: number; authority?: string }

export class SkillDraft {
  private _serialize: NonNullable<DraftOptions["serialize"]>;
  private _parse: NonNullable<DraftOptions["parse"]>;
  private _revision: number;
  private _savedRevision: number;
  private _state: DraftState;
  private _authority: "source" | "structured";
  constructor(value: SkillDraftInput = {}, options: DraftOptions = {}) {
    this._serialize = typeof options.serialize === "function" ? options.serialize : defaultSerialize;
    this._parse = typeof options.parse === "function" ? options.parse : defaultParse;
    this._revision = 0;
    this._savedRevision = 0;
    this._state = normalizeSkillDraft(value);
    this._authority = normalizeAuthority(value.authority);
  }

  get revision() {
    return this._revision;
  }

  get dirty() {
    return this._revision !== this._savedRevision;
  }

  get authority() {
    return this._authority;
  }

  snapshot(): SkillDraftSnapshot {
    return {
      ...clone(this._state),
      dirty: this.dirty,
      revision: this._revision,
      sourceRevision: this._state.sourceRevision,
      authority: this._authority,
    };
  }

  update(patch: SkillDraftInput = {}, options: RevisionOptions = {}) {
    assertRevision(options.expectedRevision, this._revision);
    const next = normalizeSkillDraft({
      ...this._state,
      ...patch,
      metadata: { ...this._state.metadata, ...(patch.metadata || {}) },
      resources: Object.prototype.hasOwnProperty.call(patch, "resources") ? patch.resources : this._state.resources,
      mcp: Object.prototype.hasOwnProperty.call(patch, "mcp") ? patch.mcp : this._state.mcp,
    });
    const nextAuthority = normalizeAuthority(options.authority || "structured");
    if (signature(next) === signature(this._state) && nextAuthority === this._authority) return this.snapshot();
    this._state = next;
    this._authority = nextAuthority;
    this._revision += 1;
    return this.snapshot();
  }

  replaceFromSource(sourceText: string, options: RevisionOptions = {}) {
    assertRevision(options.expectedRevision, this._revision);
    const source = String(sourceText ?? "");
    const parsed = this._parse(source, this.snapshot());
    this._state = normalizeSkillDraft({
      ...this._state,
      ...(parsed || {}),
      sourceText: source,
      sourceRevision: this._state.sourceRevision + 1,
    });
    this._authority = "source";
    this._revision += 1;
    return this.snapshot();
  }

  serialize() {
    const sourceText = String(this._serialize(this.snapshot()) || "");
    this._state = { ...this._state, sourceText };
    return sourceText;
  }

  setAuthority(value: unknown) {
    this._authority = normalizeAuthority(value);
    return this.snapshot();
  }

  markSaved(savedValue: SkillDraftInput | null = null) {
    if (savedValue && typeof savedValue === "object") this._state = normalizeSkillDraft(savedValue);
    this._savedRevision = this._revision;
    return this.snapshot();
  }

  reset(value: SkillDraftInput = {}) {
    this._state = normalizeSkillDraft(value);
    this._authority = normalizeAuthority(value.authority);
    this._revision += 1;
    this._savedRevision = this._revision;
    return this.snapshot();
  }
}

function normalizeAuthority(value: unknown) {
  return value === "source" ? "source" : "structured";
}

export function createSkillDraft(value: SkillDraftInput = {}, options: DraftOptions = {}) {
  return new SkillDraft(value, options);
}

export function captureSkillDraftSave(draft: SkillDraft | null, skillName = "") {
  return Object.freeze({
    draft,
    revision: draft?.revision ?? -1,
    skillName: String(skillName || ""),
  });
}

export function classifySkillDraftSave(snapshot: ReturnType<typeof captureSkillDraftSave>, currentDraft: SkillDraft | null, currentSkillName = "") {
  const editorStillCurrent = Boolean(
    snapshot?.draft
    && snapshot.draft === currentDraft
    && snapshot.skillName === String(currentSkillName || ""),
  );
  return {
    editorStillCurrent,
    saveIsCurrent: editorStillCurrent && snapshot.revision === currentDraft?.revision,
  };
}

function normalizeSkillDraft(value: SkillDraftInput = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    metadata: clone(input.metadata || pickMetadata(input)),
    body: String(input.body ?? input.content ?? ""),
    resources: normalizeResources(input.resources),
    mcp: clone(input.mcp || null),
    sourceText: String(input.sourceText || ""),
    sourceRevision: Math.max(0, Number(input.sourceRevision) || 0),
  };
}

function pickMetadata(input: SkillDraftInput) {
  return {
    name: String(input.name || ""),
    displayName: String(input.displayName || ""),
    description: String(input.description || ""),
    scope: String(input.scope || "global"),
    domains: Array.isArray(input.domains) ? input.domains.slice() : [],
    urlPatterns: Array.isArray(input.urlPatterns) ? input.urlPatterns.slice() : [],
    excludePatterns: Array.isArray(input.excludePatterns) ? input.excludePatterns.slice() : [],
  };
}

function normalizeResources(resources: Partial<SkillResource>[] | undefined) {
  return (Array.isArray(resources) ? resources : []).map(resource => ({
    ...clone(resource),
    path: String(resource?.path || ""),
    content: String(resource?.content || ""),
  })).filter(resource => resource.path);
}

function defaultSerialize(value: SkillDraftSnapshot) {
  return value.sourceText || value.body || "";
}

function defaultParse(source: string) {
  return { body: source };
}

function assertRevision(expected: number | undefined, actual: number) {
  if (expected == null) return;
  if (Number(expected) !== Number(actual)) {
    throw Object.assign(new Error(`Skill draft revision mismatch: expected ${expected}, current ${actual}`), { code: "SKILL_DRAFT_REVISION_MISMATCH" });
  }
}

function signature(value: unknown) {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}
