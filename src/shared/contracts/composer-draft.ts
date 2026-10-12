/** Background preserves attachment records while parsing is in flight. Each client validates its own projection. */
export interface ComposerDraft<Image = Record<string, unknown>, Document = Record<string, unknown>> {
  sessionId: string | null;
  messageId: string;
  text: string;
  images: Image[];
  documents: Document[];
  updatedAt: number;
}
