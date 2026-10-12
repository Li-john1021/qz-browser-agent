import { test, expect } from "./fixtures.mjs";
import { installBenchmarkChromeStub } from "./benchmark-chrome-stub.mjs";

test("document stores preserve ownership limits and separate attachment metadata from artifacts", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const store = await import("/extension/shared/documents/document-store.js");
    const owner = { sessionId: "s".repeat(130), runId: "r".repeat(130), toolCallId: "t".repeat(130), sourceTool: "x".repeat(130),
      messageId: "m".repeat(170), attachmentId: "a".repeat(170), createdAt: "2020-01-02 03:04:05", updatedAt: "obsolete" };
    const summaries = await Promise.all([
      store.saveDocumentFile({ ...owner, id: "owned-file", base64: "AAEC" }),
      store.saveDocumentModel({ ...owner, id: "owned-model", fileId: "owned-file" }),
      store.saveDocumentArtifact({ ...owner, id: "owned-artifact", base64: "AAEC" }),
    ]);
    const records = await Promise.all([store.getDocumentFile("owned-file"), store.getDocumentModel("owned-model"), store.getDocumentArtifact("owned-artifact")]);
    const legacy = { id: "legacy", sessionId: "s".repeat(130), createdAt: owner.createdAt };
    return { summaries, records, legacySummary: store.summarizeModelRecord(legacy), legacy };
  });
  for (const records of [result.records, result.summaries]) {
    for (const record of records) {
      for (const [key, character] of Object.entries({ sessionId: "s", runId: "r", toolCallId: "t", sourceTool: "x" })) expect(record[key]).toBe(character.repeat(120));
      expect(record.createdAt).toBe("2020-01-02 03:04:05");
      expect(record.updatedAt).not.toBe("obsolete");
    }
    for (const record of records.slice(0, 2)) {
      expect(record.messageId).toBe("m".repeat(160));
      expect(record.attachmentId).toBe("a".repeat(160));
    }
    expect(records[2]).not.toHaveProperty("messageId");
    expect(records[2]).not.toHaveProperty("attachmentId");
  }
  expect(result.records[0].base64).toBe("AAEC");
  expect(result.records[2].base64).toBe("AAEC");
  for (const summary of result.summaries) expect(summary).not.toHaveProperty("base64");
  expect(result.legacySummary).toMatchObject({ sessionId: "s".repeat(130), runId: "", toolCallId: "", sourceTool: "" });
  expect(result.legacy).not.toHaveProperty("runId");
});

test("Side Panel reads document formats without loading document algorithms or PDF workers", async ({ page }, testInfo) => {
  const requests = [];
  page.on("request", request => requests.push(new URL(request.url()).pathname));
  await page.addInitScript(installBenchmarkChromeStub, { benchmark: false });
  await page.goto("/extension/sidepanel/sidepanel.html");
  await expect(page.locator("#app")).not.toHaveAttribute("data-workspace-booting");
  await expect(page.locator("#input")).toBeVisible();
  expect(requests).toContain("/extension/shared/documents/document-codec-definitions.js");
  expect(requests.filter(path => /\/document-(?:codecs|utils)\.js$|\/pdf(?:\.worker)?\.mjs$/.test(path))).toEqual([]);
  await testInfo.attach("sidepanel-module-requests", { body: JSON.stringify(requests, null, 2), contentType: "application/json" });
});
