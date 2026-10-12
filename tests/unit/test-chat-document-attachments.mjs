import assert from "node:assert/strict";
import {
  assertMessageDocumentOwnership,
  normalizeMessageDocuments,
} from "../../src/shared/documents/document-attachments.js";
import { createChatDocumentAttachmentService } from "../../src/background/services/chat-document-attachments.js";
import { inferDocumentFormat, parseDocumentBytes } from "../../src/shared/documents/document-codecs.js";
import {
  serializeConversation,
  transcriptFromConversation,
} from "../../src/shared/session/session-codec.js";

const base = {
  sessionId: "session-a",
  messageId: "message-a",
  attachmentId: "attachment-a",
  fileId: "file-a",
  docModelId: "model-a",
  filename: "very-long-source-file-name.py",
  mimeType: "text/x-python",
  format: "code",
  size: 128,
};

assert.deepEqual(normalizeMessageDocuments([base, base]), [base]);
assert.deepEqual(
  assertMessageDocumentOwnership([base], { sessionId: "session-a", messageId: "message-a" }),
  [base],
);
assert.throws(
  () => assertMessageDocumentOwnership([base], { sessionId: "session-b", messageId: "message-a" }),
  error => error.code === "DOCUMENT_ATTACHMENT_OWNER_MISMATCH",
);
assert.throws(
  () => assertMessageDocumentOwnership([base, base], { sessionId: "session-a", messageId: "message-a" }),
  error => error.code === "DOCUMENT_ATTACHMENT_INVALID",
  "duplicate attachment identities must not be silently accepted at a write boundary",
);

for (const [filename, language] of [["sample.py", "python"], ["sample.js", "javascript"], ["sample.cpp", "cpp"]]) {
  assert.equal(inferDocumentFormat({ filename }), "txt");
  const model = await parseDocumentBytes(new TextEncoder().encode("const answer = 42;\n"), { filename });
  assert.equal(model.type, "code");
  assert.equal(model.blocks[0].language, language);
}

const hiddenCapsule = {
  role: "user",
  content: "[文档附件 capsule]",
  _origin: "context_capsule",
  _kind: "context_capsule",
  _contextCapsule: { reason: "document_attachment" },
};
const conversation = serializeConversation([
  hiddenCapsule,
  { role: "user", content: "", clientMessageId: "message-a", documents: [base] },
]);
assert.deepEqual(transcriptFromConversation(conversation), [{
  type: "user",
  text: "",
  images: [],
  documents: [base],
  clientMessageId: "message-a",
  timestamp: conversation.entries[1].timestamp,
}]);

const writes = [];
const deletes = [];
const batchDeletes = [];
const sessionDeletes = [];
const traces = [];
const service = createChatDocumentAttachmentService({
  sessionRepository: { getMetadata: async id => id === "session-a" ? { id } : null },
  trace: line => traces.push(line),
  base64ToBytes: value => new Uint8Array([String(value).length]),
  parseDocumentBytes: async () => ({
    type: "code",
    title: "example",
    blocks: [{ type: "code", text: "print('ok')" }],
    sheets: [],
    chunks: [],
    outline: [],
    warnings: [],
  }),
  saveDocumentFile: async record => {
    writes.push(["file", record]);
    return {
      fileId: record.id,
      filename: record.filename,
      mimeType: record.mimeType,
      extension: record.extension,
      size: record.size,
    };
  },
  saveDocumentModel: async record => {
    writes.push(["model", record]);
    return { docModelId: record.id, type: record.type, warnings: record.warnings };
  },
  deleteMessageDocument: async record => {
    deletes.push(record);
    return { deletedFile: true, deletedModel: true };
  },
  deleteMessageDocuments: async record => {
    batchDeletes.push(record);
    return { deletedFileCount: record.documents.length, deletedModelCount: record.documents.length };
  },
  deleteSessionMessageDocuments: async sessionId => {
    sessionDeletes.push(sessionId);
    return { deletedFileCount: 3, deletedModelCount: 2 };
  },
});

await assert.rejects(
  service.stage({ ...base, base64: undefined }),
  error => error.code === "DOCUMENT_ATTACHMENT_INVALID",
);
assert.equal(writes.length, 0, "invalid requests must fail before storage writes");
traces.length = 0;

const staged = await service.stage({ ...base, base64: "cHJpbnQoJ29rJyk=" });
assert.deepEqual(staged.document, base);
assert.equal(writes.length, 2);
assert.deepEqual(
  traces
    .filter(line => line.includes("action=stage"))
    .map(line => line.match(/ phase=([^ ]+)/)?.[1])
    .filter(Boolean),
  ["received", "session_validated", "file_saved", "decoded", "parsed", "model_saved", "ready"],
  "successful staging should leave a complete low-volume diagnostic trail",
);
assert.doesNotMatch(traces.join("\n"), /cHJpbnQoJ29rJyk=/, "attachment trace must not record file content");
for (const [, record] of writes) {
  assert.equal(record.sessionId, base.sessionId);
  assert.equal(record.messageId, base.messageId);
  assert.equal(record.attachmentId, base.attachmentId);
  assert.equal(record.sourceTool, "chat_attachment");
}
await assert.rejects(
  service.stage({ ...base, sessionId: "session-b", base64: "eA==" }),
  error => error.code === "SESSION_NOT_FOUND",
);
assert.equal(writes.length, 2, "a missing Session must fail before any document write");

const emptyRemoval = await service.removeMessageDocuments({
  sessionId: base.sessionId,
  messageId: base.messageId,
  documents: [],
});
assert.deepEqual(emptyRemoval, {
  removed: false,
  attachmentCount: 0,
  deletedFileCount: 0,
  deletedModelCount: 0,
});
assert.equal(batchDeletes.length, 0, "an empty message cleanup must not open the Store boundary");

const second = {
  ...base,
  attachmentId: "attachment-b",
  fileId: "file-b",
  docModelId: "model-b",
  filename: "second.cpp",
};
const batchRemoved = await service.removeMessageDocuments({
  sessionId: base.sessionId,
  messageId: base.messageId,
  documents: [base, second],
});
assert.deepEqual(batchRemoved, {
  removed: true,
  attachmentCount: 2,
  deletedFileCount: 2,
  deletedModelCount: 2,
});
assert.deepEqual(batchDeletes, [{
  sessionId: base.sessionId,
  messageId: base.messageId,
  documents: [base, second],
}]);
await assert.rejects(
  service.removeMessageDocuments({
    sessionId: "session-b",
    messageId: base.messageId,
    documents: [base],
  }),
  error => error.code === "DOCUMENT_ATTACHMENT_OWNER_MISMATCH",
);
assert.equal(batchDeletes.length, 1, "ownership mismatch must fail before the Store boundary");
assert.deepEqual(await service.removeSessionDocuments("session-a"), {
  deletedFileCount: 3,
  deletedModelCount: 2,
});
assert.deepEqual(sessionDeletes, ["session-a"]);

await assertStageFailureCleanupMatrix();
await assertCancellationBeforeFirstWrite();
await assertConcurrentStageJoins();
await assertSessionBlockCancelsActiveStages();

let releaseParse;
let parseStarted;
const parseStartedPromise = new Promise(resolve => { parseStarted = resolve; });
const cancellable = createChatDocumentAttachmentService({
  sessionRepository: { getMetadata: async () => ({ id: "session-a" }) },
  base64ToBytes: () => new Uint8Array([1]),
  parseDocumentBytes: async () => {
    parseStarted();
    await new Promise(resolve => { releaseParse = resolve; });
    return { type: "txt", title: "x", blocks: [], sheets: [], chunks: [], outline: [], warnings: [] };
  },
  saveDocumentFile: async record => ({ fileId: record.id, filename: record.filename, mimeType: record.mimeType, size: record.size }),
  saveDocumentModel: async record => ({ docModelId: record.id, type: record.type }),
  deleteMessageDocument: async record => {
    deletes.push(record);
    return { deletedFile: true, deletedModel: false };
  },
});
const pendingStage = cancellable.stage({ ...base, base64: "eA==" });
await parseStartedPromise;
const removed = await cancellable.remove(base);
assert.equal(removed.removed, true);
releaseParse();
await assert.rejects(pendingStage, error => error.code === "DOCUMENT_ATTACHMENT_REMOVED");
assert.ok(deletes.some(record => record.messageId === base.messageId));

console.log("chat document attachment tests passed");

async function assertStageFailureCleanupMatrix() {
  const scenarios = [
    { failureAt: "save-file", expected: ["save-file"] },
    { failureAt: "decode", expected: ["save-file", "decode", "delete"] },
    { failureAt: "parse", cleanupThrows: true, expected: ["save-file", "decode", "parse", "delete"] },
    { failureAt: "save-model", expected: ["save-file", "decode", "parse", "save-model", "delete"] },
  ];

  for (const scenario of scenarios) {
    const operations = [];
    const traces = [];
    const failure = Object.assign(new Error(`failed at ${scenario.failureAt}`), { code: `FAIL_${scenario.failureAt}` });
    const failing = createChatDocumentAttachmentService({
      sessionRepository: { getMetadata: async () => ({ id: base.sessionId }) },
      trace: line => traces.push(line),
      saveDocumentFile: async record => {
        operations.push("save-file");
        if (scenario.failureAt === "save-file") throw failure;
        return { fileId: record.id, filename: record.filename, mimeType: record.mimeType, size: record.size };
      },
      base64ToBytes: () => {
        operations.push("decode");
        if (scenario.failureAt === "decode") throw failure;
        return new Uint8Array([1]);
      },
      parseDocumentBytes: async () => {
        operations.push("parse");
        if (scenario.failureAt === "parse") throw failure;
        return { type: "txt", title: "x", blocks: [], sheets: [], chunks: [], outline: [], warnings: [] };
      },
      saveDocumentModel: async record => {
        operations.push("save-model");
        if (scenario.failureAt === "save-model") throw failure;
        return { docModelId: record.id, type: record.type };
      },
      deleteMessageDocument: async () => {
        operations.push("delete");
        if (scenario.cleanupThrows) throw new Error("cleanup also failed");
        return { deletedFile: true, deletedModel: false };
      },
    });

    await assert.rejects(
      failing.stage({ ...base, base64: "eA==" }),
      error => error === failure,
      `${scenario.failureAt} should preserve the original failure`,
    );
    assert.deepEqual(operations, scenario.expected, `${scenario.failureAt} cleanup sequence is incorrect`);
    const failureTrace = traces.find(line => line.includes(" phase=failed"));
    assert.ok(failureTrace, `${scenario.failureAt} should leave a failure trace`);
    assert.match(failureTrace, new RegExp(` code=FAIL_${scenario.failureAt}`));
    if (scenario.failureAt !== "save-file") {
      assert.ok(
        traces.some(line => line.includes(` phase=cleanup_${scenario.cleanupThrows ? "failed" : "completed"}`)),
        `${scenario.failureAt} should trace cleanup outcome`,
      );
    }
  }
}

async function assertCancellationBeforeFirstWrite() {
  let releaseMetadata;
  let metadataStarted;
  let saveCount = 0;
  const metadataStartedPromise = new Promise(resolve => { metadataStarted = resolve; });
  const metadataPromise = new Promise(resolve => { releaseMetadata = resolve; });
  const earlyCancelled = createChatDocumentAttachmentService({
    sessionRepository: {
      async getMetadata() {
        metadataStarted();
        return metadataPromise;
      },
    },
    saveDocumentFile: async record => {
      saveCount += 1;
      return { fileId: record.id };
    },
    deleteMessageDocument: async () => ({ deletedFile: false, deletedModel: false }),
  });

  const pending = earlyCancelled.stage({ ...base, base64: "eA==" });
  await metadataStartedPromise;
  assert.equal((await earlyCancelled.remove(base)).removed, false);
  releaseMetadata({ id: base.sessionId });
  await assert.rejects(pending, error => error.code === "DOCUMENT_ATTACHMENT_REMOVED");
  assert.equal(saveCount, 0, "cancellation before Session lookup completes must prevent the first write");
}

async function assertConcurrentStageJoins() {
  let releaseParse;
  let parseStarted;
  let parseCount = 0;
  let fileWrites = 0;
  let modelWrites = 0;
  const traces = [];
  const parseStartedPromise = new Promise(resolve => { parseStarted = resolve; });
  const joined = createChatDocumentAttachmentService({
    sessionRepository: { getMetadata: async () => ({ id: base.sessionId }) },
    trace: line => traces.push(line),
    base64ToBytes: () => new Uint8Array([1]),
    parseDocumentBytes: async () => {
      parseCount += 1;
      parseStarted();
      await new Promise(resolve => { releaseParse = resolve; });
      return { type: "txt", title: "x", blocks: [], sheets: [], chunks: [], outline: [], warnings: [] };
    },
    saveDocumentFile: async record => {
      fileWrites += 1;
      return { fileId: record.id, filename: record.filename, mimeType: record.mimeType, size: record.size };
    },
    saveDocumentModel: async record => {
      modelWrites += 1;
      return { docModelId: record.id, type: record.type };
    },
  });
  const first = joined.stage({ ...base, base64: "eA==" });
  await parseStartedPromise;
  const second = joined.stage({ ...base, base64: "eA==" });
  releaseParse();
  assert.deepEqual(await second, await first);
  assert.deepEqual(
    { parseCount, fileWrites, modelWrites },
    { parseCount: 1, fileWrites: 1, modelWrites: 1 },
    "same attachment identity must share one parse pipeline",
  );
  assert.ok(traces.some(line => line.includes(" phase=joined")));
}

async function assertSessionBlockCancelsActiveStages() {
  let releaseParse;
  let parseStarted;
  let parseCount = 0;
  let modelWrites = 0;
  let cleanups = 0;
  const started = new Promise(resolve => { parseStarted = resolve; });
  const service = createChatDocumentAttachmentService({
    sessionRepository: { getMetadata: async () => ({ id: base.sessionId }) },
    base64ToBytes: () => new Uint8Array([1]),
    parseDocumentBytes: async () => {
      parseCount += 1;
      if (parseCount === 1) {
        parseStarted();
        await new Promise(resolve => { releaseParse = resolve; });
      }
      return { type: "txt", title: "x", blocks: [], sheets: [], chunks: [], outline: [], warnings: [] };
    },
    saveDocumentFile: async record => ({ fileId: record.id, filename: record.filename }),
    saveDocumentModel: async record => {
      modelWrites += 1;
      return { docModelId: record.id, type: record.type };
    },
    deleteMessageDocument: async () => {
      cleanups += 1;
      return { deletedFile: true, deletedModel: false };
    },
  });

  const pending = service.stage({ ...base, base64: "eA==" });
  const rejected = assert.rejects(pending, error => error.code === "SESSION_DELETED");
  await started;
  const blocking = service.blockSession(base.sessionId);
  releaseParse();
  const [release] = await Promise.all([blocking, rejected]);
  assert.deepEqual({ modelWrites, cleanups }, { modelWrites: 0, cleanups: 1 });
  await assert.rejects(
    service.stage({ ...base, attachmentId: "blocked", base64: "eA==" }),
    error => error.code === "SESSION_DELETED",
  );

  release();
  const resumed = await service.stage({ ...base, attachmentId: "resumed", base64: "eA==" });
  assert.equal(resumed.document.attachmentId, "resumed");
}
