import { expect, test, testAssetUrl } from "./fixtures.mjs";
const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

async function installContentScript(page, html) {
  await page.setContent(html);
  await page.evaluate(() => {
    if (!window.chrome) Object.defineProperty(window, "chrome", { configurable: true, value: {} });
    let listener = null;
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: {
        getManifest: () => ({ name: "Qingzhou Test", version: "0.0.0" }),
        onMessage: { addListener(nextListener) { listener = nextListener; } },
        sendMessage: async () => ({ ok: true }),
      },
    });
    window.__callQingzhouContent = (action, params = {}) => new Promise((resolve, reject) => {
      if (typeof listener !== "function") return reject(new Error("content-script listener is not installed"));
      listener({ action, ...params }, {}, resolve);
    });
  });
  await page.addScriptTag({ url: testAssetUrl("extension/content/content-script.js") });
  await expect.poll(() => page.evaluate(() => window.__QZ_CONTENT_READY)).toBe(true);
}

async function listImages(page) {
  return page.evaluate(() => window.__callQingzhouContent("listImageElements", {
    visibleOnly: true,
    limit: 20,
  }));
}

test("image discovery returns bounded semantic text without repeating page or hidden content", async ({ page }) => {
  const longText = "与目标图片无关的长正文 ".repeat(80);
  await installContentScript(page, `
    <!doctype html>
    <html>
      <head>
        <base href="https://example.test/gallery/">
        <title>人物照片集</title>
        <meta name="description" content="用于查找人物经历相关照片的资料页">
        <style>img { display: block; width: 200px; height: 120px; }</style>
      </head>
      <body>
        <main>
          <h1>人物档案</h1>
          <article>
            <h2>杨植麟的 CMU 时期</h2>
            <span id="portrait-name">杨植麟校园肖像</span>
            <span id="portrait-description" hidden>摄于卡内基梅隆大学校园</span>
            <figure>
              <a href="/people/yang" title="打开完整人物资料">
                <img id="portrait" src="${pixel}" alt="人物照片"
                  aria-labelledby="portrait-name" aria-describedby="portrait-description">
                <span>查看人物主页</span>
              </a>
              <figcaption>杨植麟在 CMU 校园内的照片</figcaption>
              <span hidden>不应进入附近正文</span>
            </figure>
          </article>
          <section>
            <h2>重复字段</h2>
            <img id="duplicate" src="${pixel}" alt="同一描述" aria-label="同一描述">
          </section>
          <div>
            <img id="long-context" src="${pixel}" alt="长正文旁的图片">
            <p>${longText}</p>
          </div>
          <div class="grid">
            <div><h3>第一张卡片</h3><img id="card-one" src="${pixel}" alt="卡片一"><p>第一张的说明</p></div>
            <div><h3>第二张卡片</h3><img id="card-two" src="${pixel}" alt="卡片二"><p>第二张的说明</p></div>
            <div><img id="card-three" src="${pixel}" alt="卡片三"><p>第三张没有标题</p></div>
          </div>
        </main>
      </body>
    </html>
  `);

  const result = await listImages(page);
  expect(result).toMatchObject({
    ok: true,
    count: 6,
    pageTitle: "人物照片集",
    pageContext: {
      heading: "人物档案",
      description: "用于查找人物经历相关照片的资料页",
    },
  });

  const portrait = result.images.find(item => item.selector === "#portrait");
  expect(portrait.src).toMatch(/^data:image\/gif;token=/);
  expect(JSON.stringify(result)).not.toContain(pixel);
  expect(portrait.srcset).toBeUndefined();
  const again = await listImages(page);
  expect(again.images.find(item => item.selector === '#portrait').src).toBe(portrait.src);
  await page.locator('#portrait').evaluate(image => { image.src = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'); });
  const changed = await listImages(page);
  expect(changed.images.find(item => item.selector === '#portrait').src).not.toBe(portrait.src);
  expect(portrait.context).toMatchObject({
    accessibleName: "杨植麟校园肖像",
    accessibleDescription: "摄于卡内基梅隆大学校园",
    caption: "杨植麟在 CMU 校园内的照片",
    heading: "杨植麟的 CMU 时期",
    linkText: "查看人物主页",
    linkTitle: "打开完整人物资料",
    linkUrl: "https://example.test/people/yang",
  });
  expect(portrait.context.nearbyText).toContain("杨植麟在 CMU 校园内的照片");
  expect(portrait.context.nearbyText).not.toContain("不应进入附近正文");

  const duplicate = result.images.find(item => item.selector === "#duplicate");
  expect(duplicate.context.accessibleName).toBeUndefined();
  expect(duplicate.context.heading).toBe("重复字段");

  const longContext = result.images.find(item => item.selector === "#long-context");
  expect(longContext.context.nearbyText).toBeUndefined();
  expect(longContext.context.heading).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(longText);

  const cardOne = result.images.find(item => item.selector === "#card-one");
  expect(cardOne.context.nearbyText).toContain("第一张的说明");
  expect(cardOne.context.nearbyText).not.toContain("第二张的说明");

  const cardThree = result.images.find(item => item.selector === "#card-three");
  expect(cardThree.context.heading).toBeUndefined();
});

test("concurrent Content image reads allocate one bitmap at a time and recover from decode and encode failures", async ({ page }) => {
  await installContentScript(page, `<img id="image" src="${pixel}">`);
  await page.locator('#image').evaluate(image => image.decode());
  const result = await page.evaluate(async () => {
    const createBitmap = globalThis.createImageBitmap;
    const convertToBlob = OffscreenCanvas.prototype.convertToBlob;
    let decodingStarted;
    const firstEncoding = new Promise(resolve => { decodingStarted = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let decoded = 0, open = 0, peak = 0, closed = 0, encoded = 0;
    globalThis.createImageBitmap = async (...args) => {
      decoded++;
      if (decoded === 2) throw new Error('synthetic page decode failure');
      const bitmap = await createBitmap(...args);
      const close = bitmap.close.bind(bitmap);
      open++; peak = Math.max(peak, open);
      bitmap.close = () => { open--; closed++; close(); };
      return bitmap;
    };
    OffscreenCanvas.prototype.convertToBlob = async function (...args) {
      encoded++;
      if (encoded === 1) { decodingStarted(); await gate; }
      if (encoded === 2) throw new Error('synthetic page encode failure');
      return convertToBlob.apply(this, args);
    };
    try {
      const pending = Array.from({ length: 6 }, () => window.__callQingzhouContent('readImageElement', { selector: '#image' }));
      await firstEncoding;
      const blocked = { decoded, open, encoded };
      release();
      const results = await Promise.all(pending);
      return { blocked, decoded, closed, open, peak,
        successes: results.filter(result => result.ok).map(result => ({ width: result.width, height: result.height, mimeType: result.mimeType })),
        failures: results.filter(result => !result.ok).map(result => result.code) };
    } finally {
      release();
      globalThis.createImageBitmap = createBitmap;
      OffscreenCanvas.prototype.convertToBlob = convertToBlob;
    }
  });
  expect(result.blocked).toEqual({ decoded: 1, open: 1, encoded: 1 });
  expect(result).toMatchObject({ decoded: 6, closed: 5, open: 0, peak: 1 });
  expect(result.successes).toEqual(Array.from({ length: 4 }, () => ({ width: 1, height: 1, mimeType: 'image/png' })));
  expect(result.failures).toEqual(['IMAGE_CANVAS_FAILED', 'IMAGE_CANVAS_FAILED']);
});

test("queued image reads keep source identity and metadata paired with the captured pixels", async ({ page }) => {
  await installContentScript(page, '<img id="blocker"><img id="candidate">');
  const result = await page.evaluate(async () => {
    const blocker = document.querySelector('#blocker'), candidate = document.querySelector('#candidate');
    function imageUrl(color, width, height) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, width, height);
      return canvas.toDataURL();
    }
    const red = imageUrl('red', 8, 8), blue = imageUrl('blue', 12, 6), green = imageUrl('lime', 16, 16);
    blocker.src = candidate.src = red;
    await Promise.all([blocker.decode(), candidate.decode()]);
    const source = async () => (await window.__callQingzhouContent('listImageElements', { selector: '#candidate', visibleOnly: false })).images[0].src;
    const selectedSource = await source();
    const convert = OffscreenCanvas.prototype.convertToBlob;
    const releases = [], announcements = [];
    const gates = [0, 1].map(index => new Promise(resolve => { releases[index] = resolve; }));
    const started = [0, 1].map(index => new Promise(resolve => { announcements[index] = resolve; }));
    let encoded = 0;
    OffscreenCanvas.prototype.convertToBlob = async function (...args) {
      const index = encoded++;
      if (index < gates.length) { announcements[index](); await gates[index]; }
      return convert.apply(this, args);
    };
    try {
      const first = window.__callQingzhouContent('readImageElement', { selector: '#blocker' });
      await started[0];
      const queued = window.__callQingzhouContent('readImageElement', { selector: '#candidate' });
      candidate.src = blue; candidate.alt = 'captured blue'; await candidate.decode();
      const capturedSource = await source();
      releases[0](); await first;
      await started[1];
      // A later source change must not relabel the bitmap already being encoded.
      candidate.src = green; candidate.alt = 'later green'; await candidate.decode();
      const laterSource = await source();
      releases[1]();
      const response = await queued;
      const bitmap = await createImageBitmap(await (await fetch(response.dataUrl)).blob());
      const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0); bitmap.close();
      return { selectedSource, capturedSource, laterSource, responseSource: response.src,
        ok: response.ok, alt: response.alt, width: response.width, height: response.height,
        naturalWidth: response.naturalWidth, naturalHeight: response.naturalHeight,
        rgba: [...context.getImageData(0, 0, 1, 1).data] };
    } finally { releases.forEach(release => release()); OffscreenCanvas.prototype.convertToBlob = convert; }
  });
  expect(result).toMatchObject({ ok: true, alt: 'captured blue', width: 12, height: 6,
    naturalWidth: 12, naturalHeight: 6, rgba: [0, 0, 255, 255] });
  expect(result.responseSource).toBe(result.capturedSource);
  expect(result.responseSource).not.toBe(result.selectedSource);
  expect(result.responseSource).not.toBe(result.laterSource);
});
