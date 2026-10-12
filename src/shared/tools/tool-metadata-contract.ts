/** Titles are data: the shared host interprets one bounded field lookup in every context. */
export interface ToolTitleRule {
  readonly field: string;
  readonly values: Readonly<Record<string, string>>;
  readonly normalize?: "trim" | "lowercase";
  readonly fallback?: "action";
  readonly defaultTitle?: string;
}
export interface ToolMetadata {
  readonly title: string;
  /** Compact UI label; the full title remains the identity and historical snapshot label. */
  readonly shortTitle?: string;
  readonly sets: readonly string[];
  readonly profileFamily: string;
  readonly resultFamily: string;
  readonly familyId: string;
  readonly labelerId: string;
  readonly pageContext: boolean;
  readonly detailLayout: "wide" | "detail";
  readonly mediaPresentation: string;
  readonly actionLabels?: Readonly<Record<string, string>>;
  readonly titleRule?: ToolTitleRule;
}

export function defineToolMetadata(title: string, sets: readonly string[] = [], options: Partial<ToolMetadata> = {}): ToolMetadata {
  return Object.freeze({
    title,
    ...(options.shortTitle ? { shortTitle: options.shortTitle } : {}),
    sets: Object.freeze([...(sets || []), ...(options.sets || [])]),
    profileFamily: options.profileFamily || "",
    resultFamily: options.resultFamily || "generic",
    familyId: options.familyId || "other",
    labelerId: options.labelerId || "static",
    pageContext: Boolean(options.pageContext),
    detailLayout: options.detailLayout === "wide" ? "wide" : "detail",
    mediaPresentation: ["asset", "capture"].includes(options.mediaPresentation || "") ? options.mediaPresentation || "" : "",
    ...(options.actionLabels ? { actionLabels: Object.freeze({ ...options.actionLabels }) } : {}),
    ...(options.titleRule ? { titleRule: Object.freeze({ ...options.titleRule, values: Object.freeze({ ...options.titleRule.values }) }) } : {}),
  });
}
