(function() {
  function numberedLines(count, factory) {
    return Array.from({ length: count }, (_, index) => factory(index + 1));
  }

  function fenced(language, body) {
    return "```" + language + "\n" + body.replace(/\s+$/, "") + "\n```";
  }

  function javascriptSnippet() {
    return [
      "const items = [\"alpha\", \"beta\", \"gamma\"];",
      "export function summarize(limit = 2) {",
      "  return items.slice(0, limit).map((item) => item.toUpperCase());",
      "}",
    ].join("\n");
  }

  function pythonSnippet() {
    return [
      "def score_answer(answer: str) -> float:",
      "    if not answer:",
      "        return 0.0",
      "    return 1.0 if \"correct\" in answer.lower() else 0.25",
    ].join("\n");
  }

  function jsonSnippet() {
    return JSON.stringify({
      provider: "openai",
      model: "gpt-5",
      options: { stream: true, temperature: 0.2 },
    }, null, 2);
  }

  function longPythonSnippet(lineCount) {
    return numberedLines(lineCount, line => {
      const value = String(line).padStart(3, "0");
      return `print("stream line ${value}")`;
    }).join("\n");
  }

  function longJavascriptSnippet(lineCount) {
    return numberedLines(lineCount, line => {
      const value = String(line).padStart(3, "0");
      return `const row_${value} = computeValue(${line}, "stable-scroll");`;
    }).join("\n");
  }

  function longLineSnippet() {
    return "const cacheKey = \"" + "qingzhou-rendering-regression-".repeat(40) + "\";";
  }

  function markedCodeText(body) {
    return body.replace(/\s+$/, "") + "\n";
  }

  function buildCodeCases() {
    return [
      {
        name: "javascript fence uses highlight.js",
        markdown: "A JavaScript example:\n\n" + fenced("js", javascriptSnippet()),
        expected: {
          blocks: 1,
          language: "javascript",
          vendor: "highlight.js",
          highlighted: true,
          copyText: markedCodeText(javascriptSnippet()),
        },
      },
      {
        name: "python alias normalizes to python",
        markdown: "A Python example:\n\n" + fenced("py", pythonSnippet()),
        expected: {
          blocks: 1,
          language: "python",
          vendor: "highlight.js",
          highlighted: true,
          copyText: markedCodeText(pythonSnippet()),
        },
      },
      {
        name: "json fence keeps structured copy text",
        markdown: "A JSON example:\n\n" + fenced("json", jsonSnippet()),
        expected: {
          blocks: 1,
          language: "json",
          vendor: "highlight.js",
          highlighted: true,
          copyText: markedCodeText(jsonSnippet()),
        },
      },
      {
        name: "unknown language falls back without breaking",
        markdown: fenced("notalanguage", "plain prose without program syntax\nand another plain line"),
        expected: {
          blocks: 1,
          language: "notalanguage",
          vendor: "plain",
          highlighted: false,
          copyText: markedCodeText("plain prose without program syntax\nand another plain line"),
        },
      },
      {
        name: "long code gets an internal vertical scroller",
        markdown: fenced("javascript", longJavascriptSnippet(150)),
        expected: {
          blocks: 1,
          language: "javascript",
          vendor: "highlight.js",
          highlighted: true,
          verticalScroll: true,
        },
      },
      {
        name: "long line scrolls horizontally inside the block",
        markdown: fenced("javascript", longLineSnippet()),
        expected: {
          blocks: 1,
          language: "javascript",
          vendor: "highlight.js",
          highlighted: true,
          horizontalScroll: true,
        },
      },
    ];
  }

  function buildScrollFrames() {
    return [80, 110, 140].map(lineCount => fenced("python", longPythonSnippet(lineCount)));
  }

  function buildMarkdownCases() {
    const responseUrl = "https://news.example.com/guangxi#:~:text=%E5%90%AF%E5%8A%A8%E6%B4%AA%E6%B6%9D%E7%81%BE%E5%AE%B3%E5%BA%94%E6%80%A5%E5%93%8D%E5%BA%94";
    const warningUrl = "https://news.example.com/guangxi#:~:text=%E5%8F%91%E5%B8%83%E6%9A%B4%E9%9B%A8%E9%A2%84%E8%AD%A6";
    return [
      {
        name: "numeric ranges do not become strikethrough",
        markdown: "粗算一晚总价：大人按 ¥5.2万~6.6万日元/人、儿童通常半价左右，**全家一晚约 ¥13~15 万日元 ≈ ¥6,500~7,500 人民币**。正常的 ~~旧价格~~ 仍应删除，行内代码 `1~2` 保持原样。",
        expected: {
          selectors: {
            "del": 1,
            "strong": 1,
            "code": 1,
          },
          textIncludes: [
            "¥5.2万~6.6万日元/人",
            "全家一晚约 ¥13~15 万日元 ≈ ¥6,500~7,500 人民币",
            "旧价格",
            "1~2",
          ],
        },
      },
      {
        name: "source footnotes preserve text-fragment links",
        markdown: [
          "广西启动洪涝灾害应急响应[^1]，并发布暴雨预警[^2]。复用同一证据时仍可引用同一个编号[^1]。",
          "",
          `[^1]: [广西应急响应报道](${responseUrl}) — news.example.com，读取于 2026-07-06`,
          `[^2]: [广西暴雨预警报道](${warningUrl}) — news.example.com，读取于 2026-07-06`,
        ].join("\n"),
        expected: {
          selectors: {
            ".markdown-footnote-ref": 3,
            ".markdown-footnotes li": 2,
            ".markdown-footnote-backref": 0,
          },
          absentText: ["[^1]", "[^2]", "[^3]"],
          internalFragmentClicks: [".markdown-footnote-ref a"],
          attributes: [
            { selector: ".markdown-footnote-ref a", name: "aria-label", value: "来源 1" },
            { selector: ".markdown-footnote-body a", name: "target", value: "_blank" },
            { selector: ".markdown-footnote-body a", name: "rel", value: "noopener noreferrer" },
          ],
          absentAttributes: [
            { selector: ".markdown-footnote-ref a", name: "target" },
            { selector: ".markdown-footnote-ref a", name: "rel" },
          ],
          linkHrefs: [
            { selector: ".markdown-footnote-body a", value: responseUrl },
            { selector: ".markdown-footnotes li:nth-child(2) .markdown-footnote-body a", value: warningUrl },
          ],
          externalLinkClicks: [
            { selector: ".markdown-footnote-body a", value: responseUrl },
          ],
          textIncludes: ["广西应急响应报道", "广西暴雨预警报道", "读取于 2026-07-06"],
        },
      },
      {
        name: "legacy numeric citation links stay supported",
        markdown: "旧数字引用格式仍可打开[1](https://legacy.example.com/source)。",
        expected: {
          selectors: {
            ".markdown-citation-link": 1,
          },
          attributes: [
            { selector: ".markdown-citation-link", name: "aria-label", value: "引用来源 1" },
          ],
          externalLinkClicks: [
            { selector: ".markdown-citation-link", value: "https://legacy.example.com/source" },
          ],
        },
      },
      {
        name: "bare www links stop before fullwidth prose",
        markdown: "为抖音 PC Web（www.douyin.com）提供匿名公开只读数据工具。严格只读：不登录、不处理验证码。",
        expected: {
          selectors: {
            "a": 1,
          },
          linkHrefs: [
            { selector: "a", value: "http://www.douyin.com" },
          ],
          externalLinkClicks: [
            { selector: "a", value: "http://www.douyin.com/" },
          ],
          textIncludes: ["www.douyin.com）提供匿名公开只读数据工具。严格只读"],
        },
      },
      {
        name: "bare www links keep explicit unicode paths",
        markdown: "中文路径仍然可访问：www.example.com/中文路径 后续正文。",
        expected: {
          selectors: {
            "a": 1,
          },
          linkHrefs: [
            { selector: "a", value: "http://www.example.com/%E4%B8%AD%E6%96%87%E8%B7%AF%E5%BE%84" },
          ],
          textIncludes: ["www.example.com/中文路径 后续正文"],
        },
      },
      {
        name: "loose numeric footnotes with bare urls stay clickable",
        markdown: [
          "非标准数字引用也应该能跳到来源[1]，定义里的裸 URL 也应该可点击。",
          "",
          "[1]: 百度地图搜索结果摘要 — https://map.example.com/place#:~:text=%E8%92%8B%E6%9D%91%E9%85%92%E6%A5%BC ，读取于 2026-07-06",
        ].join("\n"),
        expected: {
          selectors: {
            ".markdown-footnote-ref": 1,
            ".markdown-footnotes li": 1,
            ".markdown-footnote-body a": 1,
          },
          absentText: ["[1]:"],
          internalFragmentClicks: [".markdown-footnote-ref a"],
          linkHrefs: [
            { selector: ".markdown-footnote-body a", value: "https://map.example.com/place#:~:text=%E8%92%8B%E6%9D%91%E9%85%92%E6%A5%BC" },
          ],
          textIncludes: ["百度地图搜索结果摘要", "读取于 2026-07-06"],
        },
      },
      {
        name: "fullwidth markdown citation links stay clickable",
        markdown: [
          "全角括号里的链接也应该能修正[^1]。",
          "",
          "[^1]: [蒋村酒楼]（https://example.com/restaurant#:~:text=%E8%92%8B%E6%9D%91%E9%85%92%E6%A5%BC） — example.com，读取于 2026-07-06",
        ].join("\n"),
        expected: {
          selectors: {
            ".markdown-footnote-ref": 1,
            ".markdown-footnotes li": 1,
            ".markdown-footnote-body a": 1,
          },
          absentText: ["[^1]"],
          internalFragmentClicks: [".markdown-footnote-ref a"],
          linkHrefs: [
            { selector: ".markdown-footnote-body a", value: "https://example.com/restaurant#:~:text=%E8%92%8B%E6%9D%91%E9%85%92%E6%A5%BC" },
          ],
          textIncludes: ["蒋村酒楼", "读取于 2026-07-06"],
        },
      },
      {
        name: "streaming unresolved source footnotes render as pending refs",
        markdown: "广西启动洪涝灾害应急响应[^1]，引用定义还在继续生成。",
        renderOptions: { math: "stream" },
        expected: {
          selectors: {
            ".markdown-footnote-ref": 1,
            ".markdown-footnote-ref-pending": 1,
            ".markdown-footnotes li": 0,
          },
          absentText: ["[^1]"],
          attributes: [
            { selector: ".markdown-footnote-ref-pending span", name: "aria-label", value: "来源 1 生成中" },
          ],
        },
      },
      {
        name: "same footnote labels in later messages do not collide",
        markdown: [
          "另一条回复也使用一号来源[^1]，点击时应该定位到本条消息自己的脚注。",
          "",
          "[^1]: [第二条消息来源](https://second.example.com/source#:~:text=%E7%AC%AC%E4%BA%8C%E6%9D%A1%E6%B6%88%E6%81%AF) — second.example.com，读取于 2026-07-06",
        ].join("\n"),
        expected: {
          selectors: {
            ".markdown-footnote-ref": 1,
            ".markdown-footnotes li": 1,
          },
          absentText: ["[^1]"],
          internalFragmentClicks: [".markdown-footnote-ref a"],
          textIncludes: ["第二条消息来源"],
        },
      },
    ];
  }

  window.QingzhouMessageRenderingCases = {
    buildCodeCases,
    buildMarkdownCases,
    buildScrollFrames,
  };
})();
