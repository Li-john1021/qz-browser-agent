import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { ensureTestExtension } from '../support/extension-build.mjs';
import { readTestApiKey } from '../support/local-credentials.mjs';

// Explicit live entrypoint: synthetic page and isolated profile, real DeepSeek only.
const { values } = parseArgs({ options: { steps: { type: 'string', default: '9' } } });
const steps = Number(values.steps);
assert.ok(Number.isInteger(steps) && steps >= 9 && steps <= 64, '--steps must be an integer from 9 to 64');
const apiKey = readTestApiKey('deepseek', { keyFile: process.env.QINGZHOU_DEEPSEEK_AK_FILE || '' });
const model = process.env.QINGZHOU_DEEPSEEK_MODEL || 'deepseek-flash';
const output = resolve('tests/results/deepseek-vision', ...(steps === 9 ? [] : [`retention-${steps}`]));
const reportPath = join(output, 'retention.json');
const extension = await ensureTestExtension();
const html = await readFile(new URL('../fixtures/vision-image-retention.html', import.meta.url));
const server = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(html));
const report = { model, steps, viewport: { width: 2560, height: 1440 }, isolated: true, scrollCoverage: false, checks: {}, passed: false };
let context, page, worker, profile;
const redact = value => String(value).split(apiKey).join('[redacted]');
const deadline = setTimeout(() => { report.watchdogExpired = true; void context?.close().catch(() => {}); }, 660000);
try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/visual-retention?steps=${steps}`;
  profile = await mkdtemp(join(tmpdir(), 'qingzhou-deepseek-vision-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, executablePath: chromium.executablePath(), viewport: report.viewport, locale: 'en-US',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  await worker.evaluate(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.__visionRequests = [];
    globalThis.fetch = async (input, init) => {
      let record;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.hostname === 'api.deepseek.com' && typeof init?.body === 'string') {
        const body = JSON.parse(init.body);
        const messages = body.messages || [];
        if (JSON.stringify(messages).includes('QZ_VISION_RETENTION')) {
          const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
          record = { at: Date.now(), requestBytes: new TextEncoder().encode(init.body).byteLength,
            images: parts.filter(part => part.type === 'image_url').length,
            imageMessages: messages.filter(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')).length,
            placeholders: parts.filter(part => part.type === 'text' && String(part.text).includes('[image omitted for context saving]')).length };
          globalThis.__visionRequests.push(record);
        }
      }
      const response = await nativeFetch(input, init);
      if (record) record.status = response.status;
      return response;
    };
  });
  page = await context.newPage();
  await page.exposeFunction('__reportVisionProgress', progress => console.log(JSON.stringify({ progress: true, steps, ...progress })));
  await page.goto(new URL('/sidepanel/sidepanel.html', worker.url()).href);
  await page.waitForFunction(() => document.querySelector('#input') && !document.querySelector('#app')?.hasAttribute('data-workspace-booting'));
  await page.evaluate(installHarness);
  await page.evaluate(async config => {
    const response = await window.__visionHarness.request('save_config', { config });
    if (response.type !== 'config_saved') throw new Error(response.message || 'configuration failed');
  }, { provider: 'deepseek', model, apiKey, vision: true, contextWindow: 128000, trimOldToolResults: true, debugMode: false });
  const created = await page.evaluate(() => window.__visionHarness.request('create_ui_session', { title: 'Synthetic visual retention regression' }));
  const sessionId = created.session.id;
  report.sessionId = sessionId;
  await page.evaluate(({ sessionId, url, steps }) => window.__visionHarness.send({ type: 'prompt', sessionId,
    text: `QZ_VISION_RETENTION：打开 ${url}，完成画布上的${steps}步视觉点击测试。每步只点击当前蓝色圆形，点击成功后蓝圆会换位置。必须使用 screenshot(actionable:true,maxWidth:2048,maxHeight:2048) 观察当前画面，再调用 act_on_screen(action:"click",returnScreenshot:false) 点击截图中的像素坐标。每步都单独截图、观察、点击；不要并发或把多步放进run_script，不要凭之前的位置规律推断下一步。不得读取网页脚本、canvas像素或隐藏状态，也不要使用DOM脚本点击。页面结构可先正常查看一次。连续完成${steps}次，最后截图看到DONE后停止，简短报告。` }), { sessionId, url, steps });
  const terminal = await page.evaluate(sessionId => window.__visionHarness.waitForTerminal(sessionId), sessionId);
  assert.equal(terminal.type, 'agent_end', terminal.message || 'agent did not finish');
  const target = context.pages().find(candidate => candidate.url() === url);
  assert.ok(target, 'the model must open the constructed page');
  report.page = await target.evaluate(() => window.__readVisionRetentionState());
  report.sourceViewport = await target.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio }));
  report.tools = await page.evaluate(sessionId => window.__visionHarness.tools.filter(event => event.sessionId === sessionId), sessionId);
  report.requests = await worker.evaluate(() => globalThis.__visionRequests);
  const screenshots = report.tools.filter(event => event.toolName === 'screenshot' && !event.isError);
  const clicks = report.tools.filter(event => event.toolName === 'act_on_screen' && event.args?.action === 'click' && !event.isError);
  assert.equal(report.page.steps, steps);
  assert.equal(report.page.completed, steps, 'every real browser target must be clicked');
  assert.equal(report.page.misses, 0, 'scaled image coordinates must hit the intended targets');
  assert.ok(screenshots.length >= steps);
  assert.equal(clicks.length, steps, 'each stage must use exactly one screenshot-based click');
  assert.equal(report.tools.some(event => event.isError), false, 'no tool failure is expected');
  assert.ok(screenshots.every(event => event.result.width === 2048 && event.result.height === 1152), '2560×1440 screenshots must be resized to 2048×1152');
  assert.deepEqual(report.sourceViewport, { width: 2560, height: 1440, deviceScaleFactor: 1 });
  assert.ok(screenshots.every(event => event.result.bytes <= 2 * 1024 * 1024));
  assert.ok(screenshots.every(event => event.result.coordinateSpace?.width === 2048 && event.result.coordinateSpace?.height === 1152));
  assert.equal(report.tools.some(event => ['run_script', 'read_dom', 'act_on_element'].includes(event.toolName)), false, 'acceptance must come from screenshot-based actions');
  const pruned = report.requests.find(request => request.placeholders > 0 && request.images === 8);
  assert.ok(pruned, 'a real DeepSeek request must observe the eight-message image window');
  assert.ok(report.page.clicks.at(-1).at > pruned.at, 'the final successful click must follow a model request containing an omitted-image placeholder');
  assert.ok(report.requests.every(request => request.imageMessages <= 8));
  assert.ok(report.requests.every(request => request.status === 200), 'every captured model request must succeed');
  assert.equal(new Set(clicks.map(event => event.result.sourceScreenshotId)).size, steps, 'every click must use a fresh actionable screenshot');
  report.pruningCheckpoints = [];
  for (let index = 0; index < steps; index++) {
    assert.ok(screenshots.some(event => event.result.screenshotId === clicks[index].result.sourceScreenshotId));
    assert.ok(Math.abs(report.page.clicks[index].x - clicks[index].args.x * 1.25) <= 2);
    assert.ok(Math.abs(report.page.clicks[index].y - clicks[index].args.y * 1.25) <= 2);
    if (index >= 8) {
      const beforeClick = report.requests.findLast(request => request.at < report.page.clicks[index].at);
      assert.ok(beforeClick?.images === 8 && beforeClick.placeholders >= index - 7,
        `stage ${index + 1} must continue after the image window advances`);
      report.pruningCheckpoints.push({ stage: index + 1, images: beforeClick.images,
        placeholders: beforeClick.placeholders, requestAt: beforeClick.at, clickAt: report.page.clicks[index].at });
    }
  }
  report.imageEvidence = { screenshots: screenshots.length, largestBytes: Math.max(...screenshots.map(event => event.result.bytes)),
    totalBytes: screenshots.reduce((total, event) => total + event.result.bytes, 0),
    maximumRequestBytes: Math.max(...report.requests.map(request => request.requestBytes)),
    maximumPlaceholders: Math.max(...report.requests.map(request => request.placeholders)) };
  report.checks = { allStagesCompleted: true, zeroMisclicks: true, allToolsSuccessful: true,
    freshScreenshotForEachClick: true, resizedTo2048: true, imageBytesWithinLimit: true,
    sourceViewport2560: true, coordinateMappingCorrect: true, screenshotActionsOnly: true,
    imageMessageWindowAtMost8: true, continuedAfterEveryEviction: true, allProviderResponses200: true };
  await target.screenshot({ path: join(output, 'retention-final.png') });
  report.passed = true;
} catch (error) {
  report.error = redact(error.stack || error);
  if (worker) report.requests = await worker.evaluate(() => globalThis.__visionRequests).catch(() => []);
  if (page && !page.isClosed()) report.tools = await page.evaluate(() => window.__visionHarness?.tools || []).catch(() => []);
  throw new Error(report.error);
} finally {
  clearTimeout(deadline);
  try {
    await writeFile(reportPath, redact(JSON.stringify(report, null, 2)));
  } finally {
    await context?.close().catch(() => {});
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (profile) await rm(profile, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ passed: report.passed, model, steps, clicks: report.page?.completed, requests: report.requests?.length,
    screenshots: report.tools?.filter(item => item.toolName === 'screenshot').length, report: reportPath }));
}

async function installHarness() {
  const { createPortTransport } = await import(chrome.runtime.getURL('shared/transport/port-transport.js'));
  const port = chrome.runtime.connect({ name: 'sidepanel' });
  const tools = [], terminals = [], imageReads = [], pending = new Map();
  let sequence = 0;
  const transport = createPortTransport({ postMessage: message => port.postMessage(message), onMessage: message => {
    if (message.type === 'dynamic_context_request') void transport.send({ type: 'dynamic_context_response', requestId: message.requestId, context: {} });
    const waiter = pending.get(message.requestId);
    if (waiter) { pending.delete(message.requestId); clearTimeout(waiter.timer); waiter.resolve(message); }
    if (message.type === 'tool_execution_end') {
      const result = message.result || {};
      const entry = { sessionId: message.sessionId, toolName: message.toolName, isError: message.isError, args: message.args,
        result: { width: result.width, height: result.height, screenshotId: result.screenshotId, sourceScreenshotId: result.sourceScreenshotId,
          coordinateSpace: result.coordinateSpace, sourceCoordinateSpace: result.sourceCoordinateSpace, code: result.code, error: result.error } };
      tools.push(entry);
      if (message.toolName === 'act_on_screen' && message.args?.action === 'click' && !message.isError) {
        const completedClickTools = tools.filter(item => item.toolName === 'act_on_screen' && item.args?.action === 'click' && !item.isError).length;
        if (completedClickTools % 8 === 0) void window.__reportVisionProgress({ completedClickTools,
          screenshotTools: tools.filter(item => item.toolName === 'screenshot').length }).catch(() => {});
      }
      if (message.toolName === 'screenshot' && typeof result._image === 'string') imageReads.push((async () => {
        const blob = await (await fetch(result._image)).blob();
        const bitmap = await createImageBitmap(blob);
        Object.assign(entry.result, { width: bitmap.width, height: bitmap.height, bytes: blob.size });
        bitmap.close();
      })());
    }
    if (['agent_end', 'error', 'waiting_for_user'].includes(message.type)) terminals.push({ type: message.type, sessionId: message.sessionId, message: message.message });
  } });
  port.onMessage.addListener(transport.receive);
  port.onDisconnect.addListener(() => transport.dispose());
  window.__visionHarness = { tools, send: message => transport.send(message),
    request(type, payload) {
      const requestId = `vision_${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out`)); }, 60000);
        pending.set(requestId, { resolve, timer });
        void transport.send({ type, ...payload, requestId }).catch(reject);
      });
    },
    async waitForTerminal(sessionId) {
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        const terminal = terminals.find(item => item.sessionId === sessionId);
        if (terminal) { await Promise.all(imageReads); return terminal; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error('visual run timed out');
    },
  };
}
