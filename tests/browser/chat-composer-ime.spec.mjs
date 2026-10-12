import { expect, test } from "./sidepanel-fixtures.mjs";

test.describe("chat composer IME stability", () => {
  test.use({ viewport: { width: 430, height: 844 } });

  for (const colorScheme of ["light", "dark"]) {
    test(`keeps the first line visible while native IME wraps onto a second line (${colorScheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await renderSettledTranscript(page, `ime_wrap_${colorScheme}`);
      const input = page.locator("#input");
      await input.focus();
      const before = await input.evaluate(async node => {
        const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
        const set = value => { node.value = value; node.dispatchEvent(new InputEvent("input", { bubbles: true })); };
        set("打开百度"); await frame();
        const height = node.clientHeight;
        let value = node.value;
        for (let i = 0; i < 100; i++) {
          set(`${value}字`); await frame();
          if (node.clientHeight > height) break;
          value = node.value;
        }
        set(value); node.setSelectionRange(value.length, value.length); await frame();
        return { value, height: node.clientHeight };
      });
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send("Input.imeSetComposition", { text: "nihao", selectionStart: 5, selectionEnd: 5 });
        await waitForFrames(page, 3);
        const composing = await input.evaluate(node => ({ value: node.value, height: node.clientHeight,
          scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }));
        expect(composing.value).toBe(`${before.value}nihao`);
        expect(composing.height).toBeGreaterThan(before.height);
        expect(composing.scrollTop).toBe(0);
        expect(composing.scrollHeight).toBeLessThanOrEqual(composing.height + 1);
        await cdp.send("Input.insertText", { text: "你好" });
        await waitForFrames(page, 4);
        await expect(input).toHaveValue(`${before.value}你好`);
        expect(await input.evaluate(node => node.scrollTop)).toBe(0);
      } finally { await cdp.detach(); }
    });
  }

  test("keeps a settled transcript still when a two-line draft receives Chinese IME preedit text", async ({ page }) => {
    await renderSettledTranscript(page, "ime_composer_stability");

    const input = page.locator("#input");
    await input.focus();
    const result = await input.evaluate(async node => {
      const messages = document.querySelector("#messages");
      const assistant = Array.from(messages.querySelectorAll(".msg-assistant")).at(-1);
      const chatDock = document.querySelector("#chat-dock");
      const nextFrames = count => new Promise(resolve => {
        const tick = remaining => requestAnimationFrame(() => (
          remaining <= 1 ? resolve() : tick(remaining - 1)
        ));
        tick(Math.max(1, count));
      });
      const dispatchInput = (value, isComposing) => {
        node.value = value;
        node.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: isComposing ? "insertCompositionText" : "insertText",
          isComposing,
        }));
      };
      const baseValue = "请帮我分析下面的问题，并保留已有上下文：\n继续输入：";
      const sample = phase => ({
        phase,
        inputHeight: node.getBoundingClientRect().height,
        dockHeight: chatDock.getBoundingClientRect().height,
        messagesHeight: messages.getBoundingClientRect().height,
        assistantTop: assistant.getBoundingClientRect().top,
        assistantText: assistant.textContent,
        sameAssistant: assistant === Array.from(messages.querySelectorAll(".msg-assistant")).at(-1),
      });

      dispatchInput(baseValue, false);
      await nextFrames(4);
      messages.scrollTop = messages.scrollHeight;
      await nextFrames(3);
      const baseline = sample("baseline");

      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      const preeditValues = [
        `${baseValue}zhegeshiyigeduanchangdezhongwenshurufayubianjiwenben`,
        `${baseValue}zhegeshiyigeduanchangdezhongwenshurufayubianjiwenbenqingjixufenxi`,
        `${baseValue}这个输入法组合`,
      ];
      const preedit = [];
      for (const value of preeditValues) {
        node.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: value }));
        dispatchInput(value, true);
        await nextFrames(4);
        preedit.push(sample("preedit"));
      }

      node.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        data: "这个输入法组合",
      }));
      dispatchInput(`${baseValue}这个输入法组合`, false);
      await nextFrames(6);
      const settled = sample("settled");

      const longCommittedValue = `${baseValue}${"这个输入法组合已经确认".repeat(8)}`;
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      node.dispatchEvent(new CompositionEvent("compositionupdate", {
        bubbles: true,
        data: longCommittedValue,
      }));
      dispatchInput(longCommittedValue, true);
      await nextFrames(4);
      const longPreedit = sample("long-preedit");
      node.dispatchEvent(new CompositionEvent("compositionend", {
        bubbles: true,
        data: longCommittedValue,
      }));
      dispatchInput(longCommittedValue, false);
      await nextFrames(6);
      return { baseline, preedit, settled, longPreedit, longCommitted: sample("long-committed") };
    });

    const all = [result.baseline, ...result.preedit, result.settled, result.longPreedit, result.longCommitted];
    expect(all.every(sample => sample.sameAssistant), JSON.stringify(result, null, 2)).toBe(true);
    expect(new Set(all.map(sample => sample.assistantText)).size).toBe(1);
    const heights = [result.baseline, ...result.preedit].map(sample => sample.inputHeight);
    expect(heights.every((height, index) => index === 0 || height >= heights[index - 1])).toBe(true);
    expect(Math.max(...heights)).toBeLessThanOrEqual(120);
    expect(
      Math.max(...result.preedit.map(sample => Math.abs(sample.assistantTop - result.baseline.assistantTop))),
      JSON.stringify(result, null, 2),
    ).toBeLessThan(0.5);
    expect(result.settled.inputHeight).toBeCloseTo(result.baseline.inputHeight, 1);
    expect(result.settled.assistantTop).toBeCloseTo(result.baseline.assistantTop, 1);
    expect(result.longPreedit.inputHeight).toBeGreaterThan(result.baseline.inputHeight + 20);
    expect(result.longPreedit.inputHeight).toBeLessThanOrEqual(120);
    expect(result.longPreedit.assistantTop).toBeCloseTo(result.baseline.assistantTop, 1);
    expect(result.longCommitted.inputHeight).toBeGreaterThan(result.baseline.inputHeight + 20);
  });

  test("keeps subpixel geometry stable across native Chromium IME candidate updates", async ({ page }) => {
    await renderSettledTranscript(page, "ime_native_stability");
    const input = page.locator("#input");
    await input.fill("请帮我分析下面的问题，并保留已有上下文：\n继续输入：");
    await input.focus();
    await waitForFrames(page, 4);
    await page.locator("#messages").evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
    await waitForFrames(page, 3);

    const baseline = await readGeometry(page);
    const cdp = await page.context().newCDPSession(page);
    const candidates = [
      "zhegeshiyige",
      "zhegeshiyigeduanchangdezhongwenshurufayubianjiwenben",
      "这个输入法",
      "zhegeshiyigeduanchangdezhongwenshurufayubianjiwenbenqingjixufenxi",
      "这个输入法组合",
    ];
    const samples = [];
    for (const text of candidates) {
      await cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
      for (let frame = 0; frame < 3; frame += 1) {
        await waitForFrames(page, 1);
        samples.push({ candidate: text, frame, ...await readGeometry(page) });
      }
    }
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await waitForFrames(page, 4);
    await cdp.detach();

    const heights = [baseline, ...samples].map(sample => sample.inputHeight);
    expect(heights.every((height, index) => index === 0 || height >= heights[index - 1])).toBe(true);
    expect(Math.max(...heights)).toBeLessThanOrEqual(120);
    expect(
      Math.max(...samples.map(sample => Math.abs(sample.assistantTop - baseline.assistantTop))),
      JSON.stringify({ baseline, samples }, null, 2),
    ).toBeLessThan(0.5);
  });

  test("keeps classic scrollbars out of a one-line native IME boundary", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 720 });
    await renderSettledTranscript(page, "ime_classic_scrollbar_boundary");
    const input = page.locator("#input");
    const initialText = "【营销航班号】更改为【共享航班号】";
    await input.fill(initialText);
    await input.focus();
    await input.evaluate((node, selection) => {
      node.setSelectionRange(selection, selection);
      window.__composerBoundaryResize = [];
      window.__composerBoundaryObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          if (entry.target !== node) continue;
          window.__composerBoundaryResize.push({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      });
      window.__composerBoundaryObserver.observe(node);
    }, initialText.indexOf("【共享") + 1);
    await waitForFrames(page, 3);

    const samples = [];
    const sample = async phase => {
      samples.push(await input.evaluate((node, label) => {
        const style = getComputedStyle(node);
        return {
          phase: label,
          value: node.value,
          width: node.getBoundingClientRect().width,
          height: node.getBoundingClientRect().height,
          clientWidth: node.clientWidth,
          clientHeight: node.clientHeight,
          scrollWidth: node.scrollWidth,
          scrollHeight: node.scrollHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
        };
      }, phase));
    };
    await sample("baseline");

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", {
      text: "dai'ma",
      selectionStart: 6,
      selectionEnd: 6,
    });
    for (let frame = 0; frame < 8; frame += 1) {
      await waitForFrames(page, 1);
      await sample(`preedit-${frame}`);
    }
    await cdp.send("Input.insertText", { text: "代码" });
    for (let frame = 0; frame < 12; frame += 1) {
      await waitForFrames(page, 1);
      await sample(`commit-${frame}`);
    }
    await cdp.detach();
    const resizeSamples = await page.evaluate(() => window.__composerBoundaryResize);

    const baseline = samples[0];
    expect(samples.at(-1).value).toBe("【营销航班号】更改为【代码共享航班号】");
    expect(new Set(samples.map(item => item.overflowX))).toEqual(new Set(["hidden"]));
    expect(new Set(samples.filter(item => item.phase.startsWith("preedit")).map(item => item.overflowY)))
      .toEqual(new Set(["hidden"]));
    expect(new Set(samples.map(item => item.clientWidth))).toEqual(new Set([baseline.clientWidth]));
    expect(Math.min(...samples.map(item => item.clientHeight))).toBeGreaterThanOrEqual(baseline.clientHeight);
    expect(resizeSamples.length, JSON.stringify({ samples, resizeSamples }, null, 2)).toBeLessThan(8);
  });

  test("keeps native IME commits stable at 125% scale with a busy composer dock", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 640 });
    await renderSettledTranscript(page, "ime_native_commit_stability");
    await page.evaluate(() => window.qingzhouConversationBenchmark.configureVisualState({
      running: true,
      pendingFollowUps: [
        { clientMessageId: "ime-queued-1", text: "第一条排队消息" },
        { clientMessageId: "ime-queued-2", text: "第二条排队消息" },
      ],
    }));
    await page.evaluate(() => {
      document.documentElement.style.zoom = "125%";
    });
    await waitForFrames(page, 4);
    const input = page.locator("#input");
    await input.focus();
    await input.evaluate(async node => {
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const setValue = value => {
        node.value = value;
        node.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        }));
      };
      const prefix = "第一行固定内容：\n第二行已经接近自动换行边界：";
      setValue(prefix);
      await nextFrame();
      const initialHeight = node.getBoundingClientRect().height;
      let boundary = prefix;
      for (let index = 0; index < 160; index += 1) {
        const candidate = `${boundary}字`;
        setValue(candidate);
        await nextFrame();
        if (node.getBoundingClientRect().height > initialHeight + 1) {
          setValue(boundary);
          await nextFrame();
          break;
        }
        boundary = candidate;
      }
      document.querySelector("#messages").scrollTop = document.querySelector("#messages").scrollHeight;
      await nextFrame();
      await nextFrame();
      window.__imeCommitEvents = [];
      for (const name of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input"]) {
        node.addEventListener(name, event => {
          window.__imeCommitEvents.push({
            name,
            data: event.data ?? "",
            isComposing: Boolean(event.isComposing),
            valueLength: node.value.length,
          });
        });
      }
      window.__imeCommitSamples = [];
      window.__imeCommitRecording = true;
      const record = () => {
        if (!window.__imeCommitRecording) return;
        const messages = document.querySelector("#messages");
        const assistant = Array.from(messages.querySelectorAll(".msg-assistant")).at(-1);
        const dock = document.querySelector("#chat-dock");
        window.__imeCommitSamples.push({
          inputHeight: node.getBoundingClientRect().height,
          inputOffsetHeight: node.offsetHeight,
          inputClientHeight: node.clientHeight,
          inputComputedHeight: getComputedStyle(node).height,
          inputComputedZoom: getComputedStyle(node).zoom,
          inputCurrentCssZoom: node.currentCSSZoom ?? null,
          inputScrollHeight: node.scrollHeight,
          inputScrollTop: node.scrollTop,
          dockHeight: dock.getBoundingClientRect().height,
          messagesHeight: messages.getBoundingClientRect().height,
          messagesScrollTop: messages.scrollTop,
          messagesBottomDistance: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
          assistantTop: assistant.getBoundingClientRect().top,
          visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
          documentScrollTop: document.scrollingElement?.scrollTop || 0,
        });
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });

    const cdp = await page.context().newCDPSession(page);
    for (const [candidate, committed] of [
      ["zhong", "中"],
      ["wen", "文"],
      ["shu", "输"],
      ["ru", "入"],
      ["fa", "法"],
      ["ce", "测"],
      ["shi", "试"],
    ]) {
      await cdp.send("Input.imeSetComposition", {
        text: candidate,
        selectionStart: candidate.length,
        selectionEnd: candidate.length,
      });
      await waitForFrames(page, 2);
      await cdp.send("Input.insertText", { text: committed });
      await waitForFrames(page, 3);
    }
    for (const [candidate, committed] of [
      ["kuai", "快"],
      ["su", "速"],
      ["lian", "连"],
      ["xu", "续"],
    ]) {
      await cdp.send("Input.imeSetComposition", {
        text: candidate,
        selectionStart: candidate.length,
        selectionEnd: candidate.length,
      });
      await cdp.send("Input.insertText", { text: committed });
    }
    await waitForFrames(page, 6);
    await cdp.detach();
    const result = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__imeCommitRecording = false;
      return {
        events: window.__imeCommitEvents,
        samples: window.__imeCommitSamples,
      };
    });
    const baseline = result.samples[0];
    const maxAssistantDelta = Math.max(...result.samples.map(sample => (
      Math.abs(sample.assistantTop - baseline.assistantTop)
    )));
    // A committed word can be shorter than its pinyin; it may shrink back to the
    // committed height, but must never collapse below the existing draft.
    const inputHeightRegressions = result.samples.filter(sample => sample.inputHeight < baseline.inputHeight - 0.5);

    expect(result.events.filter(event => event.name === "compositionend")).toHaveLength(11);
    expect(new Set(result.samples.map(sample => sample.inputCurrentCssZoom))).toEqual(new Set([1.25]));
    expect(new Set(result.samples.map(sample => sample.visualViewportHeight))).toEqual(new Set([640]));
    expect(result.samples.every(sample => sample.documentScrollTop === 0)).toBe(true);
    expect(inputHeightRegressions, JSON.stringify(result.samples, null, 2)).toEqual([]);
    expect(
      maxAssistantDelta,
      JSON.stringify({ ...result, samples: result.samples.filter((sample, index, all) => (
        index === 0
        || sample.assistantTop !== all[index - 1].assistantTop
        || sample.inputHeight !== all[index - 1].inputHeight
      )) }, null, 2),
    ).toBeLessThan(0.5);
  });

  test("keeps max-height textarea scrolling isolated from the chat viewport at default scale", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 560 });
    await renderSettledTranscript(page, "ime_internal_textarea_scroll");
    const input = page.locator("#input");
    await input.fill("中文输入框内部滚动不会推动外层对话。".repeat(80));
    await input.focus();
    await waitForFrames(page, 5);
    await page.locator("#messages").evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
    await waitForFrames(page, 3);

    const samples = [];
    const sample = async phase => {
      samples.push(await page.evaluate(label => {
        const node = document.querySelector("#input");
        const messages = document.querySelector("#messages");
        const assistant = Array.from(messages.querySelectorAll(".msg-assistant")).at(-1);
        return {
          phase: label,
          inputHeight: node.getBoundingClientRect().height,
          inputClientHeight: node.clientHeight,
          inputScrollHeight: node.scrollHeight,
          inputScrollTop: node.scrollTop,
          inputOverflowX: getComputedStyle(node).overflowX,
          inputOverflowY: getComputedStyle(node).overflowY,
          messagesHeight: messages.getBoundingClientRect().height,
          messagesScrollTop: messages.scrollTop,
          assistantTop: assistant.getBoundingClientRect().top,
          documentScrollTop: document.scrollingElement?.scrollTop || 0,
        };
      }, phase));
    };
    await sample("baseline");
    const cdp = await page.context().newCDPSession(page);
    const candidate = "jixushuruyiduanfeichangchangdepinyinhouxuanwenben";
    await cdp.send("Input.imeSetComposition", {
      text: candidate,
      selectionStart: candidate.length,
      selectionEnd: candidate.length,
    });
    for (let frame = 0; frame < 4; frame += 1) {
      await waitForFrames(page, 1);
      await sample(`preedit-${frame}`);
    }
    await cdp.send("Input.insertText", { text: "继续输入" });
    for (let frame = 0; frame < 5; frame += 1) {
      await waitForFrames(page, 1);
      await sample(`commit-${frame}`);
    }
    await cdp.detach();

    const baseline = samples[0];
    expect(baseline.inputScrollHeight).toBeGreaterThan(baseline.inputClientHeight + 100);
    expect(samples.every(item => item.inputOverflowX === "hidden")).toBe(true);
    expect(samples.every(item => item.inputOverflowY === "auto")).toBe(true);
    expect(
      Math.max(...samples.map(item => Math.abs(item.inputHeight - baseline.inputHeight))),
      JSON.stringify(samples, null, 2),
    ).toBeLessThan(0.5);
    expect(
      Math.max(...samples.map(item => Math.abs(item.messagesHeight - baseline.messagesHeight))),
      JSON.stringify(samples, null, 2),
    ).toBeLessThan(0.5);
    expect(
      Math.max(...samples.map(item => Math.abs(item.assistantTop - baseline.assistantTop))),
      JSON.stringify(samples, null, 2),
    ).toBeLessThan(0.5);
    expect(samples.every(item => item.documentScrollTop === 0)).toBe(true);
  });

  test("does not bounce a two-line draft when a native IME commit keeps the same height", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 640 });
    await renderSettledTranscript(page, "ime_same_height_commit");
    const input = page.locator("#input");
    await input.fill("第一行固定内容\n第二行仍有足够空间");
    await input.focus();
    await waitForFrames(page, 4);
    await page.locator("#messages").evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
    await waitForFrames(page, 3);

    const samples = [await readGeometry(page)];
    const cdp = await page.context().newCDPSession(page);
    const candidate = "zhongwen";
    await cdp.send("Input.imeSetComposition", {
      text: candidate,
      selectionStart: candidate.length,
      selectionEnd: candidate.length,
    });
    for (let frame = 0; frame < 3; frame += 1) {
      await waitForFrames(page, 1);
      samples.push(await readGeometry(page));
    }
    await cdp.send("Input.insertText", { text: "中文" });
    for (let frame = 0; frame < 5; frame += 1) {
      await waitForFrames(page, 1);
      samples.push(await readGeometry(page));
    }
    await cdp.detach();

    const baseline = samples[0];
    expect(new Set(samples.map(item => item.inputHeight))).toEqual(new Set([baseline.inputHeight]));
    expect(
      Math.max(...samples.map(item => Math.abs(item.assistantTop - baseline.assistantTop))),
      JSON.stringify(samples, null, 2),
    ).toBeLessThan(0.5);
    expect(
      Math.max(...samples.map(item => Math.abs(item.scrollTop - baseline.scrollTop))),
      JSON.stringify(samples, null, 2),
    ).toBeLessThan(0.5);
  });

  test("does not move settled chat text when an IME commit grows the draft by one line", async ({ page }) => {
    await renderSettledTranscript(page, "ime_commit_line_growth");
    const input = page.locator("#input");
    await input.focus();

    const result = await input.evaluate(async node => {
      const messages = document.querySelector("#messages");
      const assistant = Array.from(messages.querySelectorAll(".msg-assistant")).at(-1);
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const setValue = (value, isComposing = false) => {
        node.value = value;
        node.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: isComposing ? "insertCompositionText" : "insertText",
          isComposing,
        }));
      };
      const sample = phase => ({
        phase,
        inputHeight: node.getBoundingClientRect().height,
        dockHeight: document.querySelector("#chat-dock").getBoundingClientRect().height,
        assistantTop: assistant.getBoundingClientRect().top,
        scrollTop: messages.scrollTop,
      });

      const prefix = "第一行固定内容：\n第二行接近换行边界：";
      setValue(prefix);
      await nextFrame();
      const twoLineHeight = node.getBoundingClientRect().height;
      let boundaryValue = prefix;
      for (let index = 0; index < 120; index += 1) {
        const candidate = `${boundaryValue}字`;
        setValue(candidate);
        await nextFrame();
        if (node.getBoundingClientRect().height > twoLineHeight + 1) {
          setValue(boundaryValue);
          await nextFrame();
          break;
        }
        boundaryValue = candidate;
      }
      messages.scrollTop = messages.scrollHeight;
      await nextFrame();
      await nextFrame();
      const baseline = sample("baseline");

      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      setValue(`${boundaryValue}zi`, true);
      await nextFrame();
      const preedit = sample("preedit");
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "字" }));
      setValue(`${boundaryValue}字`);
      const committedFrames = [];
      for (let frame = 0; frame < 6; frame += 1) {
        await nextFrame();
        committedFrames.push(sample(`committed-${frame}`));
      }
      return { baseline, preedit, committedFrames };
    });

    expect(result.preedit.inputHeight).toBeGreaterThan(result.baseline.inputHeight + 10);
    expect(result.committedFrames.at(-1).inputHeight).toBeGreaterThan(result.baseline.inputHeight + 10);
    expect(
      Math.max(...[result.preedit, ...result.committedFrames].map(sample => (
        Math.abs(sample.assistantTop - result.baseline.assistantTop)
      ))),
      JSON.stringify(result, null, 2),
    ).toBeLessThan(0.5);
  });
});

async function renderSettledTranscript(page, sessionId) {
  await page.evaluate(async id => {
    await window.qingzhouConversationBenchmark.runSnapshotRender({
      sessionId: id,
      transcript: Array.from({ length: 12 }, (_, index) => ({
        type: "assistant",
        runId: `${id}-history-${index}`,
        spanId: `${id}-history-${index}`,
        content: `静止回答 ${index + 1}：这段文本在用户输入期间不应抖动。`.repeat(3),
      })),
    });
  }, sessionId);
}

function waitForFrames(page, count) {
  return page.evaluate(frameCount => new Promise(resolve => {
    const tick = remaining => requestAnimationFrame(() => (
      remaining <= 1 ? resolve() : tick(remaining - 1)
    ));
    tick(Math.max(1, frameCount));
  }), count);
}

function readGeometry(page) {
  return page.evaluate(() => {
    const messages = document.querySelector("#messages");
    const assistant = Array.from(messages.querySelectorAll(".msg-assistant")).at(-1);
    return {
      inputHeight: document.querySelector("#input").getBoundingClientRect().height,
      dockHeight: document.querySelector("#chat-dock").getBoundingClientRect().height,
      messagesHeight: messages.getBoundingClientRect().height,
      assistantTop: assistant.getBoundingClientRect().top,
      scrollTop: messages.scrollTop,
    };
  });
}
