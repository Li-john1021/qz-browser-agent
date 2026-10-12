import { build } from "esbuild";
import { expect, test } from "./fixtures.mjs";

const vendor = "/extension/vendor/mathjax/tex-svg-full.js";
let host;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import { createMathFeature } from "./src/sidepanel/features/chat/math-feature.ts";
      import { renderMarkdown } from "./src/sidepanel/features/chat/markdown-feature.ts";
      window.mathTest = { createMathFeature, renderMarkdown };
    `, resolveDir: process.cwd() },
    bundle: true, format: "iife", write: false, target: "chrome114",
  });
  host = result.outputFiles[0].text;
});

async function openFixture(page, { eager = false } = {}) {
  await page.route("**/tests/math-runtime/panel.html", route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html><head>
      <base href="/extension/sidepanel/">
      <link rel="stylesheet" href="/extension/sidepanel/sidepanel.css">
      <script src="/extension/shared/mathjax-config.js"></script>
      ${eager ? `<script src="${vendor}"></script>` : ""}
      <style>body{padding:20px;display:block}.sample{width:340px;padding:12px}</style>
    </head><body></body></html>`,
  }));
  await page.goto("/tests/math-runtime/panel.html");
  await page.addScriptTag({ content: host });
  await page.evaluate(eager => {
    window.features = {};
    window.addFormula = (id, markdown) => {
      const element = document.createElement("div"); element.id = id;
      element.className = "sample msg-assistant";
      element.innerHTML = `<div class="msg-content">${window.mathTest.renderMarkdown(markdown)}</div>`;
      document.body.append(element);
      for (const formula of element.querySelectorAll(".math-formula")) formula.dataset.testSample = id;
      const controller = new AbortController();
      const feature = window.mathTest.createMathFeature({ signal: controller.signal });
      window.features[id] = { element, feature, controller };
      if (eager) {
        const targets = [...element.querySelectorAll(".math-formula")];
        window.MathJax.startup.promise.then(() => window.MathJax.typesetPromise(targets))
          .then(() => { for (const target of targets) target.dataset.mathRendered = "true"; });
      } else feature.schedule(element);
    };
  }, eager);
}

const readyRuntime = `window.calls = []; window.MathJax = {
  startup: { promise: Promise.resolve() },
  typesetPromise: async targets => { window.calls.push(targets.map(node => node.dataset.testSample)); },
  typesetClear() {}
};`;

test("plain text and unfinished formulas do not load MathJax", async ({ page }) => {
  let requests = 0;
  page.on("request", request => { if (request.url().endsWith(vendor)) requests += 1; });
  await openFixture(page);
  await page.evaluate(async () => {
    window.addFormula("plain", "A normal reply without mathematics.");
    const pending = document.createElement("div");
    pending.innerHTML = '<span class="math-formula" data-math-pending="true">$x</span>';
    document.body.append(pending);
    const feature = window.mathTest.createMathFeature(); feature.schedule(pending); await feature.flush();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(requests).toBe(0);
  expect(await page.locator(`script[src$="tex-svg-full.js"]`).count()).toBe(0);
});

test("concurrent consumers share one load and wait for startup", async ({ page }) => {
  let requests = 0;
  await page.route(`**${vendor}`, route => {
    requests += 1;
    return route.fulfill({ contentType: "application/javascript", body: readyRuntime.replace(
      "Promise.resolve()", "new Promise(resolve => { window.finishStartup = resolve; })",
    ) });
  });
  await openFixture(page);
  await page.evaluate(() => { window.addFormula("first", "$x^2$"); window.addFormula("second", "$y^2$"); });
  await expect.poll(() => page.evaluate(() => typeof window.finishStartup)).toBe("function");
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  expect(requests).toBe(1);
  await page.evaluate(() => window.finishStartup());
  await expect(page.locator("[data-math-rendered=true]")).toHaveCount(2);
  expect((await page.evaluate(() => window.calls)).flat().sort()).toEqual(["first", "second"]);
  await page.evaluate(() => window.addFormula("third", "$z^2$"));
  await expect(page.locator("[data-math-rendered=true]")).toHaveCount(3);
  expect(requests).toBe(1);
});

test("removed, cleared and disposed formulas cannot claim a late load", async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**${vendor}`, async route => { await gate; await route.fulfill({ contentType: "application/javascript", body: readyRuntime }); });
  await openFixture(page);
  await page.evaluate(() => {
    for (const id of ["removed", "cleared", "disposed"]) window.addFormula(id, "$x^2$");
  });
  await expect(page.locator("[data-math-rendering=true]")).toHaveCount(3);
  const before = await page.evaluate(() => {
    window.features.removed.element.remove();
    window.features.cleared.feature.clear(window.features.cleared.element);
    window.features.disposed.controller.abort();
    return Object.fromEntries(Object.entries(window.features).map(([id, value]) => [id, value.element.innerHTML]));
  });
  release();
  await expect.poll(() => page.evaluate(() => Boolean(window.calls))).toBe(true);
  await page.evaluate(() => window.addFormula("current", "$y^2$"));
  await expect(page.locator("#current [data-math-rendered=true]")).toHaveCount(1);
  expect((await page.evaluate(() => window.calls)).flat()).toEqual(["current"]);
  const after = await page.evaluate(() => Object.fromEntries(Object.entries(window.features)
    .filter(([id]) => id !== "current").map(([id, value]) => [id, value.element.innerHTML])));
  expect(after).toEqual(before);
});

for (const failure of ["resource failure", "uninitialized", "startup rejection"]) {
  test(`${failure} falls back and a later formula retries`, async ({ page, browserDiagnostics }) => {
    let requests = 0;
    await page.route(`**${vendor}`, route => {
      requests += 1;
      if (requests === 1 && failure === "resource failure") return route.abort("failed");
      const failed = failure === "uninitialized" ? "/* incomplete resource */" : `${readyRuntime}
        window.MathJax.startup.promise = Promise.reject(new Error("startup failed"));
        window.MathJax.startup.promise.catch(() => {});`;
      return route.fulfill({ contentType: "application/javascript", body: requests === 1 ? failed : readyRuntime });
    });
    await openFixture(page);
    await page.evaluate(() => window.addFormula("failed", "$x^2$"));
    await expect(page.locator("#failed .math-fallback")).toHaveText("x^2");
    if (failure === "resource failure") {
      expect(browserDiagnostics.consoleErrors).toHaveLength(1);
      expect(browserDiagnostics.consoleErrors[0]).toContain("net::ERR_FAILED");
      browserDiagnostics.consoleErrors.length = 0;
    }
    await page.evaluate(async () => {
      window.features.failed.feature.schedule(window.features.failed.element);
      await window.features.failed.feature.flush();
    });
    expect(requests).toBe(1);
    await page.evaluate(() => window.addFormula("retry", "$y^2$"));
    await expect(page.locator("#retry [data-math-rendered=true]")).toHaveCount(1);
    expect(requests).toBe(2);
    expect((await page.evaluate(() => window.calls)).flat()).toEqual(["retry"]);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`late typesetting ${outcome} cannot overwrite a cleared projection`, async ({ page }) => {
    await page.route(`**${vendor}`, route => route.fulfill({ contentType: "application/javascript", body: `${readyRuntime}
      window.MathJax.typesetPromise = () => new Promise((resolve, reject) => { window.finishTypeset = { resolve, reject }; });` }));
    await openFixture(page);
    await page.evaluate(() => window.addFormula("current", "$x^2$"));
    await expect.poll(() => page.evaluate(() => typeof window.finishTypeset)).toBe("object");
    await page.evaluate(async outcome => {
      const { feature, element } = window.features.current;
      feature.clear(element); element.querySelector(".math-formula").textContent = "replacement";
      window.finishTypeset[outcome](new Error("late completion"));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, outcome);
    await expect(page.locator("#current .math-formula")).toHaveText("replacement");
    expect(await page.locator("#current [data-math-rendered], #current .math-fallback").count()).toBe(0);
  });
}

async function pauseRealMathDependency(page) {
  await page.addScriptTag({ url: vendor });
  await page.evaluate(async () => {
    await window.MathJax.startup.promise;
    const document = window.MathJax.startup.document;
    const render = document.render.bind(document);
    let first = true;
    document.render = () => {
      if (first) {
        first = false;
        const error = new Error("delayed MathJax dependency");
        error.retry = new Promise((resolve, reject) => { window.finishDependency = { resolve, reject }; });
        throw error;
      }
      return render();
    };
  });
}

for (const cancellation of ["clear", "remove", "dispose"]) {
  test(`real MathJax dependency completion cannot write after ${cancellation}`, async ({ page }) => {
    await openFixture(page);
    await pauseRealMathDependency(page);
    await page.evaluate(() => {
      window.addFormula("old", "$x^2$");
      window.pending = window.features.old.feature.flush();
      window.originalFormula = window.features.old.element.querySelector(".math-formula");
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishDependency)).toBe("object");
    const before = await page.evaluate(cancellation => {
      const { feature, element } = window.features.old;
      if (cancellation === "clear") feature.clear(element);
      if (cancellation === "remove") element.remove();
      if (cancellation === "dispose") feature.dispose();
      window.originalFormula.textContent = String.raw`\(replacement\)`;
      return window.originalFormula.outerHTML;
    }, cancellation);
    await page.evaluate(async () => { window.finishDependency.resolve(); await window.pending; });
    expect(await page.evaluate(() => window.originalFormula.outerHTML)).toBe(before);
    expect(await page.evaluate(() => [...window.MathJax.startup.document.math].length)).toBe(0);
    expect(await page.locator("body > [aria-hidden=true]").count()).toBe(0);
    await page.evaluate(() => window.addFormula("new", "$y^2$"));
    await expect(page.locator("#new mjx-container svg")).toHaveCount(1);
  });
}

for (const outcome of ["resolve", "reject"]) {
  test(`real MathJax serializes different features and continues after dependency ${outcome}`, async ({ page }) => {
    await openFixture(page);
    await pauseRealMathDependency(page);
    await page.evaluate(() => {
      window.addFormula("first", "$x^2$"); window.firstRender = window.features.first.feature.flush();
    });
    await expect.poll(() => page.evaluate(() => typeof window.finishDependency)).toBe("object");
    await page.evaluate(async () => {
      window.addFormula("second", "$y^2$"); window.secondRender = window.features.second.feature.flush();
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    expect(await page.locator("#first svg, #second svg").count()).toBe(0);
    await page.evaluate(async outcome => {
      window.finishDependency[outcome](new Error("dependency unavailable"));
      await Promise.all([window.firstRender, window.secondRender]);
    }, outcome);
    if (outcome === "resolve") await expect(page.locator("#first mjx-container svg")).toHaveCount(1);
    else await expect(page.locator("#first .math-fallback")).toHaveText("x^2");
    await expect(page.locator("#second mjx-container svg")).toHaveCount(1);
    expect(await page.evaluate(() => [...window.MathJax.startup.document.math].length)).toBe(0);
    expect(await page.locator("body > [aria-hidden=true]").count()).toBe(0);
  });
}

for (const colorScheme of ["light", "dark"]) for (const scale of [1, 1.25]) {
  test(`real formulas match original direct rendering in ${colorScheme} mode at ${scale} scale`, async ({ page, context }) => {
    const eager = await context.newPage();
    try {
      for (const [target, options] of [[page, {}], [eager, { eager: true }]]) {
        await target.emulateMedia({ colorScheme });
        await openFixture(target, options);
        await target.evaluate(scale => {
          window.addFormula("sample", String.raw`Inline $x^2 + y^2 = z^2$.

$$\frac{1}{2} + \sum_{i=1}^{n} i = \int_0^1 x^2\,dx$$` + "\n\n```math\nx = y + 1\n```");
          document.querySelector("#sample").style.setProperty("--chat-text-scale", String(scale));
        }, scale);
        await expect(target.locator("#sample mjx-container svg")).toHaveCount(3);
        await expect(target.locator("#sample [data-math-rendered=true]")).toHaveCount(3);
        await target.evaluate(() => document.fonts.ready);
      }
      expect(await page.locator("#sample").boundingBox()).toEqual(await eager.locator("#sample").boundingBox());
      expect(await page.locator("#sample").screenshot({ animations: "disabled" }))
        .toEqual(await eager.locator("#sample").screenshot({ animations: "disabled" }));
    } finally { await eager.close(); }
  });
}
