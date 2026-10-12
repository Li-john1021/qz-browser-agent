import assert from "node:assert/strict";
import { parseExportHtmlFixture } from "../benchmarks/conversation-render/tools/export-html-fixture.mjs";

const fixture = parseExportHtmlFixture(`<!doctype html>
<title>Current export</title>
<main id="messages">
  <div class="msg msg-user" data-transcript-type="user">
    <div class="msg-user-row"><div class="msg-content">第一条消息</div></div>
  </div>
  <div class="msg msg-assistant" data-transcript-type="assistant">
    <div class="msg-content"><p>最后一条回复</p></div>
  </div>
</main>
<script>window.exportRuntimeMustNotBecomeTranscript = true;</script>`);

assert.equal(fixture.title, "Current export");
assert.deepEqual(fixture.transcript, [
  { type: "user", text: "第一条消息", images: [], timestamp: "" },
  { type: "assistant", content: "最后一条回复", timestamp: "" },
]);

const legacy = parseExportHtmlFixture(`
<section class="msg user"><div class="msg-content">旧版消息</div></section>
`);
assert.equal(legacy.transcript[0]?.text, "旧版消息");

const embedded = parseExportHtmlFixture(`
<title>Rendered title</title>
<script id="qingzhou-session-exchange" type="application/json">{"format":"qingzhou.session","version":1,"source":{"sessionId":"original-session"},"session":{"title":"Exchange title","transcript":[{"type":"assistant","content":"完整原始回复"}]}}</script>
<main id="messages"><div class="msg msg-assistant"><div class="msg-content">压缩后的展示</div></div></main>
`);
assert.equal(embedded.sessionId, "original-session");
assert.equal(embedded.title, "Exchange title");
assert.deepEqual(embedded.transcript, [{ type: "assistant", content: "完整原始回复" }]);

console.log("export HTML fixture parser tests passed");
