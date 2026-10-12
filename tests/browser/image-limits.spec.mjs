import { expect, test } from './fixtures.mjs';
import { generateLargeImage } from '../fixtures/large-image-conversation.mjs';

test('real high entropy PNGs share dimension and encoded byte limits, including DOM SVG decoding', async ({ page }) => {
  const source = await generateLargeImage({ width: 2048, seed: 17 });
  expect(source.encodedBytes).toBeGreaterThan(2 * 1024 * 1024);
  await page.goto('/__test_health');
  const result = await page.evaluate(async dataUrl => {
    const { normalizeImage } = await import('/extension/shared/images/normalize.js');
    const { decodeImageInDom } = await import('/extension/dom/image-decoder.js');
    const image = await normalizeImage(dataUrl);
    const bitmap = await createImageBitmap(await (await fetch(image.dataUrl)).blob());
    const dimensions = [bitmap.width, bitmap.height]; bitmap.close();
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="1024"><rect width="2048" height="1024" fill="red"/></svg>');
    const vector = await normalizeImage(svg, { decode: decodeImageInDom });
    const decoded = await createImageBitmap(await (await fetch(vector.dataUrl)).blob());
    const canvas = new OffscreenCanvas(vector.width, vector.height);
    const context = canvas.getContext('2d'); context.drawImage(decoded, 0, 0); decoded.close();
    return { image: { width: image.width, height: image.height, bytes: image.bytes, dimensions },
      vector: { width: vector.width, height: vector.height, bytes: vector.bytes,
        opaque: context.getImageData(1, 1, 1, 1).data[3], transparent: context.getImageData(vector.width - 1, 1, 1, 1).data[3] } };
  }, source.dataUrl);
  expect(result.image.width).toBeLessThanOrEqual(2048);
  expect(result.image.height).toBeLessThanOrEqual(2048);
  expect(result.image.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.image.dimensions).toEqual([result.image.width, result.image.height]);
  expect(result.vector).toMatchObject({ width: 2048, height: 512, opaque: 255, transparent: 0 });
  expect(result.vector.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
});

test('read_image accepts charset plus base64 data URLs and canonicalizes the image', async ({ page }) => {
  await installMediaImageBridge(page);
  const result = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(2, 2);
    canvas.getContext('2d').fillRect(0, 0, 2, 2);
    const png = await canvas.convertToBlob({ type: 'image/png' });
    const data = btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())));
    const images = [];
    for (const header of ['data:image/png;charset=utf-8;base64,', 'data:image/png;name=tiny;CHARSET="UTF-8";BASE64,']) {
      const image = await window.__imageTool('read_image', { url: header + data });
      images.push({ width: image.width, height: image.height, dataUrl: image._image });
    }
    return { images, expected: `data:image/png;base64,${data}` };
  });
  expect(result.images).toEqual(Array(2).fill({ width: 2, height: 2, dataUrl: result.expected }));
});

test('read_image preserves bytes in forgiving base64 data URLs and rejects malformed payloads', async ({ page, browserDiagnostics }) => {
  await installMediaImageBridge(page);
  const result = await page.evaluate(async () => {
    let data, width;
    for (width = 1; width <= 16; width++) {
      const canvas = new OffscreenCanvas(width, 2);
      canvas.getContext('2d').fillRect(0, 0, width, 2);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      data = btoa(String.fromCharCode(...new Uint8Array(await png.arrayBuffer())));
      if (data.endsWith('=')) break;
    }
    if (!data.endsWith('=')) throw new Error('PNG fixture must require base64 padding');
    const header = 'data:image/png;charset=utf-8;base64,';
    const spaced = value => value.replace(/.{12}/g, '$& \t\r\n\f');
    const escaped = value => [...value].map(char => '%' + char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    const variants = [data.replace(/=+$/, ''), spaced(data), escaped(data), escaped(spaced(data.replace(/=+$/, '')))];
    const images = [];
    for (const payload of variants) {
      const url = header + payload;
      const native = await (await fetch(url)).arrayBuffer();
      const nativeData = btoa(String.fromCharCode(...new Uint8Array(native)));
      try {
        const image = await window.__imageTool('read_image', { url });
        images.push({ nativeData, width: image.width, height: image.height, dataUrl: image._image });
      } catch (error) { images.push({ nativeData, code: error.code }); }
    }
    const invalid = [];
    for (const payload of ['A', '=' + data, data.replace(/^./, '$'), '%GG' + data]) {
      try { await window.__imageTool('read_image', { url: header + payload }); invalid.push('accepted'); }
      catch (error) { invalid.push(error.code); }
    }
    return { data, width, images, invalid };
  });
  expect(result.images).toEqual(Array(4).fill({ nativeData: result.data, width: result.width, height: 2,
    dataUrl: `data:image/png;base64,${result.data}` }));
  expect(result.invalid).toEqual(Array(4).fill('INVALID_IMAGE_DATA'));
  // Each intentionally malformed data URL is also rejected by Chrome's native fetch.
  expect(browserDiagnostics.consoleErrors).toEqual(Array(4).fill('Failed to load resource: net::ERR_INVALID_URL'));
  browserDiagnostics.consoleErrors.length = 0;
});

test('SVG runtime conversion preserves source dimensions, requested output and collection metadata', async ({ page }) => {
  await installMediaImageBridge(page);
  const result = await page.evaluate(async () => {
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="2000"><rect width="4000" height="2000" fill="red"/></svg>');
    const read = await window.__imageTool('read_image', { url: svg });
    const small = await window.__imageTool('read_image', { url: svg, maxWidth: 1000, maxHeight: 400, format: 'webp', quality: 0.7 });
    const encoded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(atob(svg.split(',')[1]));
    const nonBase64 = await window.__imageTool('read_image', { url: encoded });
    const collected = await window.__imageTool('collect_images', { table: 'fixture', urls: [svg] });
    return { read, small, nonBase64, collected: collected.images[0], row: window.__imageRows[0], backgroundDecodes: window.__backgroundDecodes };
  });
  expect(result.read).toMatchObject({ width: 2048, height: 1024, naturalWidth: 4000, naturalHeight: 2000, resized: true, mimeType: 'image/png' });
  expect(result.small).toMatchObject({ width: 800, height: 400, naturalWidth: 4000, naturalHeight: 2000, resized: true, mimeType: 'image/webp' });
  expect(result.nonBase64).toMatchObject({ width: 2048, height: 1024, naturalWidth: 4000, naturalHeight: 2000, resized: true, mimeType: 'image/png' });
  expect(result.read.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.small.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(result.collected).toMatchObject({ naturalWidth: 4000, naturalHeight: 2000 });
  expect(result.row).toMatchObject({ naturalWidth: 4000, naturalHeight: 2000, resized: true });
  expect(result.backgroundDecodes).toBe(0);
});

async function installMediaImageBridge(page) {
  const offscreen = await page.context().newPage();
  await offscreen.goto('/__test_health');
  await offscreen.evaluate(async () => {
    globalThis.chrome = { runtime: { id: 'fixture', getURL: path => path,
      onMessage: { addListener(listener) { window.__offscreenListener = listener; } }, sendMessage: async () => ({}) } };
    await import('/extension/offscreen.js');
  });
  await page.exposeFunction('__offscreenRequest', message => offscreen.evaluate(message => new Promise(resolve => {
    window.__offscreenListener(message, { id: 'fixture' }, resolve);
  }), message));
  await page.goto('/__test_health');
  await page.evaluate(async () => {
    globalThis.chrome = { offscreen: { createDocument: async () => {}, hasDocument: async () => true },
      runtime: { sendMessage: message => window.__offscreenRequest(message), getURL: path => path } };
    const { registerMediaTools } = await import('/extension/capabilities/media/tools.js');
    const definitions = new Map();
    const rows = [];
    window.__imageRows = rows;
    window.__backgroundDecodes = 0;
    const decode = globalThis.createImageBitmap;
    globalThis.createImageBitmap = (...args) => { window.__backgroundDecodes++; return decode(...args); };
    registerMediaTools({ registerTool: definition => definitions.set(definition.name, definition),
      ToolExecutionError: class extends Error { constructor(code, message, details) { super(message); Object.assign(this, { code, details }); } },
      getToolRuntimeDependencies: () => ({}), getPageContext: () => ({}), elementTargetForRef: () => '',
      getElementTargetDescription: () => '', getSecurityGuardrails: async () => ({ rules: [] }),
      assertUrlAllowed() {}, assertTabAllowed() {}, elementTargetForSelector: () => '', elementTargetForUid: () => '',
      clampNumber: (value, min, max, fallback) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback,
      saveImageAsset: async input => ({ ...input, assetId: 'fixture-asset' }),
      queryDataRows: async () => ({ rows: rows.map(data => ({ data })), totalMatched: rows.length }),
      updateDataTableMetadata: async () => {},
      upsertDataRows: async (_table, data) => { rows.push(...data); return { inserted: data.length, updated: 0 }; },
    });
    window.__imageTool = (name, args) => definitions.get(name).execute(args, undefined, { sessionId: 'synthetic' });
  });
}
