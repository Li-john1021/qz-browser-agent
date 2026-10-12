import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import {
  deterministicMarkdownVariants,
  formatQuality,
  markdownDestinations,
  requiredVisibleAnchorUrls,
  restoreMissingApprovedAnchors,
  textDerivedUrls,
  urlComparisonKey,
  urlQuality,
} from "../benchmarks/article-extraction/generate-gold-markdown.mjs";

function variant(markdown, sourceText, name, structures = { preBlocks: 0 }) {
  return deterministicMarkdownVariants(markdown, sourceText, structures)
    .find(candidate => candidate.name === name)?.markdown;
}

test("gold Markdown deterministic repairs are conservative around Markdown delimiters", () => {
  const emphasis = [
    String.raw`电话：021\*\*\* *详细*`,
    "[*批发.*招投标采购信息 更多](https://example.com)",
    "*第一行",
    "第二行*",
  ].join("\n");
  assert.equal(variant(emphasis, "", "canonical-emphasis"), [
    String.raw`电话：021\*\*\* *详细*`,
    "[<em>批发.</em>招投标采购信息 更多](https://example.com)",
    "*第一行",
    "第二行*",
  ].join("\n"));

  assert.equal(
    variant("+ literal\n- real item", "+ literal real item", "escape-line-leading-plus"),
    "\\+ literal\n- real item",
  );
  assert.equal(
    variant("秦王：你休想~！ ~~删除~~", "秦王：你休想~！ 删除", "escape-single-tilde"),
    "秦王：你休想\\~！ ~~删除~~",
  );
  assert.equal(
    variant("# 2026 literal\n## real heading", "# 2026 literal real heading", "escape-line-leading-heading"),
    "\\# 2026 literal\n## real heading",
  );
  assert.equal(variant("#", "#", "escape-line-leading-heading"), "\\#");

  const multilineImage = "-   ![朱嘉明\n    ——奥德修斯](https://example.com/image.jpg)";
  assert.equal(
    variant(multilineImage, "朱嘉明 ——奥德修斯", "collapse-multiline-link-labels"),
    "-   ![朱嘉明 ——奥德修斯](https://example.com/image.jpg)",
  );
  const multilineTitle = "[朱嘉明](https://example.com/article \"朱嘉明\n    ——奥德修斯\")";
  assert.equal(
    variant(multilineTitle, "朱嘉明", "collapse-multiline-link-labels"),
    "[朱嘉明](https://example.com/article \"朱嘉明 ——奥德修斯\")",
  );
  assert.equal(
    variant(
      "[群组\n    名称](https://example.com/group) | -   微信群",
      "群组 名称 | 微信群",
      "collapse-links-and-remove-separator-marker",
    ),
    "[群组 名称](https://example.com/group) | 微信群",
  );

  assert.equal(
    variant(
      "# 真标题\n\n+\n\n分享\n\n**穿刺前分级评估管理。**建立台账",
      "真标题 + 分享 穿刺前分级评估管理。建立台账",
      "plain-asterisks-and-line-markers",
    ),
    "# 真标题\n\n\\+\n\n分享\n\n穿刺前分级评估管理。建立台账",
  );
  assert.equal(
    variant(
      "# 真标题\n\n+\n\n**1. 制度执行管控不严**\n\n正文",
      "真标题 + 1. 制度执行管控不严 正文",
      "canonical-emphasis-and-line-markers",
    ),
    "# 真标题\n\n\\+\n\n<strong>1. 制度执行管控不严</strong>\n\n正文",
  );

  assert.equal(
    variant(
      "[](https://example.com/a)-   [](https://example.com/a)![](https://example.com/i.png)",
      "",
      "split-attached-list-marker",
    ),
    "[](https://example.com/a)\n-   [](https://example.com/a)![](https://example.com/i.png)",
  );

  const nestedList = "- outer\n    - child";
  assert.ok(
    deterministicMarkdownVariants(nestedList, "outer child", { preBlocks: 0 })
      .every(candidate => candidate.markdown.includes("    - child")),
    "a fallback variant must not globally dedent a valid nested list",
  );
});

test("gold Markdown repairs neutralize literal link syntax and poisoned bare autolinks", async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();

  const literal = "[https://example.com/a](https://example.com/a)";
  const expectedLiteral = "\\[https&#58;//example.com/a\\]\\(https&#58;//example.com/a\\)";
  const escaped = variant(literal, literal, "preserve-visible-markdown-link");
  assert.equal(escaped, expectedLiteral);
  for (const serialized of [
    "\\[https://example.com/a\\](https://example.com/a)",
    "\\[https://example.com/a\\]\\(https://example.com/a)",
    "\\[https://example.com/a\\](https://example.com/a\\)",
  ]) {
    assert.equal(variant(serialized, literal, "preserve-visible-markdown-link"), expectedLiteral);
  }
  assert.equal(
    variant(
      `# 真标题\n\n**【财新网】** ${String.raw`\[https://example.com/a\](https://example.com/a)`}`,
      `真标题 【财新网】 ${literal}`,
      "literal-link-and-canonical-emphasis",
    ),
    `# 真标题\n\n<strong>【财新网】</strong> ${expectedLiteral}`,
  );
  const literalQa = await urlQuality(page, escaped, "https://base.test/", [], []);
  assert.equal(literalQa.destinations, 0, "visible literal Markdown syntax must not become a link destination");

  const poisonedHttps = "网站(https://www.gxeea.cn，下同)";
  assert.equal(
    variant(poisonedHttps, poisonedHttps, "normalize-poisoned-bare-autolinks"),
    "网站([https://www.gxeea.cn](<https://www.gxeea.cn/>)，下同)",
  );
  const poisonedWww = "网址：www.athletics.org.cn)，报名时间：8月14日";
  assert.equal(
    variant(poisonedWww, poisonedWww, "normalize-poisoned-bare-autolinks"),
    "网址：[www.athletics.org.cn](<http://www.athletics.org.cn/>))，报名时间：8月14日",
  );
  const invalidLiteralUrl = "版本~ http://127.0.0.1:8011; https://localhost:你的端口号/path_name";
  const invalidLiteralDraft = String.raw`版本~ http://127.0.0.1:8011; https://localhost:你的端口号/path\_name`;
  const neutralized = variant(invalidLiteralDraft, invalidLiteralUrl, "neutralize-invalid-literal-url");
  assert.equal(
    neutralized,
    "版本\\~ http://127.0.0.1:8011; https&#58;//localhost:你的端口号/path&#95;name",
  );
  const neutralizedQa = await urlQuality(
    page,
    neutralized,
    "https://base.test/",
    ["http://127.0.0.1:8011/"],
    ["http://127.0.0.1:8011/"],
  );
  assert.equal(neutralizedQa.accepted, true);
});

test("gold Markdown structure and URL gates use deterministic visible requirements", async t => {
  assert.equal(formatQuality("正文", { headings: 2, preBlocks: 0 }, { headings: 0 }).accepted, true);
  assert.equal(formatQuality("正文", { headings: 0, preBlocks: 0 }, { headings: 2 }).accepted, true);
  assert.deepEqual(
    formatQuality("正文", { headings: 2, preBlocks: 0 }, { headings: 1 }).missingStructures,
    ["headings"],
  );

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  assert.equal(
    urlComparisonKey("https://example.com/a%5eb%7B%7c%7D"),
    "https://example.com/a^b{|}",
  );
  assert.equal(
    urlComparisonKey("https://example.com/a%2Fb?x=a%26b%3Dc"),
    "https://example.com/a%2Fb?x=a%26b%3Dc",
    "URL delimiters must not be decoded by the comparison key",
  );
  const safeEncodingQa = await urlQuality(
    page,
    "[encoded](<https://example.com/a%5Eb%7B%7C%7D>)",
    "https://base.test/",
    ["https://example.com/a^b{|}"],
    ["https://example.com/a^b{|}"],
  );
  assert.equal(safeEncodingQa.accepted, true);
  const delimiterEncodingQa = await urlQuality(
    page,
    "[encoded](<https://example.com/a%2Fb?x=a%26b%3Dc>)",
    "https://base.test/",
    ["https://example.com/a/b?x=a&b=c"],
    ["https://example.com/a/b?x=a&b=c"],
  );
  assert.equal(delimiterEncodingQa.accepted, false);
  const draft = [
    "[visible](https://example.com/visible)",
    "[![](https://img.example.com/empty.png)](https://example.com/empty-icon)",
    "[![图标](https://img.example.com/alt.png)](https://example.com/alt-icon)",
    "[伪地址](https://example.com/%5C_bad)",
  ].join("\n");
  const rendered = await markdownDestinations(page, draft, "https://base.test/");
  const approved = [
    "https://example.com/visible",
    "https://example.com/empty-icon",
    "https://example.com/alt-icon",
    "https://example.com/%5C_bad",
  ];
  const required = requiredVisibleAnchorUrls(rendered, approved, [], "");
  assert.deepEqual(required, [
    "https://example.com/alt-icon",
    "https://example.com/visible",
  ]);

  const droppedApproved = "https://example.com/dropped-by-serializer";
  const requiredWithApproved = requiredVisibleAnchorUrls(
    rendered,
    [...approved, droppedApproved],
    [],
    "",
    [droppedApproved],
  );
  assert.ok(requiredWithApproved.includes(droppedApproved));
  const droppedApprovedQa = await urlQuality(
    page,
    draft,
    "https://base.test/",
    [...approved, droppedApproved, "https://img.example.com/empty.png", "https://img.example.com/alt.png"],
    requiredWithApproved,
  );
  assert.equal(droppedApprovedQa.accepted, false);
  assert.deepEqual(droppedApprovedQa.missingRequiredAnchorUrls, [droppedApproved]);

  const imageOnly = await urlQuality(
    page,
    "![visible](https://example.com/visible)",
    "https://base.test/",
    ["https://example.com/visible"],
    ["https://example.com/visible"],
  );
  assert.equal(imageOnly.accepted, false);
  assert.deepEqual(imageOnly.missingRequiredAnchorUrls, ["https://example.com/visible"]);

  const literalSource = "[https://example.com/literal](https://example.com/literal)";
  const literalDraft = await markdownDestinations(page, literalSource, "https://base.test/");
  assert.deepEqual(
    requiredVisibleAnchorUrls(literalDraft, [], textDerivedUrls(literalSource), literalSource),
    [],
    "a source-text literal Markdown link must not become a required semantic anchor",
  );

  const existingUrl = "https://example.com/existing";
  const plainUrl = "https://example.com/plain";
  const strongUrl = "https://example.com/strong";
  const restorable = [
    "财务软件",
    "",
    "**四川人保财险发布催办公告!**",
    "",
    `[既有链接](${existingUrl})`,
  ].join("\n");
  const restored = await restoreMissingApprovedAnchors({
    page,
    markdown: restorable,
    finalUrl: "https://base.test/",
    allowedUrls: [existingUrl, plainUrl, strongUrl],
    missingRequiredAnchorUrls: [plainUrl, strongUrl],
    approvedVisibleAnchors: [
      { label: "财务软件", url: plainUrl },
      { label: "四川人保财险发布催办公告!", url: strongUrl },
    ],
  });
  assert.equal(restored, [
    `[财务软件](<${plainUrl}>)`,
    "",
    `[**四川人保财险发布催办公告!**](<${strongUrl}>)`,
    "",
    `[既有链接](${existingUrl})`,
  ].join("\n"));
  const restoredDestinations = await markdownDestinations(page, restored, "https://base.test/");
  assert.deepEqual(restoredDestinations.anchorDestinations, [existingUrl, plainUrl, strongUrl].sort());

  assert.equal(await restoreMissingApprovedAnchors({
    page,
    markdown: "财务软件\n\n财务软件",
    finalUrl: "https://base.test/",
    allowedUrls: [plainUrl],
    missingRequiredAnchorUrls: [plainUrl],
    approvedVisibleAnchors: [{ label: "财务软件", url: plainUrl }],
  }), null, "a repeated paragraph label is ambiguous and must not be linked globally");

  assert.equal(await restoreMissingApprovedAnchors({
    page,
    markdown: "O型\n\nO型",
    finalUrl: "https://base.test/",
    allowedUrls: [plainUrl],
    missingRequiredAnchorUrls: [plainUrl],
    approvedVisibleAnchors: [
      { label: "O型", url: plainUrl },
      { label: "O型", url: plainUrl },
    ],
  }), `[O型](<${plainUrl}>)\n\n[O型](<${plainUrl}>)`,
  "a globally unique label/URL pair may be restored when approved and paragraph multiplicities match");

  assert.equal(await restoreMissingApprovedAnchors({
    page,
    markdown: "财务软件",
    finalUrl: "https://base.test/",
    allowedUrls: [plainUrl, strongUrl],
    missingRequiredAnchorUrls: [plainUrl],
    approvedVisibleAnchors: [
      { label: "财务软件", url: plainUrl },
      { label: "财务软件", url: strongUrl },
    ],
  }), null, "label uniqueness must be checked against all approved anchors, not only missing URLs");
});
