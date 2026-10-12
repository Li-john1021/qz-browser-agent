import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { ensureTestExtension } from '../support/extension-build.mjs';
import { generateLargeImage, collectionToolCall, collectionRequestSummary,
  COLLECTION_IMAGE_COUNT, COLLECTION_IMAGE_WIDTH, COLLECTION_IMAGE_HEIGHT, COLLECTION_MARKER,
} from '../fixtures/large-image-conversation.mjs';

const { values } = parseArgs({ options: {
  cases: { type: 'string', default: 'single,history,stream' },
  'output-dir': { type: 'string', default: 'tests/results/large-image-conversation' },
  'max-errors': { type: 'string', default: '6' },
  headed: { type: 'boolean', default: false },
  verify: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: npm run benchmark -- images [--cases single,history,stream,collect] [--output-dir path] [--max-errors 1..10] [--headed] [--verify]\nDefault: single,history,stream. collect performs 40 real image reads and cancels the 41st.');
  process.exit(0);
}
const cases = values.cases.split(',');
const maxErrors = Number(values['max-errors']);
if (cases.some(name => !['single', 'history', 'stream', 'collect'].includes(name)) || !cases.length) throw new Error('Unknown image reproduction case');
if (!Number.isInteger(maxErrors) || maxErrors < 1 || maxErrors > 10) throw new Error('--max-errors must be 1..10');
const output = resolve(values['output-dir']);
const MiB = 1024 * 1024;
const report = { verify: values.verify, startedAt: new Date().toISOString(), node: process.version, maxErrors,
  isolation: 'Temporary extension build and browser profiles; synthetic PNGs; loopback model only.',
  instrumentation: 'Observe native ports; suppress further uncorrelated get_messages after the error cap. No fabricated transport errors.',
  cases: [], passed: false };
await mkdir(output, { recursive: true });
const extension = await ensureTestExtension();
const fixture = await startFixtureServer();
try {
  for (const name of cases) {
    console.log(`[images] ${name}: starting isolated Chrome`);
    const result = await runCase(name);
    report.cases.push(result);
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(summarizeCase(result)));
  }
  report.passed = values.verify;
} finally {
  await fixture.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(`[images] report: ${join(output, 'report.json')}`);

function summarizeCase(result) {
  return {
    name: result.name, verified: result.verified === true, reproduced: result.reproduced,
    inputImages: result.input?.count ?? result.input?.imageCount ?? 1,
    inputBytes: result.input?.wireBytes ?? result.input?.restoreBytes,
    normalizedUpload: result.normalizedUpload,
    snapshot: result.snapshot && { bytes: result.snapshot.bytes, elapsedMs: result.snapshot.elapsedMs,
      storedImages: result.snapshot.storedImageCount, transcriptImages: result.snapshot.transcriptImageCount,
      storedPlaceholders: result.snapshot.storedPlaceholderCount },
    providerRequests: result.provider?.length, retainedImages: result.provider?.at(-1)?.imageCount,
    uniqueImages: result.uniqueImageHashes?.length,
    maxControlResponseMs: result.controls?.length ? Math.max(...result.controls.map(control => control.elapsedMs)) : undefined,
    stop: result.stop, smallRequest: result.smallRequestAfterFailure,
    errors: result.observed && { size: result.observed.sizeErrors, cards: result.observed.errorCards,
      suppressedRequests: result.observed.suppressedRequests, messages: result.observed.errors.slice(0, 3) },
    crashes: result.crashes, screenshot: result.screenshot,
  };
}

async function runCase(name) {
  const profile = await mkdtemp(join(tmpdir(), 'qz-large-image-repro-'));
  let context;
  let page;
  const result = { name, crashes: [], console: [] };
  const deadline = setTimeout(() => {
    result.watchdogExpired = true;
    void context?.close().catch(() => {});
  }, name === 'collect' ? 240000 : 120000);
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: !values.headed, executablePath: chromium.executablePath(), locale: 'zh-CN',
      viewport: { width: 720, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--lang=zh-CN', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    report.browser = context.browser()?.version() || chromium.executablePath();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return ['chrome-extension:', 'data:', 'blob:'].includes(url.protocol) || url.origin === fixture.origin
        ? route.continue() : route.abort();
    });
    await context.addInitScript(installObserver, { maxErrors });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    page = await context.newPage();
    page.on('crash', () => result.crashes.push('sidepanel-renderer'));
    page.on('pageerror', error => result.console.push(String(error).slice(0, 500)));
    page.on('console', message => {
      if (['warning', 'error'].includes(message.type()) && result.console.length < 30) result.console.push(message.text().slice(0, 500));
    });
    await page.goto(new URL('/sidepanel/sidepanel.html', worker.url()).href);
    await page.waitForFunction(() => document.querySelector('#app') && !document.querySelector('#app').hasAttribute('data-workspace-booting'), null, { timeout: 20000 });
    await page.evaluate(installControlPort);

    if (name === 'single') {
      result.input = await page.evaluate(async origin => {
        const image = await fetch(`${origin}/image?width=4096`).then(response => response.json());
        const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob());
        const decoded = { width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const created = await window.__imageControl.request('create_ui_session', { title: 'Single oversized synthetic image' });
        const payload = { type: 'prompt', sessionId: created.session.id, text: 'Synthetic single image', images: [{ dataUrl: image.dataUrl, type: 'image/png', name: 'noise.png' }] };
        const wireBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
        const started = performance.now();
        let error = '';
        try { window.__imageControl.port.postMessage(payload); } catch (cause) { error = String(cause.message || cause); }
        const state = await window.__imageControl.request('get_state', { sessionId: created.session.id });
        return { ...decoded, encodedBytes: image.encodedBytes, dataUrlBytes: image.dataUrlBytes, wireBytes,
          sendAndHealthCheckMs: performance.now() - started, error, smallRequestAfterFailure: state.type === 'state' };
      }, fixture.origin);
      assert.ok(result.input.wireBytes > 64 * MiB, 'single-image fixture must cross the native limit');
      result.reproduced = /maximum allowed size|too large/i.test(result.input.error);
      if (values.verify) {
        await page.locator('#input').evaluate(async (input, origin) => {
          const fixture = await fetch(`${origin}/image?width=2560`).then(response => response.json());
          const blob = await (await fetch(fixture.dataUrl)).blob();
          const transfer = new DataTransfer();
          transfer.items.add(new File([blob], 'large-composer.png', { type: 'image/png' }));
          input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
        }, fixture.origin);
        const preview = page.locator('.input-image-attachment img');
        await preview.waitFor({ timeout: 30000 });
        result.normalizedUpload = await preview.evaluate(async image => {
          await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight, bytes: (await (await fetch(image.src)).blob()).size };
        });
        assert.ok(Math.max(result.normalizedUpload.width, result.normalizedUpload.height) <= 2048);
        assert.ok(result.normalizedUpload.bytes <= 2 * MiB);
      }
    } else if (name === 'collect') {
      await runCollectionCase(page, result);
    } else {
      await page.evaluate(async origin => {
        await window.__imageControl.request('save_config', { config: {
          provider: 'custom', customProtocol: 'openai', customEndpoint: `${origin}/v1/chat/completions`,
          apiKey: 'synthetic-local-only', model: 'synthetic-image-stream', contextWindow: 1000000,
          vision: true, trimOldToolResults: true, debugMode: false,
        } });
      }, fixture.origin);
      const seedCount = name === 'stream' ? 23 : 25;
      result.input = await page.evaluate(async ({ origin, seedCount }) => {
        const image = await fetch(`${origin}/image?width=512`).then(response => response.json());
        window.__syntheticImage = image;
        const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob());
        bitmap.close();
        const codec = await import(chrome.runtime.getURL('shared/session/session-codec.js'));
        const messages = Array.from({ length: seedCount }, (_, index) => [
          { role: 'user', content: [{ type: 'text', text: `Synthetic image turn ${index + 1}` }, { type: 'image_url', image_url: { url: image.dataUrl } }] },
          { role: 'assistant', content: `Synthetic acknowledgement ${index + 1}` },
        ]).flat();
        const conversation = codec.serializeConversation(messages);
        const transcript = codec.transcriptFromConversation(conversation);
        const created = await window.__imageControl.request('create_ui_session', { title: `大图通信复现 · ${seedCount} 张合成图片` });
        const sessionId = created.session.id;
        const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
        const restoreBytes = bytes({ type: 'restore_session', sessionId, session: conversation });
        const estimatedSnapshotBytes = bytes({ type: 'messages', sessionId, session: conversation, transcript, save: false });
        await window.__imageControl.request('restore_session', { sessionId, session: conversation }, 45000);
        // UI navigation reads the owning repository. Persist one conversation, not a pre-expanded duplicate transcript.
        await window.__imageControl.request('save_session_record', { sessionId, session: conversation }, 45000);
        return { sessionId, imageCount: seedCount, width: image.width, height: image.height, encodedBytes: image.encodedBytes,
          imageDataUrlBytes: image.dataUrlBytes, restoreBytes, estimatedSnapshotBytes };
      }, { origin: fixture.origin, seedCount });
      assert.ok(result.input.restoreBytes < 64 * MiB, 'fixture setup must fit in one native request');
      if (name === 'history') assert.ok(result.input.estimatedSnapshotBytes > 64 * MiB);
      if (name === 'stream') assert.ok(result.input.estimatedSnapshotBytes < 64 * MiB);
      await page.locator('.tab-btn[data-tab="sessions"]').click();
      const card = page.locator(`.session-card[data-id="${result.input.sessionId}"]`);
      await card.waitFor({ timeout: 20000 });
      await card.click();
      await page.waitForFunction(() => document.querySelector('.tab-btn[data-tab="chat"]')?.classList.contains('active'));
      if (name === 'history') {
        // Idle navigation can hydrate storage directly. Exercise the same native app-port
        // snapshot request used after stream/tool events, then let recovery run unaided.
        await page.evaluate(sessionId => window.__imageObserver.requestSnapshot(sessionId), result.input.sessionId);
      }
      if (name === 'stream') {
        await page.waitForFunction(() => document.querySelectorAll('.msg-user').length >= 23, null, { timeout: 30000 });
        await page.locator('#input').evaluate(input => {
          const transfer = new DataTransfer();
          const bytes = Uint8Array.from(atob(window.__syntheticImage.dataUrl.split(',')[1]), char => char.charCodeAt(0));
          for (let index = 0; index < 2; index++) transfer.items.add(new File([bytes], `new-noise-${index}.png`, { type: 'image/png' }));
          input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
        });
        await page.waitForFunction(() => document.querySelectorAll('.input-image-attachment img').length === 2);
        await page.locator('#input').fill('QZ_IMAGE_STREAM：观察这两张图片，持续输出测试文字。');
        await page.locator('#input').press('Enter');
        result.input.addedImageCount = 2;
        result.input.minimumFinalSnapshotBytes = 25 * result.input.imageDataUrlBytes * 2;
      }
      if (values.verify) {
        if (name === 'stream') await page.waitForFunction(() => window.__imageObserver.summary().messageUpdates >= 3, null, { timeout: 20000 });
        const start = performance.now();
        const snapshotTask = page.evaluate(async sessionId => {
          const event = await window.__imageControl.request('get_messages', { sessionId, save: false }, 60000);
          const storedParts = event.session.entries.flatMap(entry => Array.isArray(entry.message?.content) ? entry.message.content : []);
          return { type: event.type, entries: event.transcript.length,
            transcriptImageCount: event.transcript.reduce((count, entry) => count + (entry.images?.length || 0), 0),
            storedImageCount: storedParts.filter(part => part.type === 'image_url').length,
            storedPlaceholderCount: storedParts.filter(part => part.type === 'text' && part.text.includes('[image omitted for context saving]')).length,
            bytes: new TextEncoder().encode(JSON.stringify(event)).length };
        }, result.input.sessionId);
        if (name === 'stream') {
          await page.waitForFunction(() => window.__imageControl.transferState().incoming > 0);
          result.controlDuringTransfer = await page.evaluate(async sessionId => {
            const start = performance.now();
            const incoming = window.__imageControl.transferState().incoming;
            const event = await window.__imageControl.request('get_state', { sessionId });
            return { incoming, elapsedMs: performance.now() - start, type: event.type };
          }, result.input.sessionId);
          assert.ok(result.controlDuringTransfer.incoming > 0);
          result.streamActiveBeforeStop = fixture.requests.some(request => request.case === 'stream'
            && request.stream && !request.closed && !request.naturallyCompleted);
          result.stop = await page.evaluate(stopSession, result.input.sessionId);
        }
        result.snapshot = await snapshotTask;
        result.snapshot.elapsedMs = performance.now() - start;
        assert.equal(result.snapshot.type, 'messages');
        assert.equal(result.snapshot.transcriptImageCount, 25, 'UI transcript must retain all historical pictures');
        assert.equal(result.snapshot.storedImageCount, 25, 'stored conversation must retain original images after request pruning');
        assert.equal(result.snapshot.storedPlaceholderCount, 0, 'model placeholders must never be written into history');
        assert.ok(result.snapshot.bytes > 64 * MiB, 'legacy full snapshot must still exercise transparent chunking');
      } else {
        result.errorCapReached = await page.waitForFunction(count => window.__imageObserver.sizeErrors >= count, maxErrors, { timeout: 25000 }).then(() => true, () => false);
      }
      if (name === 'stream' && !result.stop) {
        result.streamActiveBeforeStop = fixture.requests.some(request => request.case === 'stream'
          && request.stream && !request.closed && !request.naturallyCompleted);
        result.stop = await page.evaluate(stopSession, result.input.sessionId);
      }
      result.observed = await page.evaluate(() => ({ ...window.__imageObserver.summary(),
        errorCards: document.querySelectorAll('.chat-error-card').length,
        visibleSizeErrors: document.body.innerText.split('Message exceeded maximum allowed size').length - 1,
        visibleImages: document.querySelectorAll('.msg-user img').length,
      }));
      result.reproduced = result.observed.sizeErrors > 0;
      if (values.verify) {
        assert.equal(result.observed.sizeErrors, 0);
        assert.equal(result.observed.errorCards, 0);
        assert.equal(result.observed.visibleImages, 25, 'request projection must not remove pictures from the UI');
        assert.ok(result.observed.transferFrames > 0);
        if (name === 'stream') {
          assert.equal(result.streamActiveBeforeStop, true);
          assert.equal(result.stop.timedOut, false);
          assert.equal(result.stop.status, 'aborted');
        }
      }
      result.screenshot = join(output, `${name}.png`);
      await page.screenshot({ path: result.screenshot });
      result.smallRequestAfterFailure = await page.evaluate(async sessionId => {
        const start = performance.now();
        const event = await window.__imageControl.request('get_state', { sessionId }, 10000);
        return { type: event.type, status: event.status, elapsedMs: performance.now() - start };
      }, result.input.sessionId);
    }
    result.provider = fixture.requests.filter(request => request.case === name);
    if (values.verify && name === 'stream') {
      assert.ok(result.provider.length > 0, 'the local provider must observe the actual projected request');
      for (const request of result.provider) {
        assert.equal(request.imageCount, 9, 'eight image-bearing messages retain seven historical images plus the latest two');
        assert.equal(request.imageMessages.length, 24);
        for (let index = 0; index < 23; index++) {
          assert.deepEqual(request.imageMessages[index], {
            text: `Synthetic image turn ${index + 1}`,
            imageCount: index < 16 ? 0 : 1,
            placeholders: index < 16 ? ['[image omitted for context saving] x1'] : [],
          }, 'old image messages keep their text and receive one exact placeholder');
        }
        assert.deepEqual(request.imageMessages[23], {
          text: 'QZ_IMAGE_STREAM：观察这两张图片，持续输出测试文字。', imageCount: 2, placeholders: [],
        });
      }
    }
    if (name === 'stream' && result.stop?.startedAtMs) {
      const closed = result.provider.find(request => request.stream && request.closedAtMs);
      if (closed) result.stop.providerCancelledMs = closed.closedAtMs - result.stop.startedAtMs;
    }
    if (values.verify) result.verified = true;
    return result;
  } catch (error) {
    result.failure = String(error.stack || error).slice(0, 2500);
    result.provider = fixture.requests.filter(request => request.case === name);
    if (name === 'collect') result.downloads = fixture.downloads;
    if (page && !page.isClosed()) {
      const observed = await page.evaluate(() => ({ ...window.__imageObserver?.summary(),
        errorCards: document.querySelectorAll('.chat-error-card').length,
        visibleSizeErrors: document.body.innerText.split('Message exceeded maximum allowed size').length - 1,
      })).catch(() => null);
      result.observed = { ...result.observed, ...observed };
      await page.screenshot({ path: join(output, `${name}-failure.png`), timeout: 5000 }).catch(() => {});
    }
    report.cases.push(result);
    throw error;
  } finally {
    clearTimeout(deadline);
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

async function runCollectionCase(page, result) {
  const created = await page.evaluate(async ({ origin }) => {
    await window.__imageControl.request('save_config', { config: {
      provider: 'custom', customProtocol: 'openai', customEndpoint: `${origin}/v1/chat/completions`,
      apiKey: 'synthetic-local-only', model: 'synthetic-image-collection', contextWindow: 1000000,
      vision: true, trimOldToolResults: true, requestRateLimit: false, debugMode: false,
    } });
    return window.__imageControl.request('create_ui_session', { title: '40 张大图连续采集与停止回归' });
  }, { origin: fixture.origin });
  const sessionId = created.session.id;
  result.input = { sessionId, count: COLLECTION_IMAGE_COUNT, sourceWidth: COLLECTION_IMAGE_WIDTH,
    sourceHeight: COLLECTION_IMAGE_HEIGHT, pixelsReused: false, distinctSourceUrls: true };
  await page.locator('.tab-btn[data-tab="sessions"]').click();
  await page.locator(`.session-card[data-id="${sessionId}"]`).click();
  result.setupObserved = await page.evaluate(() => {
    const summary = window.__imageObserver.summary();
    window.__imageObserver.phase('collect');
    return summary;
  });
  await page.locator('#input').fill(`${COLLECTION_MARKER}: 连续读取 40 张本地合成大图，然后读取下一张，等待停止。`);
  await page.locator('#input').press('Enter');
  result.controls = [];
  for (const count of [10, 20, 30, 40]) {
    await waitUntil(() => fixture.requests.some(request => request.case === 'collect' && request.collection.results.length >= count),
      180000, `collection must reach ${count} successful tool returns`);
    const control = await page.evaluate(async sessionId => {
      const start = performance.now();
      const event = await window.__imageControl.request('get_state', { sessionId }, 8000);
      return { elapsedMs: performance.now() - start, type: event.type, status: event.status, isStreaming: event.isStreaming };
    }, sessionId);
    result.controls.push({ collected: count, ...control });
    console.log(`[images] collect: ${count}/${COLLECTION_IMAGE_COUNT}, get_state ${Math.round(control.elapsedMs)}ms`);
    if (count === 10) console.log(`[images] observed request errors: ${JSON.stringify(await page.evaluate(() => window.__imageObserver.summary().errorEvents))}`);
  }
  await waitUntil(() => fixture.downloads.some(download => download.index === COLLECTION_IMAGE_COUNT + 1),
    10000, 'the 41st read_image must begin a real fetch before stop');
  result.collectionActiveBeforeStop = !fixture.downloads.at(-1).closed;
  await page.evaluate(() => window.__imageObserver.phase('stop'));
  result.stop = await page.evaluate(stopSession, sessionId);
  await waitUntil(() => fixture.downloads.at(-1).closed, 3000, 'stop must cancel the pending image response');
  result.stop.imageFetchCancelledMs = fixture.downloads.at(-1).closedAtMs - result.stop.startedAtMs;
  result.downloads = fixture.downloads;

  const snapshotStarted = performance.now();
  await page.evaluate(() => window.__imageObserver.phase('history'));
  result.snapshot = await page.evaluate(async sessionId => {
    const event = await window.__imageControl.request('get_messages', { sessionId, save: false }, 60000);
    const messages = event.session.entries.map(entry => entry.message);
    const parts = messages.flatMap(message => Array.isArray(message?.content) ? message.content : []);
    const imageParts = parts.filter(part => part.type === 'image_url');
    const storedImageHashes = [];
    for (const part of imageParts) {
      const encoded = part.image_url.url.slice(part.image_url.url.indexOf(',') + 1);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
      storedImageHashes.push([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    }
    const successfulTools = messages.filter(message => message?.role === 'tool' && /^collect_image_\d+$/.test(message.tool_call_id || ''))
      .flatMap(message => {
        let value;
        try { value = JSON.parse(message.content); } catch { return []; }
        return value.method === 'url_fetch_resized' ? [{ index: Number(message.tool_call_id.slice('collect_image_'.length)), ...value }] : [];
      });
    return { type: event.type, bytes: new TextEncoder().encode(JSON.stringify(event)).length,
      storedImageCount: imageParts.length, storedImageHashes,
      storedImageDataUrlBytes: imageParts.reduce((sum, part) => sum + part.image_url.url.length, 0),
      storedPlaceholderCount: parts.filter(part => part.type === 'text' && part.text.includes('[image omitted for context saving]')).length,
      transcriptImageCount: event.transcript.filter(entry => typeof entry.image === 'string' && entry.image.startsWith('data:image/')).length,
      transcriptToolIndices: event.transcript.filter(entry => entry.image && /^collect_image_\d+$/.test(entry.toolCallId || '')).map(entry => Number(entry.toolCallId.slice('collect_image_'.length))),
      storedToolResults: successfulTools,
    };
  }, sessionId);
  result.snapshot.elapsedMs = performance.now() - snapshotStarted;
  result.observed = await page.evaluate(() => ({ ...window.__imageObserver.summary(),
    errorCards: document.querySelectorAll('.chat-error-card').length,
    visibleSizeErrors: document.body.innerText.split('Message exceeded maximum allowed size').length - 1,
  }));
  result.smallRequestAfterFailure = await page.evaluate(async sessionId => {
    const start = performance.now();
    const event = await window.__imageControl.request('get_state', { sessionId });
    return { type: event.type, status: event.status, elapsedMs: performance.now() - start };
  }, sessionId);
  result.provider = fixture.requests.filter(request => request.case === 'collect');
  result.uniqueImageHashes = [...new Set(result.provider.flatMap(request => request.collection.images.flatMap(message => message.images.map(image => image.sha256))))];
  result.reproduced = result.observed.sizeErrors > 0;
  result.screenshot = join(output, 'collect.png');
  await page.screenshot({ path: result.screenshot });
  if (!values.verify) return;
  assert.equal(result.collectionActiveBeforeStop, true, 'stop must run during the real image fetch');
  assert.equal(result.stop.timedOut, false);
  assert.equal(result.stop.status, 'aborted');
  assert.ok(result.stop.imageFetchCancelledMs >= 0 && result.stop.imageFetchCancelledMs < 2000,
    `the in-flight image fetch must cancel within 2s independently of persistence: ${result.stop.imageFetchCancelledMs}ms`);
  assert.equal(result.downloads.length, COLLECTION_IMAGE_COUNT + 1);
  assert.equal(result.downloads.at(-1).completed, false, 'the cancelled image response must not finish');
  assert.equal(result.smallRequestAfterFailure.status, 'aborted', 'late work must not restart the Session');
  assert.equal(result.observed.sizeErrors, 0);
  assert.equal(result.observed.errors.length, 0, 'collection must not create request or run errors');
  assert.equal(result.observed.errorCards, 0);
  assert.equal(result.observed.suppressedRequests, 0, 'the diagnostic loop cap must not hide failures');
  assert.equal(result.crashes.length, 0);
  for (const control of result.controls) {
    assert.equal(control.type, 'state');
    assert.equal(control.isStreaming, true, 'control probes must run while collection is active');
    assert.ok(control.elapsedMs < 2000, `small control response exceeded 2s: ${control.elapsedMs}ms`);
  }
  assert.equal(result.snapshot.storedImageCount, COLLECTION_IMAGE_COUNT);
  assert.equal(result.snapshot.storedPlaceholderCount, 0);
  assert.equal(result.snapshot.transcriptImageCount, COLLECTION_IMAGE_COUNT);
  assert.deepEqual(result.snapshot.transcriptToolIndices, Array.from({ length: COLLECTION_IMAGE_COUNT }, (_, index) => index + 1));
  assert.deepEqual(result.snapshot.storedToolResults.map(item => item.index), result.snapshot.transcriptToolIndices);
  assert.ok(result.snapshot.bytes > 64 * MiB && result.snapshot.bytes < 128 * MiB,
    `the actual full history envelope must exercise chunking within its budget: ${result.snapshot.bytes} bytes`);
  assert.ok(result.observed.transferFrames > 0, 'the UI must receive chunked image history');
  assert.equal(result.provider.length, COLLECTION_IMAGE_COUNT + 1, 'one request before and after each successful read');
  assert.equal(result.uniqueImageHashes.length, COLLECTION_IMAGE_COUNT, 'different images must exercise all retained-image decodes');
  assert.deepEqual(result.snapshot.storedImageHashes, result.uniqueImageHashes,
    'history must preserve every originally observed image payload in collection order');
  for (let turn = 0; turn < result.provider.length; turn++) {
    const request = result.provider[turn];
    assert.equal(request.hasReadImageTool, true);
    assert.equal(request.collection.results.length, turn);
    assert.equal(request.collection.images.length, turn);
    assert.equal(request.imageCount, Math.min(turn, 8));
    for (let index = 0; index < turn; index++) {
      const metadata = request.collection.results[index];
      const projected = request.collection.images[index];
      const retained = index >= turn - 8;
      assert.equal(metadata.index, index + 1);
      assert.equal(metadata.error, null, `read_image ${index + 1} failed`);
      assert.equal(metadata.naturalWidth, COLLECTION_IMAGE_WIDTH);
      assert.equal(metadata.naturalHeight, COLLECTION_IMAGE_HEIGHT);
      assert.equal(metadata.method, 'url_fetch_resized');
      assert.equal(metadata.resized, true);
      assert.ok(Math.max(metadata.width, metadata.height) <= 2048 && metadata.bytes <= 2 * MiB);
      assert.equal(projected.index, index + 1);
      assert.equal(projected.imageCount, retained ? 1 : 0);
      assert.deepEqual(projected.placeholders, retained ? [] : ['[image omitted for context saving] x1']);
      for (const image of projected.images) {
        assert.equal(image.width, metadata.width);
        assert.equal(image.height, metadata.height);
        assert.ok(image.bytes <= 2 * MiB);
        // read_image reports an upper bound from the base64 length, including padding.
        assert.equal(Math.ceil(image.bytes / 3) * 3, metadata.bytes);
      }
    }
  }
}

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Test-only observers keep native Chrome serialization and the production UI reducers intact.
function installObserver({ maxErrors }) {
  if (!globalThis.chrome?.runtime?.connect) return;
  const state = { sizeErrors: 0, transferFrames: 0, snapshotRequests: 0, suppressedRequests: 0, messageUpdates: 0,
    maxEventLoopLagMsWholeCase: 0, phase: 'setup', errors: [], errorEvents: [], timeline: [] };
  const original = chrome.runtime.connect.bind(chrome.runtime);
  let appPort;
  chrome.runtime.connect = (...args) => {
    const port = original(...args);
    if (port.name !== 'sidepanel') return port;
    const isAppPort = !appPort;
    appPort ||= port;
    const requests = new Map();
    const send = port.postMessage.bind(port);
    port.postMessage = message => {
      if (message.requestId) {
        requests.set(message.requestId, { type: message.type, sessionId: message.sessionId || null, sentAtMs: Date.now() });
        if (requests.size > 128) requests.delete(requests.keys().next().value);
      }
      if (message.type === 'get_messages' && !message.requestId) {
        if (state.sizeErrors >= maxErrors) { state.suppressedRequests++; return; }
        state.snapshotRequests++;
      }
      return send(message);
    };
    port.onMessage.addListener(event => {
      if (event.__qz_transport__) state.transferFrames++;
      if (!isAppPort) return;
      if (event.type === 'message_update') state.messageUpdates++;
      if (['error', 'request_failed', 'transport_error'].includes(event.type)) {
        const message = String(event.message || '');
        if (state.errors.length < 12) state.errors.push(message.slice(0, 300));
        if (state.errorEvents.length < 12) state.errorEvents.push({ type: event.type, code: event.code || null,
          message: message.slice(0, 500), requestId: event.requestId || null, request: requests.get(event.requestId) || null,
          sessionId: event.sessionId || null, runId: event.runId || null, eventSeq: event.eventSeq ?? null,
          phase: state.phase, receivedAtMs: Date.now(), ms: Math.round(performance.now()) });
        if (/maximum allowed size|too large/i.test(message) && !event.requestId) state.sizeErrors++;
      }
      if (['agent_start', 'message_update', 'agent_end', 'error', 'request_failed', 'transport_error'].includes(event.type) && state.timeline.length < 25) {
        state.timeline.push({ type: event.type, ms: Math.round(performance.now()), requestId: event.requestId || null, phase: state.phase });
      }
    });
    return port;
  };
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    state.maxEventLoopLagMsWholeCase = Math.max(state.maxEventLoopLagMsWholeCase, Math.round(now - lastTick - 100));
    lastTick = now;
  }, 100);
  window.__imageObserver = { get sizeErrors() { return state.sizeErrors; }, summary: () => ({ ...state }),
    phase: value => { state.phase = value; },
    requestSnapshot: sessionId => appPort.postMessage({ type: 'get_messages', sessionId, save: false }) };
}

async function stopSession(sessionId) {
  const start = performance.now();
  const startedAtMs = Date.now();
  try {
    const event = await window.__imageControl.request('stop_session', { sessionId, source: 'ui' }, 8000);
    return { startedAtMs, responseMs: performance.now() - start, type: event.type, status: event.status, timedOut: false };
  } catch (error) { return { startedAtMs, responseMs: performance.now() - start, error: String(error.message), timedOut: /timed out/.test(error.message) }; }
}

async function installControlPort() {
  const { createPortTransport } = await import(chrome.runtime.getURL('shared/transport/port-transport.js'));
  const port = chrome.runtime.connect({ name: 'sidepanel' });
  let sequence = 0;
  const pending = new Map();
  const transport = createPortTransport({ postMessage: message => port.postMessage(message), onMessage: event => {
    const waiter = pending.get(event.requestId);
    if (!waiter) return;
    pending.delete(event.requestId);
    clearTimeout(waiter.timer);
    if (['error', 'request_failed', 'transport_error'].includes(event.type)) waiter.reject(new Error(event.message));
    else waiter.resolve(event);
  } });
  port.onMessage.addListener(transport.receive);
  port.onDisconnect.addListener(() => transport.dispose());
  window.__imageControl = { port, transferState: transport.snapshot, request(type, payload = {}, timeoutMs = 20000) {
    const requestId = `image_repro_${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${type} timed out`)); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      transport.send({ type, ...payload, requestId }).catch(error => { clearTimeout(timer); pending.delete(requestId); reject(error); });
    });
  } };
}

async function startFixtureServer() {
  const requests = [];
  const downloads = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const collectionIndex = Number(/^\/collect\/image\/(\d+)\.png$/.exec(url.pathname)?.[1] || 0);
      if (req.method === 'GET' && collectionIndex) {
        if (collectionIndex > COLLECTION_IMAGE_COUNT + 1) { res.writeHead(404).end(); return; }
        const download = { index: collectionIndex, startedAtMs: Date.now(), completed: false, closed: false };
        downloads.push(download);
        res.on('finish', () => { download.completed = true; });
        res.on('close', () => { download.closed = true; download.closedAtMs = Date.now(); });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
        if (collectionIndex === COLLECTION_IMAGE_COUNT + 1) {
          // Real fetch/readImageResponse is now waiting for bytes. Only cancellation
          // or fixture cleanup closes it; no fake tool result or injected error.
          res.flushHeaders();
          return;
        }
        const image = await generateLargeImage({ width: COLLECTION_IMAGE_WIDTH, height: COLLECTION_IMAGE_HEIGHT, seed: 9122 + collectionIndex });
        download.sourceBytes = image.encodedBytes;
        res.end(Buffer.from(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64'));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/image') {
        const width = Number(url.searchParams.get('width'));
        if (![512, 2560, 4096].includes(width)) { res.writeHead(400).end(); return; }
        const image = await generateLargeImage({ width, seed: 42 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(image));
        return;
      }
      const chunks = [];
      let byteLength = 0;
      for await (const bytes of req) {
        byteLength += bytes.length;
        if (byteLength > 64 * MiB) throw new Error('Local model request exceeded fixture budget');
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const requestText = (body.messages || []).flatMap(message => typeof message.content === 'string' ? message.content
        : (message.content || []).filter(part => part.type === 'text').map(part => part.text || '')).join('\n');
      const isStreamCase = requestText.includes('QZ_IMAGE_STREAM');
      const isCollectionCase = body.stream === true && requestText.includes(COLLECTION_MARKER);
      const record = { case: isCollectionCase ? 'collect' : isStreamCase ? 'stream' : 'setup', bodyBytes: byteLength, stream: body.stream === true,
        imageCount: (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'image_url').length,
        imageMessages: (body.messages || []).filter(message => message.role === 'user' && Array.isArray(message.content)).flatMap(message => {
          const texts = message.content.filter(part => part.type === 'text').map(part => String(part.text || ''));
          const text = texts.find(value => /^(Synthetic image turn |QZ_IMAGE_STREAM)/u.test(value));
          return text ? [{ text, imageCount: message.content.filter(part => part.type === 'image_url').length,
            placeholders: texts.filter(value => value.startsWith('[image omitted for context saving]')) }] : [];
        }),
        outputChunks: 0, naturallyCompleted: false };
      if (isCollectionCase) {
        record.collection = collectionRequestSummary(body.messages);
        record.hasReadImageTool = body.tools?.some(tool => tool.function?.name === 'read_image') === true;
      }
      requests.push(record);
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Synthetic image conversation' }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (isCollectionCase) {
        const next = record.collection.results.length + 1;
        const toolCall = collectionToolCall(next, `http://127.0.0.1:${server.address().port}`);
        res.on('close', () => { record.closed = true; record.closedAtMs = Date.now(); });
        record.outputChunks = 1;
        record.naturallyCompleted = true;
        res.end(`data: ${JSON.stringify({ id: `collection-${next}`, object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }] })}\n\n`
          + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const send = () => {
        record.outputChunks++;
        res.write(`data: ${JSON.stringify({ id: 'synthetic-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: `合成图片流第 ${record.outputChunks} 段。` }, finish_reason: null }] })}\n\n`);
      };
      send();
      const interval = setInterval(send, 500);
      const timeout = setTimeout(() => {
        record.naturallyCompleted = true;
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }, 20000);
      res.on('close', () => { clearInterval(interval); clearTimeout(timeout); record.closed = true; record.closedAtMs = Date.now(); });
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: String(error.message) } }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, downloads,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
