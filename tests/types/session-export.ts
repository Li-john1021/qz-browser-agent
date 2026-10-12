/// <reference types="chrome" />
import { createSessionExportFeature } from "../../src/sidepanel/features/export/session-export-feature.js";

const exporter = createSessionExportFeature({
  request: async () => ({ payload: {} }),
  renderChatHtml: () => "",
});
void exporter.createDocumentFromSnapshot({
  session: { id: "saved", title: "Saved" },
  conversation: { version: 1, entries: [] },
  transcript: [{ type: "assistant", content: "Saved" }],
  runtime: { status: "done" },
});

// @ts-expect-error export requests carry a structured session id payload
createSessionExportFeature({ request: (type: number) => Promise.resolve({ payload: {} }), renderChatHtml: () => "" });
