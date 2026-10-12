import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { INTERNAL_CANDIDATE_KEYS, instrumentArticleExtractorSource } from "../benchmarks/article-extraction/instrument-extractor.mjs";
import { instrumentContentScriptSource } from "../benchmarks/article-extraction/instrument-content-script.mjs";
import { analyzeMarkdown } from "../benchmarks/article-extraction/markdown-quality.mjs";

import {
  core,
  increment,
  expansion,
  expansionSupplement,
  upstreamComparison,
  upstreamRunner,
  rerankerEvaluator,
  realworldRunner,
  readabilityScript,
  articleExtractorScript,
  contentScript,
  digest,
  writeFixtureCorpus,
  fixtureSample,
  runCompose,
} from "../support/article-extraction-benchmark.mjs";

test("Markdown quality analyzer validates GFM AST, semantic round trips, and pagination boundaries", () => {
  const valid = [
    "# 标题",
    "",
    "正文 **重点** 与 [链接](https://example.com)。",
    "",
    "- 列表一",
    "- 列表二",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "~~~js",
    "const x = 1;",
    "~~~",
  ].join("\n");
  const validSource = "标题 正文 重点 与 链接。 列表一 列表二 A B 1 2 const x = 1;";
  const validResult = analyzeMarkdown(valid, { sourceText: validSource });
  assert.equal(validResult.parser.errors, 0);
  assert.equal(validResult.syntax.total, 0);
  assert.equal(validResult.roundTrip.f1, 1);
  assert.equal(validResult.roundTrip.materialRecallDrift, false);
  assert.equal(validResult.roundTrip.materialPrecisionDrift, false);
  assert.equal(validResult.roundTrip.drift, false);
  assert.equal(validResult.total, 0);

  const entities = analyzeMarkdown("标题：&quot;草莓仙人&quot; [更多&gt;&gt;](https://example.com/more)", {
    sourceText: '标题："草莓仙人" 更多>>',
  });
  assert.equal(entities.roundTrip.exact, true, "prose HTML entities must be compared as their rendered characters");
  assert.equal(entities.roundTrip.drift, false);
  assert.equal(entities.total, 0);

  const html5Entities = analyzeMarkdown(
    "Caf&eacute; is served at 23&deg;C with pi&ntilde;ata, &#x1f642;, &#128578;, and legacy &#x80;.",
    { sourceText: "Café is served at 23°C with piñata, 🙂, 🙂, and legacy €." },
  );
  assert.equal(html5Entities.roundTrip.exact, true, "all HTML5 named and numeric references must match browser text");
  assert.equal(html5Entities.roundTrip.drift, false);
  assert.equal(html5Entities.total, 0);

  const semicolonlessEntities = analyzeMarkdown(
    "Caf&eacute at 23&deg with &#x1f642 and &#128578 plus &notit;.",
    { sourceText: "Caf&eacute at 23&deg with &#x1f642 and &#128578 plus ¬it;." },
  );
  assert.equal(semicolonlessEntities.roundTrip.exact, true, "semicolonless references must match the text actually rendered by Marked");
  assert.equal(semicolonlessEntities.total, 0);

  const deliberatelyEscapedEntities = analyzeMarkdown(
    "Literal &amp;eacute; and &amp;#128578; stay encoded once.",
    { sourceText: "Literal &eacute; and &#128578; stay encoded once." },
  );
  assert.equal(deliberatelyEscapedEntities.roundTrip.exact, true, "explicitly escaped references must not be decoded twice");
  assert.equal(deliberatelyEscapedEntities.total, 0);

  const nestedMultilineLink = [
    "- item",
    "    [开心词场  ",
    "    沪江开心词场](https://example.com/app)",
  ].join("\n");
  const nestedMultilineResult = analyzeMarkdown(nestedMultilineLink, {
    sourceText: "item 开心词场 沪江开心词场",
  });
  assert.equal(
    nestedMultilineResult.syntax.literalLinkFragments,
    0,
    "a multi-line link parsed inside an indented list must not be reported as literal Markdown",
  );

  const parsedAndLiteralDuplicate = `${nestedMultilineLink}\n\n[开心词场`;
  const parsedAndLiteralResult = analyzeMarkdown(parsedAndLiteralDuplicate, {
    sourceText: "item 开心词场 沪江开心词场 开心词场",
  });
  assert.equal(
    parsedAndLiteralResult.syntax.literalLinkFragments,
    1,
    "a parsed fragment may suppress only its own occurrence",
  );

  const malformed = [
    "[orphan",
    "",
    "[empty]()",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 | 3 |",
    "",
    "~~~~js",
    "const broken = true;\u0000\ufffd",
  ].join("\n");
  const malformedResult = analyzeMarkdown(malformed, {
    sourceText: "orphan empty unsafe A B 1 2 3 const broken = true;",
  });
  assert.equal(malformedResult.parser.errors, 0, "CommonMark treats malformed constructs as text, so AST checks must inspect residual literals too");
  assert.deepEqual(malformedResult.syntax, {
    unclosedFences: 1,
    literalLinkFragments: 1,
    emptyLinkDestinations: 1,
    unsafeLinkDestinations: 1,
    raggedTableRows: 1,
    astShapeErrors: 0,
    controlCharacters: 1,
    replacementCharacters: 1,
    total: 7,
  });

  const source = "第一段真实正文保留完整。".repeat(6);
  const contaminated = analyzeMarkdown(`${source}\n\n${"额外噪声不应凭空出现。".repeat(6)}`, { sourceText: source });
  assert.equal(contaminated.roundTrip.materialRecallDrift, false);
  assert.equal(contaminated.roundTrip.materialPrecisionDrift, true);
  assert.equal(contaminated.roundTrip.drift, true);
  const truncated = analyzeMarkdown(source.slice(0, Math.floor(source.length / 2)), { sourceText: source });
  assert.equal(truncated.roundTrip.materialRecallDrift, true);
  assert.equal(truncated.roundTrip.drift, true);
  const emptySerialization = analyzeMarkdown("", { sourceText: source });
  assert.equal(emptySerialization.roundTrip.materialRecallDrift, true, "an empty serializer result must not bypass Markdown quality scoring");

  const linked = "Before [destination](https://example.com/path) after";
  const unsafeEnd = linked.indexOf("example.com");
  const unsafePagination = analyzeMarkdown(linked, {
    sourceText: "Before destination after",
    chunkEnds: [unsafeEnd, linked.length],
  }).pagination;
  assert.equal(unsafePagination.sensitiveBoundaries, 1);
  assert.equal(unsafePagination.boundaryTypes.link, 1);
  assert.equal(unsafePagination.semanticDrift, true);
  assert.ok(unsafePagination.structureLoss >= 1);

  const list = "- 第一项\n  续行\n- 第二项\n  续行";
  const listBoundary = list.indexOf("- 第二项");
  const splitList = analyzeMarkdown(list, {
    sourceText: "第一项 续行 第二项 续行",
    chunkEnds: [listBoundary, list.length],
  }).pagination;
  assert.equal(splitList.sensitiveBoundaries, 1);
  assert.equal(splitList.boundaryTypes.list, 1, "list boundaries remain observable even when the split is semantically safe");
  assert.equal(splitList.structureDrift, false, "a boundary between complete unordered items remains valid Markdown in both chunks");
  assert.ok(splitList.structureDelta >= 1);
  assert.equal(splitList.benignListFragmentations, 1);
  assert.equal(splitList.total, 0);

  const splitInsideItem = analyzeMarkdown(list, {
    sourceText: "第一项 续行 第二项 续行",
    chunkEnds: [list.indexOf("第一项") + 1, list.length],
  }).pagination;
  assert.equal(splitInsideItem.sensitiveBoundaries, 1);
  assert.equal(splitInsideItem.benignListFragmentations, 0);
  assert.equal(splitInsideItem.semanticDrift, true);
  assert.equal(splitInsideItem.total, 1, "cutting through a list item remains a pagination defect");

  const paragraphs = "第一段保持完整。\n\n第二段也保持完整。";
  const safePagination = analyzeMarkdown(paragraphs, {
    sourceText: "第一段保持完整。 第二段也保持完整。",
    chunkEnds: [paragraphs.indexOf("\n\n") + 2, paragraphs.length],
  }).pagination;
  assert.equal(safePagination.sensitiveBoundaries, 0);
  assert.equal(safePagination.semanticDrift, false);
  assert.equal(safePagination.structureLoss, 0);
  assert.equal(safePagination.structureDrift, false);
  assert.equal(safePagination.total, 0);
});

test("benchmark-only extractor instrumentation exposes all candidates and clears forced state", async t => {
  const source = readFileSync(articleExtractorScript, "utf8");
  const anchor = "host.QingzhouArticleExtractor = Object.freeze({ extract });";
  assert.equal(source.split(anchor).length - 1, 1, "the benchmark seam must have one unambiguous anchor");
  assert.doesNotMatch(source, /__qingzhouArticleBenchmark/, "the production source must not expose benchmark diagnostics");
  assert.throws(() => instrumentArticleExtractorSource(""), /found 0/);
  assert.throws(() => instrumentArticleExtractorSource(`${source}\n${anchor}`), /found 2/);

  const countedDiagnostic = (input, name, counter) => {
    const anchor = `  function ${name}(`;
    assert.equal(input.split(anchor).length - 1, 1, `${name} must have one benchmark-only definition`);
    return input.replace(anchor, `  function ${name}(...args) {
    globalThis.${counter} = (globalThis.${counter} || 0) + 1;
    return ${name}Impl(...args);
  }

  function ${name}Impl(`);
  };
  const instrumentedSource = countedDiagnostic(
    countedDiagnostic(
      instrumentArticleExtractorSource(source),
      "qingzhouBenchmarkBuildTreeDpDiagnostics",
      "__qingzhouTreeDiagnosticBuilds",
    ),
    "qingzhouBenchmarkTreeSelectorDiagnostics",
    "__qingzhouTreeSelectorDiagnostics",
  );

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const articleText = "这段中心正文用于验证规则、可读性和段落候选都能独立生成，并保持足够长的完整语义。".repeat(12);
  const baselineText = "结构化数据中的独立正文只应在强制 baseline 候选时出现，用来验证状态清理。".repeat(8);
  await page.setContent(`<html><head><title>内部候选测试</title><script type="application/ld+json">${JSON.stringify({
    "@type": "Article",
    articleBody: baselineText,
  })}</script></head><body><article id="articleContent" data-anno-uid="article-main"><h1>内部候选测试</h1><p>${articleText}</p></article><div class="sidebar share sharedaddy utility byline" data-anno-uid="sidebar-noise"><div role="navigation">辅助导航</div></div></body></html>`);
  await page.addScriptTag({ path: readabilityScript });
  await page.addScriptTag({ content: instrumentedSource });
  const result = await page.evaluate(() => {
    const originalDom = document.documentElement.outerHTML;
    const readability = new Readability(document.cloneNode(true), {
      charThreshold: 0,
      keepClasses: false,
    }).parse();
    const collectedDefault = globalThis.__qingzhouArticleBenchmark.collect(document, { readability });
    const collected = globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability,
      provenance: true,
    });
    const collectedGold = globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability,
      provenance: true,
      goldSelection: {
        status: "extract",
        includeRegionIds: ["R0001"],
        excludeRegionIds: [],
      },
    });
    const collectedAnnotationGold = globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability,
      provenance: true,
      goldSelection: {
        status: "extract",
        annotationAttribute: "data-anno-uid",
        keptAnnotationValues: ["article-main"],
      },
    });
    globalThis.__qingzhouArticleBenchmark.force("baseline");
    const forcedStrategy = globalThis.QingzhouArticleExtractor.extract(document, { readability })?.name || "";
    globalThis.__qingzhouArticleBenchmark.clear();
    const normalStrategy = globalThis.QingzhouArticleExtractor.extract(document, { readability })?.name || "";
    globalThis.__qingzhouArticleBenchmark.force("baseline");
    let invalidError = "";
    try {
      globalThis.__qingzhouArticleBenchmark.force("missing");
    } catch (error) {
      invalidError = error.message;
    }
    const afterInvalidStrategy = globalThis.QingzhouArticleExtractor.extract(document, { readability })?.name || "";
    const lastExtractText = globalThis.__qingzhouArticleBenchmark.lastExtractText();
    globalThis.__qingzhouArticleBenchmark.clearLastExtractText();
    return {
      publicKeys: Object.keys(globalThis.QingzhouArticleExtractor),
      domUnchanged: document.documentElement.outerHTML === originalDom,
      collectedDefault,
      collected,
      collectedGold,
      collectedAnnotationGold,
      forcedStrategy,
      normalStrategy,
      invalidError,
      afterInvalidStrategy,
      lastExtractText,
      clearedExtractText: globalThis.__qingzhouArticleBenchmark.lastExtractText(),
    };
  });
  assert.deepEqual(result.publicKeys, ["extract"]);
  assert.equal(result.domUnchanged, true, "benchmark provenance must never annotate or mutate the live DOM");
  assert.equal(result.collectedDefault.diagnostics.candidateProvenanceEnabled, false);
  assert.equal("provenance" in result.collectedDefault.diagnostics, false);
  assert.deepEqual(result.collected.candidates.map(candidate => candidate.key), INTERNAL_CANDIDATE_KEYS);
  assert.ok(result.collected.candidates.every(candidate => candidate.available), JSON.stringify(result.collected.candidates));
  assert.ok(result.collected.candidates.every(candidate => candidate.features?.chars > 0));
  assert.ok(result.collected.candidates.every(candidate => Number.isFinite(candidate.elapsedMs) && candidate.elapsedMs >= 0));
  const benchmarkDiagnostics = result.collected.diagnostics;
  assert.equal(benchmarkDiagnostics.schema, "qingzhou.article-extraction-benchmark-diagnostics.v1");
  assert.equal(benchmarkDiagnostics.candidateProvenanceEnabled, true);
  assert.equal(benchmarkDiagnostics.forcedTreeDp.schema, "qingzhou.article-extraction-tree-dp-diagnostics.v1");
  assert.equal(
    benchmarkDiagnostics.forcedTreeDp.actionModel.schema,
    "qingzhou.tree-dp-rich-bounded-action.v1",
  );
  assert.match(benchmarkDiagnostics.forcedTreeDp.actionModel.packedSha256, /^[a-f0-9]{64}$/);
  assert.ok(["ordinary", "root"].includes(benchmarkDiagnostics.forcedTreeDp.selectedAction));
  assert.ok(Number.isFinite(benchmarkDiagnostics.forcedTreeDp.selectedActionScore));
  assert.ok(Number.isFinite(benchmarkDiagnostics.forcedTreeDp.emptyActionScore));
  assert.ok(
    benchmarkDiagnostics.forcedTreeDp.selectedActionScore
      > benchmarkDiagnostics.forcedTreeDp.emptyActionScore,
  );
  assert.ok(benchmarkDiagnostics.forcedTreeDp.nodeCount > 0);
  assert.ok(benchmarkDiagnostics.forcedTreeDp.pageTokens > 0);
  assert.equal(
    Object.values(benchmarkDiagnostics.forcedTreeDp.includeRootTags).reduce((sum, count) => sum + count, 0),
    benchmarkDiagnostics.forcedTreeDp.includeRootCount,
  );
  assert.equal(benchmarkDiagnostics.productDecision.schema, "qingzhou.article-extraction-product-decision.v1");
  assert.equal(benchmarkDiagnostics.productDecision.completeRequested, true);
  assert.equal(benchmarkDiagnostics.productDecision.finalStrategy, result.collected.currentStrategy);
  assert.match(benchmarkDiagnostics.productDecision.preTreeLegacy.sourceText, /这段中心正文/);
  assert.equal(typeof benchmarkDiagnostics.productDecision.hanDominant, "boolean");
  const provenance = benchmarkDiagnostics.provenance;
  assert.equal(provenance.schema, "qingzhou.article-extraction-provenance.v1");
  assert.equal(provenance.coordinate, "prepared-dom-nonempty-text-node-preorder-v1");
  assert.equal(provenance.rangeEncoding, "zero-based-half-open");
  assert.ok(provenance.sourceUnitCount > 0);
  assert.ok(provenance.sourceChars > 0);
  assert.ok(provenance.sourceTree.elements.length > 0);
  assert.equal(provenance.sourceTree.textUnits.length, provenance.sourceUnitCount);
  assert.ok(provenance.sourceTree.textUnits.every(unit => (
    Number.isInteger(unit.owner) && unit.owner >= 0 && unit.owner < provenance.sourceTree.elements.length
      && Number.isInteger(unit.treeOwner)
      && unit.treeOwner >= -1 && unit.treeOwner < provenance.sourceTree.treeElements.length
      && unit.chars > 0 && unit.tokens >= 0 && typeof unit.text === "string" && /\S/u.test(unit.text)
  )));
  assert.equal(
    provenance.sourceTree.treeElements.length,
    benchmarkDiagnostics.forcedTreeDp.nodeCount,
    "offline DP inputs must use the exact shipped Tree-DP node coordinate",
  );
  assert.equal(
    provenance.sourceTree.treeElements.reduce((sum, element) => sum + element.tokens, 0),
    benchmarkDiagnostics.forcedTreeDp.pageTokens,
  );
  assert.ok(provenance.sourceTree.treeElements.every((element, index) => (
    Number.isInteger(element.source)
      && element.source >= 0 && element.source < provenance.sourceTree.elements.length
      && provenance.sourceTree.elements[element.source].treeIndex === index
      && Number.isInteger(element.parent) && element.parent >= -1 && element.parent < index
      && typeof element.tag === "string"
      && typeof element.anchor === "boolean"
      && Number.isInteger(element.heading)
      && typeof element.listItem === "boolean"
      && Number.isInteger(element.boilerplateHits)
      && Number.isInteger(element.contentHits)
      && Number.isFinite(element.readabilityClassWeight)
      && [-50, -25, 0, 25, 50].includes(element.readabilityClassWeight)
      && Number.isInteger(element.readabilityPositiveHits)
      && element.readabilityPositiveHits >= 0 && element.readabilityPositiveHits <= 2
      && Number.isInteger(element.readabilityNegativeHits)
      && element.readabilityNegativeHits >= 0 && element.readabilityNegativeHits <= 2
      && typeof element.readabilityOkMaybe === "boolean"
      && typeof element.readabilityExtraneous === "boolean"
      && typeof element.readabilityByline === "boolean"
      && typeof element.readabilityShare === "boolean"
      && typeof element.readabilityUnlikely === "boolean"
      && typeof element.readabilityRoleRejected === "boolean"
      && Number.isInteger(element.repeated) && element.repeated >= 1
      && Number.isInteger(element.siblingGroup) && element.siblingGroup >= 0
      && Number.isInteger(element.readabilitySiblingClassGroup)
      && element.readabilitySiblingClassGroup >= 0
      && typeof element.readabilityHasClass === "boolean"
      && Number.isFinite(element.readabilityAnchorWeight)
      && [0, 0.3, 1].includes(element.readabilityAnchorWeight)
      && Array.isArray(element.readabilityPhrasingRuns)
      && element.readabilityPhrasingRuns.every(run => (
        Array.isArray(run) && run.length === 2
          && Number.isInteger(run[0]) && run[0] >= 25
          && Number.isInteger(run[1]) && run[1] >= 0
      ))
      && Number.isInteger(element.depth) && element.depth >= 1
      && typeof element.ownText === "string"
      && element.ownChars === element.ownText.length
      && Number.isInteger(element.tokens) && element.tokens >= 0
      && Array.isArray(element.sourceUnitIds)
      && element.sourceUnitIds.every(unitId => (
        Number.isInteger(unitId)
          && unitId >= 0 && unitId < provenance.sourceTree.textUnits.length
          && provenance.sourceTree.textUnits[unitId].treeOwner === index
          && provenance.sourceTree.textUnits[unitId].tokens > 0
      ))
      && Array.isArray(element.features) && element.features.length === 16
      && element.features.every(Number.isFinite)
      && Number.isFinite(element.baseScore)
  )));
  assert.ok(provenance.sourceTree.treeTextSegments.every(([owner, text]) => (
    Number.isInteger(owner) && owner >= 0 && owner < provenance.sourceTree.treeElements.length
      && typeof text === "string"
  )));
  const goldProvenance = result.collectedGold.diagnostics.provenance;
  assert.equal(goldProvenance.gold.schema, "qingzhou.article-extraction-tree-dp-gold-selection.v1");
  assert.equal(goldProvenance.gold.status, "extract");
  assert.equal(goldProvenance.gold.requestedInclude, 1);
  assert.equal(goldProvenance.gold.resolvedInclude, 1);
  assert.ok(goldProvenance.sourceTree.textUnits.every(unit => typeof unit.gold === "boolean"));
  assert.ok(goldProvenance.sourceTree.treeElements
    .filter(element => element.tokens > 0)
    .every(element => element.goldKnown === true && element.goldKeep === true));
  const annotationGold = result.collectedAnnotationGold.diagnostics.provenance;
  assert.equal(
    annotationGold.gold.schema,
    "qingzhou.article-extraction-annotation-gold-selection.v1",
  );
  assert.equal(annotationGold.gold.annotationAttribute, "data-anno-uid");
  assert.equal(annotationGold.gold.requestedValues, 1);
  assert.equal(annotationGold.gold.resolvedValues, 1);
  assert.equal(annotationGold.gold.unknownTextUnits, 0);
  assert.ok(annotationGold.sourceTree.textUnits.some(unit => unit.gold === true));
  assert.ok(annotationGold.sourceTree.textUnits.some(unit => unit.gold === false));
  assert.ok(annotationGold.sourceTree.treeElements.some(element => (
    element.tokens > 0 && element.goldKnown === true && element.goldKeep === true
  )));
  assert.ok(annotationGold.sourceTree.treeElements.some(element => (
    element.tokens > 0 && element.goldKnown === true && element.goldKeep === false
  )));
  const treeElements = provenance.sourceTree.treeElements;
  assert.ok(treeElements.some(element => element.readabilityClassWeight > 0));
  assert.ok(treeElements.some(element => element.readabilityClassWeight < 0));
  assert.ok(treeElements.some(element => element.readabilityPositiveHits > 0));
  assert.ok(treeElements.some(element => element.readabilityNegativeHits > 0));
  assert.ok(treeElements.some(element => element.readabilityOkMaybe));
  assert.ok(treeElements.some(element => element.readabilityExtraneous));
  assert.ok(treeElements.some(element => element.readabilityByline));
  assert.ok(treeElements.some(element => element.readabilityShare));
  assert.ok(treeElements.some(element => element.readabilityUnlikely));
  assert.ok(treeElements.some(element => element.readabilityRoleRejected));
  const children = Array.from({ length: treeElements.length }, () => []);
  for (let index = 1; index < treeElements.length; index += 1) {
    children[treeElements[index].parent].push(index);
  }
  const subtreeTokens = treeElements.map(element => element.tokens);
  for (let index = treeElements.length - 1; index >= 1; index -= 1) {
    subtreeTokens[treeElements[index].parent] += subtreeTokens[index];
  }
  const keep = new Array(treeElements.length).fill(0);
  const free = new Array(treeElements.length).fill(0);
  const keepChoice = new Array(treeElements.length);
  const freeRoot = new Array(treeElements.length).fill(false);
  for (let index = treeElements.length - 1; index >= 0; index -= 1) {
    let kept = treeElements[index].baseScore;
    const choices = [];
    for (const child of children[index]) {
      const excluded = -20 * Math.min(1, subtreeTokens[child] / 20);
      const retain = keep[child] >= excluded;
      kept += retain ? keep[child] : excluded;
      choices.push(retain);
    }
    keep[index] = kept;
    keepChoice[index] = choices;
    const descend = children[index].reduce((sum, child) => sum + free[child], 0);
    const asRoot = kept - 80;
    if (asRoot >= descend && asRoot > 0) {
      free[index] = asRoot;
      freeRoot[index] = true;
    } else {
      free[index] = Math.max(0, descend);
    }
  }
  const retained = new Array(treeElements.length).fill(false);
  const includeRoots = [];
  const stack = [0];
  while (stack.length) {
    const index = stack.pop();
    if (freeRoot[index]) {
      includeRoots.push(index);
      const keepStack = [index];
      while (keepStack.length) {
        const current = keepStack.pop();
        retained[current] = true;
        for (let offset = 0; offset < children[current].length; offset += 1) {
          if (keepChoice[current][offset]) keepStack.push(children[current][offset]);
        }
      }
    } else {
      stack.push(...children[index]);
    }
  }
  const retainedTokens = treeElements.reduce(
    (sum, element, index) => sum + (retained[index] ? element.tokens : 0),
    0,
  );
  // The source tree above deliberately exposes the stable 16-D base score for
  // retraining. The shipped scorer now adds Readability-derived local terms
  // and a packed page-global action model, so the old base-only recurrence is
  // a useful finite-data contract rather than a serving-output oracle.
  assert.ok(Number.isFinite(free[0]));
  assert.ok(includeRoots.length >= 0);
  assert.ok(retainedTokens >= 0);
  assert.equal(
    benchmarkDiagnostics.forcedTreeDp.selectedAction === "root",
    Number.isInteger(benchmarkDiagnostics.forcedTreeDp.selectedRootIndex),
  );
  for (const key of ["rules", "recall", "treedp"]) {
    const candidate = provenance.candidates[key];
    assert.equal(candidate.exact, true, `${key} must retain exact clone provenance`);
    assert.equal(candidate.status, "exact");
    assert.equal(candidate.evidenceMode, "exact-clone-mask");
    assert.equal(candidate.unmatchedUnitSemantics, "drop");
    assert.equal(candidate.coverage, 1);
    assert.equal(candidate.unmappedChars, 0);
    assert.ok(candidate.retainedRanges.length > 0);
    assert.equal(
      candidate.retainedRanges.reduce((sum, [start, end]) => sum + end - start, 0),
      candidate.retainedUnitCount,
    );
    assert.deepEqual(candidate.positiveRanges, candidate.retainedRanges);
    assert.equal(candidate.positiveUnitCount, candidate.retainedUnitCount);
    assert.ok(candidate.retainedRanges.every(([start, end]) => (
      Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
        && end <= provenance.sourceUnitCount
    )));
  }
  for (const key of ["readability", "paragraph"]) {
    const candidate = provenance.candidates[key];
    assert.equal(candidate.exact, false, `${key} must not claim exact provenance after reconstructing text`);
    assert.equal(candidate.status, "positive-only");
    assert.equal(candidate.reason, "unique-monotone-positive-evidence");
    assert.equal(candidate.evidenceMode, "unique-monotone-full-unit");
    assert.equal(candidate.unmatchedUnitSemantics, "unknown");
    assert.equal(candidate.coverage, 0);
    assert.deepEqual(candidate.retainedRanges, []);
    assert.ok(candidate.positiveUnitCount > 0);
    assert.ok(candidate.positiveRanges.length > 0);
    assert.ok(candidate.positiveCoverage > 0);
    assert.ok(candidate.unmappedChars > 0);
  }
  const baselineProvenance = provenance.candidates.baseline;
  assert.equal(baselineProvenance.exact, false);
  assert.equal(baselineProvenance.status, "unmapped");
  assert.equal(baselineProvenance.reason, "synthetic-metadata-candidate");
  assert.equal(baselineProvenance.evidenceMode, "none");
  assert.equal(baselineProvenance.unmatchedUnitSemantics, "unknown");
  assert.deepEqual(baselineProvenance.retainedRanges, []);
  assert.deepEqual(baselineProvenance.positiveRanges, []);
  assert.ok(baselineProvenance.unmappedChars > 0);

  const repeatedUnit = "重复来源单元必须保持未知，不能因为文本相同就被当成确定的保留票。".repeat(10);
  const ambiguousReadability = await page.evaluate((text) => {
    document.body.innerHTML = `<main><p>${text}</p><p>${text}</p></main>`;
    return globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability: {
        content: `<article><p>${text}</p></article>`,
        textContent: text,
      },
      provenance: true,
    }).diagnostics.provenance.candidates.readability;
  }, repeatedUnit);
  assert.equal(ambiguousReadability.exact, false);
  assert.equal(ambiguousReadability.status, "unmapped");
  assert.equal(ambiguousReadability.unmatchedUnitSemantics, "unknown");
  assert.equal(ambiguousReadability.positiveUnitCount, 0);
  assert.deepEqual(ambiguousReadability.positiveRanges, []);

  assert.equal(result.forcedStrategy, "baseline-json");
  assert.notEqual(result.normalStrategy, "baseline-json");
  assert.match(result.invalidError, /candidate is unavailable/);
  assert.equal(result.afterInvalidStrategy, result.normalStrategy, "an invalid force must not leak the previous candidate");
  assert.match(result.lastExtractText, /这段中心正文/);
  assert.equal(result.clearedExtractText, null, "the benchmark must not reuse source text from a previous extraction");

  const cards = Array.from({ length: 10 }, (_, index) => `
    <article class="result-card">
      <h2>观测条目 ${index + 1}</h2>
      <div>${`第 ${index + 1} 项结果 独立事实 数据来源 影响范围 复核结论 后续计划 `.repeat(9)}</div>
    </article>
  `).join("");
  const navigation = Array.from({ length: 30 }, (_, index) => (
    `<a href="/nav/${index}">站点导航栏目 ${index + 1} 与服务入口</a>`
  )).join("");
  const rescueHtml = `<header><nav>${navigation}</nav></header><main class="main-content">${cards}</main>`;
  const rescueDiagnostics = await page.evaluate((html) => {
    document.body.innerHTML = html;
    globalThis.__qingzhouTreeDiagnosticBuilds = 0;
    globalThis.__qingzhouTreeSelectorDiagnostics = 0;
    const firstCard = document.querySelector(".result-card");
    const readability = {
      content: firstCard.outerHTML,
      textContent: firstCard.innerText,
    };
    const normal = globalThis.QingzhouArticleExtractor.extract(document, { readability, complete: true });
    const normalDiagnosticCalls = {
      build: globalThis.__qingzhouTreeDiagnosticBuilds,
      selector: globalThis.__qingzhouTreeSelectorDiagnostics,
    };
    const summary = globalThis.__qingzhouArticleBenchmark.collect(document, { readability });
    return {
      ...summary.diagnostics.productDecision,
      normalStrategy: normal?.name || "",
      normalText: normal?.text || "",
      normalDiagnosticCalls,
      collectDiagnosticCalls: {
        build: globalThis.__qingzhouTreeDiagnosticBuilds,
        selector: globalThis.__qingzhouTreeSelectorDiagnostics,
      },
    };
  }, rescueHtml);
  assert.deepEqual(
    rescueDiagnostics.normalDiagnosticCalls,
    { build: 0, selector: 0 },
    "normal product extraction must not execute benchmark-only Tree diagnostics",
  );
  assert.deepEqual(
    rescueDiagnostics.collectDiagnosticCalls,
    { build: 1, selector: 1 },
    "post-timing collect must execute each requested diagnostic exactly once",
  );
  assert.equal(rescueDiagnostics.hanDominant, true);
  assert.equal(rescueDiagnostics.preflightPassed, true);
  assert.equal(rescueDiagnostics.legacySafe, false);
  assert.equal(rescueDiagnostics.treeAttempted, true);
  assert.equal(rescueDiagnostics.treeSelector.treeAvailable, true);
  assert.equal(rescueDiagnostics.treeSelector.allPassed, true);
  assert.equal(rescueDiagnostics.treeSelected, true);
  assert.equal(rescueDiagnostics.finalStrategy, "tree-dp");

  const rawPage = await browser.newPage();
  try {
    await rawPage.setContent(rescueHtml);
    await rawPage.addScriptTag({ path: articleExtractorScript });
    const raw = await rawPage.evaluate(() => {
      const firstCard = document.querySelector(".result-card");
      const candidate = globalThis.QingzhouArticleExtractor.extract(document, {
        readability: { content: firstCard.outerHTML, textContent: firstCard.innerText },
        complete: true,
      });
      return { strategy: candidate?.name || "", text: candidate?.text || "" };
    });
    assert.deepEqual(
      { strategy: rescueDiagnostics.normalStrategy, text: rescueDiagnostics.normalText },
      raw,
      "instrumentation must preserve the normal product strategy and text",
    );
  } finally {
    await rawPage.close();
  }

  const linkEntries = Array.from({ length: 12 }, (_, index) => `
    <a class="catalog-entry" href="/entry/${index}">
      <h2>资料条目 ${index + 1}</h2>
      <span>${`第 ${index + 1} 项资料包含事实摘要、来源说明、影响范围、复核结论和后续安排。`.repeat(10)}</span>
    </a>
  `).join("");
  const confidenceDiagnostics = await page.evaluate((entries) => {
    document.body.innerHTML = `<header class="site-header"><nav><a href="/">首页</a></nav></header>
      <main class="catalog-content">${entries}</main><footer class="site-footer">版权声明</footer>`;
    const firstEntry = document.querySelector(".catalog-entry");
    return globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability: {
        content: firstEntry.outerHTML,
        textContent: firstEntry.innerText,
      },
    }).diagnostics.productDecision;
  }, linkEntries);
  assert.equal(confidenceDiagnostics.treeSelector.confidenceOverrideAllowed, true);
  assert.equal(confidenceDiagnostics.treeSelector.confidenceOverridePassed, true);
  assert.equal(confidenceDiagnostics.treeSelector.clearGainPassed, null);
  assert.equal(confidenceDiagnostics.treeSelector.allPassed, true);
  assert.equal(confidenceDiagnostics.treeSelected, true);

  const rejectedConfidenceDiagnostics = await page.evaluate((entries) => {
    document.body.innerHTML = `<header class="site-header"><nav><a href="/">首页</a></nav></header>
      <main class="catalog-content">${entries}</main><footer class="site-footer">版权声明</footer>`;
    const firstEntry = document.querySelector(".catalog-entry");
    const unrelatedSeed = "完全无关的外部候选内容不应被树候选宣称保留。";
    const unrelated = unrelatedSeed
      .repeat(Math.ceil(firstEntry.innerText.length / unrelatedSeed.length))
      .slice(0, firstEntry.innerText.length);
    return globalThis.__qingzhouArticleBenchmark.collect(document, {
      readability: {
        content: `<article><p>${unrelated}</p></article>`,
        textContent: unrelated,
      },
    }).diagnostics.productDecision;
  }, linkEntries);
  assert.equal(rejectedConfidenceDiagnostics.treeAttempted, true);
  assert.equal(rejectedConfidenceDiagnostics.treeSelector.confidenceOverrideAllowed, true);
  assert.equal(rejectedConfidenceDiagnostics.treeSelector.confidenceLengthPassed, true);
  assert.equal(rejectedConfidenceDiagnostics.treeSelector.preservesLegacy, false);
  assert.equal(rejectedConfidenceDiagnostics.treeSelector.confidenceOverridePassed, false);
  assert.equal(rejectedConfidenceDiagnostics.treeSelector.allPassed, false);
  assert.equal(rejectedConfidenceDiagnostics.treeSelected, false);
});

test("benchmark-only content instrumentation exposes the product article serializer", async t => {
  const source = readFileSync(contentScript, "utf8");
  const anchor = "host.__QZ_CONTENT_READY = true;";
  assert.equal(source.split(anchor).length - 1, 1, "the benchmark seam must have one unambiguous anchor");
  assert.doesNotMatch(source, /__qingzhouContentBenchmark/, "the production content script must not expose benchmark APIs");
  assert.throws(() => instrumentContentScriptSource(""), /found 0/);
  assert.throws(() => instrumentContentScriptSource(`${source}\n${anchor}`), /found 2/);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<html><head><base href="https://example.com/article/"></head><body></body></html>');
  await page.evaluate(() => {
    globalThis.chrome = {
      runtime: {
        onMessage: { addListener() {} },
      },
    };
  });
  await page.addScriptTag({ content: instrumentContentScriptSource(source) });
  const markdown = await page.evaluate(() => globalThis.__qingzhouContentBenchmark.serializeArticleContent({
    content: [
      '<article><h1>产品序列化</h1>',
      '<img src="/placeholder.jpg" data-src="https://cdn.example.com/real.jpg" alt="真实图片">',
      '<table><caption>复杂表格</caption><tr><th rowspan="2">名称</th><th>值</th></tr><tr><td>轻舟</td></tr></table>',
      '</article>',
    ].join(""),
    text: "产品序列化 真实图片 复杂表格 名称 值 轻舟",
  }));
  assert.match(markdown, /!\[真实图片\]\(https:\/\/cdn\.example\.com\/real\.jpg\)/, "lazy image normalization must use data-src");
  assert.doesNotMatch(markdown, /placeholder\.jpg/);
  assert.match(markdown, /<table>/, "complex tables must use the product serializer's safe HTML representation");
  assert.match(markdown, /rowspan="2"/);
});

test("Chinese real-world extraction plan is a deterministic 300-page suite", () => {
  assert.equal(core.schema, "qingzhou.article-extraction-sites.v1");
  assert.equal(core.sampleTarget, 300);
  assert.equal(core.sites.length, 25);
  assert.equal(new Set(core.sites.map(site => site.id)).size, core.sites.length);
  assert.equal(
    core.sites.reduce((sum, site) => sum + Number(site.quota || core.samplesPerSite), 0),
    core.sampleTarget,
  );
  assert.ok(new Set(core.sites.map(site => site.vertical)).size >= 6);
  for (const site of core.sites) {
    assert.ok(site.hosts.length >= 1, `${site.id} has no allowed host`);
    assert.equal(site.seeds.length, 3, `${site.id} must contribute three entry/list templates`);
    assert.ok(site.seeds.some(seed => seed.type === "home"), `${site.id} has no home template`);
    for (const seed of site.seeds) assert.match(seed.url, /^https?:\/\//);
    assert.ok(site.detailPatterns.length >= 1, `${site.id} has no detail-page discovery rule`);
    for (const pattern of site.detailPatterns) assert.doesNotThrow(() => new RegExp(pattern));
  }
});

test("Chinese real-world v2 increment adds 200 diverse pages without reusing the v1 site plan", () => {
  assert.equal(increment.schema, "qingzhou.article-extraction-sites.v1");
  assert.equal(increment.sampleTarget, 200);
  assert.equal(increment.sites.length, 48);
  assert.equal(new Set(increment.sites.map(site => site.id)).size, increment.sites.length);
  assert.equal(
    increment.sites.reduce((sum, site) => sum + Number(site.quota), 0),
    increment.sampleTarget,
  );

  const coreIds = new Set(core.sites.map(site => site.id));
  const seedUrls = new Set();
  const seedTypes = new Set();
  for (const site of increment.sites) {
    assert.ok(!coreIds.has(site.id), `${site.id} reuses a v1 site id`);
    assert.ok(site.hosts.length >= 1, `${site.id} has no allowed host`);
    assert.ok(site.seeds.length >= 1, `${site.id} has no real page seed`);
    assert.ok(site.quota >= 2 && site.quota <= 6, `${site.id} exceeds the per-site quota cap`);
    assert.ok(site.detailPatterns.length >= 1, `${site.id} has no detail-page discovery rule`);
    for (const pattern of site.detailPatterns) assert.doesNotThrow(() => new RegExp(pattern));
    for (const seed of site.seeds) {
      const url = new URL(seed.url);
      assert.ok(
        site.hosts.some(value => url.hostname === value || url.hostname.endsWith(`.${value}`)),
        `${site.id} seed is outside its declared site: ${seed.url}`,
      );
      assert.ok(!seedUrls.has(url.href), `duplicate incremental seed: ${url.href}`);
      seedUrls.add(url.href);
      seedTypes.add(seed.type);
    }
  }

  for (const type of ["search", "topic", "data", "video", "policy", "ranking"]) {
    assert.ok(seedTypes.has(type), `increment has no ${type} template`);
  }

  const accountOrChallengeSites = new Set([
    "xueqiu",
    "zhihu",
    "weibo",
    "xiaohongshu",
    "toutiao",
    "wechat-public",
    "douyin",
    "kuaishou",
  ]);
  const riskyQuota = increment.sites
    .filter(site => accountOrChallengeSites.has(site.id))
    .reduce((sum, site) => sum + site.quota, 0);
  assert.ok(riskyQuota <= 23, `account/challenge quota is too large: ${riskyQuota}`);
});

test("Chinese real-world v3 expansion freezes 1,000 site-disjoint pages into 300/300/400 family-isolated splits", () => {
  const oldSites = [...core.sites, ...increment.sites];
  const oldIds = new Set(oldSites.map(site => site.id));
  const oldHosts = new Set(oldSites.flatMap(site => site.hosts));
  const expansionIds = new Set();
  const expansionHosts = new Set();
  const seedUrls = new Set();
  const familySplits = new Map();
  const validatePlan = (plan, {
    target,
    minimumSites,
    splitPages,
    label,
  }) => {
    assert.equal(plan.schema, "qingzhou.article-extraction-sites.v1");
    assert.equal(plan.strictSiteQuotas, true, `${label} must not fill one failed site's quota from another site`);
    assert.equal(plan.sampleTarget, target);
    assert.ok(plan.sites.length >= minimumSites, `${label} has only ${plan.sites.length} sites`);
    assert.equal(plan.sites.reduce((sum, site) => sum + Number(site.quota), 0), target);
    assert.ok(new Set(plan.sites.map(site => site.vertical)).size >= 16, `${label} lacks vertical diversity`);
    assert.deepEqual(Object.fromEntries(["train", "validation", "test"].map(split => [
      split,
      plan.sites.filter(site => site.evaluationSplit === split).reduce((sum, site) => sum + site.quota, 0),
    ])), splitPages);

    for (const site of plan.sites) {
      assert.ok(!oldIds.has(site.id), `${label} reuses legacy site id ${site.id}`);
      assert.ok(!expansionIds.has(site.id), `${label} repeats expansion site id ${site.id}`);
      expansionIds.add(site.id);
      assert.ok(site.quota > 0 && site.quota <= 7, `${site.id} exceeds the per-site diversity cap`);
      assert.ok(site.hosts.length >= 1, `${site.id} has no declared host`);
      assert.ok(site.seeds.length >= 1, `${site.id} has no live seed`);
      assert.ok(site.siteFamily, `${site.id} has no siteFamily`);
      assert.ok(["train", "validation", "test"].includes(site.evaluationSplit), `${site.id} has no valid evaluationSplit`);
      assert.ok(site.discoveredType, `${site.id} has no discoveredType`);
      const splits = familySplits.get(site.siteFamily) || new Set();
      splits.add(site.evaluationSplit);
      familySplits.set(site.siteFamily, splits);
      for (const host of site.hosts) {
        assert.ok(!oldHosts.has(host), `${label} reuses legacy host ${host}`);
        assert.ok(!expansionHosts.has(host), `${label} repeats expansion host ${host}`);
        expansionHosts.add(host);
      }
      for (const seed of site.seeds) {
        const url = new URL(seed.url);
        assert.ok(site.hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)), `${site.id} seed is outside its declared hosts: ${seed.url}`);
        assert.ok(!seedUrls.has(url.href), `duplicate expansion seed: ${url.href}`);
        seedUrls.add(url.href);
      }
      for (const pattern of site.detailPatterns) assert.doesNotThrow(() => new RegExp(pattern), `${site.id} has an invalid discovery pattern`);
    }
  };

  validatePlan(expansion, {
    target: 1_000,
    minimumSites: 160,
    splitPages: { train: 300, validation: 300, test: 400 },
    label: "primary expansion",
  });
  validatePlan(expansionSupplement, {
    target: 800,
    minimumSites: 160,
    splitPages: { train: 240, validation: 240, test: 320 },
    label: "expansion supplement",
  });
  const replacementCellQuotas = plan => {
    const quotas = new Map();
    for (const site of plan.sites) {
      const key = JSON.stringify([site.evaluationSplit, site.vertical, site.discoveredType]);
      quotas.set(key, (quotas.get(key) || 0) + site.quota);
    }
    return quotas;
  };
  const primaryCells = replacementCellQuotas(expansion);
  const supplementCells = replacementCellQuotas(expansionSupplement);
  assert.deepEqual(
    [...supplementCells.keys()].filter(key => !primaryCells.has(key)),
    [],
    "supplements must not spend reserve quota outside a primary replacement cell",
  );
  assert.deepEqual(
    [...primaryCells.keys()].filter(key => !supplementCells.has(key)),
    [],
    "every primary split/vertical/discoveredType cell needs a same-cell reserve",
  );
  assert.ok([...familySplits.values()].every(splits => splits.size === 1), "one site family must never cross evaluation splits");

  const allIds = new Set([...oldIds, ...expansionIds]);
  for (const id of ["tianyancha", "qichacha", "dianping", "meituan", "xiaohongshu", "eleme", "jd", "taobao", "zhipin", "lianjia"]) {
    assert.ok(allIds.has(id), `the 1,500-page plan is missing requested representative site ${id}`);
  }
});

test("upstream parity benchmark keeps three algorithms, independent provenance, and extract-only timings", () => {
  for (const name of ["legacy-readability", "qingzhou-current", "trafilatura-python"]) {
    assert.match(upstreamComparison, new RegExp(`["]${name}["]`), `${name} is missing`);
  }
  assert.match(upstreamComparison, /algorithmPairs\s*=\s*\[[\s\S]*legacy-readability[\s\S]*qingzhou-current[\s\S]*trafilatura-python/);
  assert.match(upstreamComparison, /createHash\("sha256"\)[\s\S]*digest\.update\(annotationsBytes\)[\s\S]*digest\.update\(relativePath\)[\s\S]*digest\.update\(bytes\)/);
  assert.doesNotMatch(upstreamComparison, /eval_baseline\.json/, "the runner must calculate the combined corpus digest itself");
  assert.match(upstreamComparison, /kind:\s*"extract-only"[\s\S]*meanMs[\s\S]*p50Ms[\s\S]*p95Ms[\s\S]*maxMs/);
  assert.match(upstreamComparison, /sourceSha256:[\s\S]*readability:[\s\S]*articleExtractor:[\s\S]*comparisonRunner:[\s\S]*upstreamRunner:/);
  assert.match(upstreamComparison, /runtime:[\s\S]*node:[\s\S]*playwright:[\s\S]*chromium:[\s\S]*python:[\s\S]*trafilatura:/);
  assert.match(upstreamComparison, /languageStrata:[\s\S]*languageStrataReport/);
  assert.match(upstreamComparison, /declared-English[\s\S]*declared-German[\s\S]*other\/unknown/);
  assert.match(upstreamRunner, /item_started\s*=\s*time\.perf_counter_ns\(\)[\s\S]*extract\([\s\S]*timings_ms\[url\]/);
  assert.match(upstreamRunner, /"corpusSha256":\s*args\.corpus_sha256/);
});

test("reranker all-candidate contract includes the shipped Tree-DP candidate", t => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) return t.skip("python3 is unavailable");
  const result = spawnSync("python3", [
    "-c",
    "import json,runpy,sys; value=runpy.run_path(sys.argv[1], run_name='__contract__'); print(json.dumps(value['CANDIDATE_SETS']))",
    rerankerEvaluator,
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const candidateSets = JSON.parse(result.stdout);
  assert.deepEqual(candidateSets.core, ["rules", "readability"]);
  assert.deepEqual(candidateSets.all, INTERNAL_CANDIDATE_KEYS);
});

test("real-world corpus compose creates a self-contained, deterministic, content-addressed corpus", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-corpus-compose-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const baseDirectory = join(fixtureRoot, "base");
  const incrementDirectory = join(fixtureRoot, "increment");
  const baseSamples = [
    fixtureSample(baseDirectory, "alpha", "https://example.com/a?utm_source=test#top", { screenshot: Buffer.from("alpha-jpeg") }),
    fixtureSample(baseDirectory, "beta", "https://example.com/b"),
  ];
  const incrementSamples = [fixtureSample(incrementDirectory, "gamma", "https://example.net/c")];
  writeFixtureCorpus(baseDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    capturedAt: "2026-08-13T00:00:00.000Z",
    config: "base-plan.json",
    environment: { browser: "base-browser" },
    target: 2,
    captured: 2,
    samples: baseSamples,
    failures: [{ failure: "base-failure" }],
    provenance: { capture: "base" },
  });
  writeFixtureCorpus(incrementDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    capturedAt: "2026-08-14T00:00:00.000Z",
    config: "increment-plan.json",
    environment: { browser: "increment-browser" },
    target: 1,
    captured: 1,
    samples: incrementSamples,
    failures: [{ failure: "increment-failure" }],
    provenance: { capture: "increment" },
  });

  const outputA = join(fixtureRoot, "combined-a");
  const outputB = join(fixtureRoot, "combined-b");
  const first = runCompose(baseDirectory, incrementDirectory, outputA);
  const second = runCompose(baseDirectory, incrementDirectory, outputB);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const manifestA = JSON.parse(readFileSync(join(outputA, "manifest.json")));
  const manifestB = JSON.parse(readFileSync(join(outputB, "manifest.json")));
  assert.deepEqual(manifestA, manifestB, "the same two inputs must compose byte-stable manifests");
  assert.equal(manifestA.target, 3);
  assert.equal(manifestA.captured, 3);
  assert.deepEqual(manifestA.samples.map(item => item.id), ["core-0001", "core-0002", "core-0003"]);
  assert.deepEqual(manifestA.failures, [{ failure: "base-failure" }, { failure: "increment-failure" }]);
  assert.deepEqual(manifestA.samples[0].reference, baseSamples[0].reference);
  assert.deepEqual(manifestA.samples[0].captureEvidence, baseSamples[0].captureEvidence);
  for (const sample of manifestA.samples) {
    assert.equal(sample.snapshot, `snapshots/${sample.inputSha256}.html`);
    assert.ok(existsSync(join(outputA, sample.snapshot)), `${sample.snapshot} was not copied`);
    assert.equal(digest(readFileSync(join(outputA, sample.snapshot))), sample.inputSha256);
  }
  const screenshotSha256 = digest(Buffer.from("alpha-jpeg"));
  assert.equal(manifestA.samples[0].screenshot, `screenshots/${screenshotSha256}.jpeg`);
  assert.equal(readFileSync(join(outputA, manifestA.samples[0].screenshot), "utf8"), "alpha-jpeg");
  assert.equal(manifestA.provenance.kind, "composed-corpus");
  assert.equal(manifestA.provenance.identity, "canonical-final-url");
  assert.deepEqual(manifestA.provenance.sources.map(item => item.role), ["base", "increment"]);
  assert.deepEqual(manifestA.provenance.sources.map(item => item.provenance), [
    { capture: "base" },
    { capture: "increment" },
  ]);
  assert.doesNotMatch(JSON.stringify(manifestA), new RegExp(fixtureRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("real-world corpus compose identifies one final canonical URL as one page even when DOM hashes differ", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-corpus-compose-short-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const baseDirectory = join(fixtureRoot, "base");
  const incrementDirectory = join(fixtureRoot, "increment");
  const baseSample = fixtureSample(baseDirectory, "same-base-dom", "https://example.com/article?utm_source=base#one");
  const incrementSample = fixtureSample(incrementDirectory, "same-increment-dom", "https://example.com/article?utm_source=increment#two");
  assert.notEqual(baseSample.inputSha256, incrementSample.inputSha256, "the fixture must represent different hydrated DOM bytes");
  const manifest = samples => ({
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    capturedAt: "2026-08-14T00:00:00.000Z",
    target: 1,
    captured: 1,
    samples,
    failures: [],
  });
  writeFixtureCorpus(baseDirectory, manifest([baseSample]));
  writeFixtureCorpus(incrementDirectory, manifest([incrementSample]));
  const output = join(fixtureRoot, "combined");
  const result = runCompose(baseDirectory, incrementDirectory, output);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs 2 unique canonical URLs but inputs provide only 1/);
  assert.equal(existsSync(output), false, "an insufficient compose must not leave a partial corpus");
});

test("real-world corpus compose uses ordered supplements to fill URL-deduplication holes", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-corpus-compose-supplement-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const baseDirectory = join(fixtureRoot, "base");
  const incrementDirectory = join(fixtureRoot, "increment");
  const supplementDirectory = join(fixtureRoot, "supplement");
  const baseSample = fixtureSample(baseDirectory, "primary", "https://example.com/article?utm_source=base");
  const incrementDuplicate = fixtureSample(incrementDirectory, "redirected-copy", "https://example.com/article?utm_source=increment");
  const supplementSample = fixtureSample(supplementDirectory, "replacement", "https://example.net/replacement");
  assert.notEqual(baseSample.inputSha256, incrementDuplicate.inputSha256);
  const manifest = samples => ({
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    capturedAt: "2026-08-14T00:00:00.000Z",
    target: 1,
    captured: samples.length,
    samples,
    failures: [],
  });
  writeFixtureCorpus(baseDirectory, manifest([baseSample]));
  writeFixtureCorpus(incrementDirectory, manifest([incrementDuplicate]));
  writeFixtureCorpus(supplementDirectory, manifest([supplementSample]));

  const output = join(fixtureRoot, "combined");
  const result = runCompose(baseDirectory, incrementDirectory, output, [supplementDirectory]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const composed = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.equal(composed.target, 2, "supplement targets must not enlarge the base plus increment target");
  assert.deepEqual(composed.samples.map(sample => sample.siteId), ["primary", "replacement"]);
  assert.deepEqual(composed.provenance.sources.map(source => source.role), ["base", "increment", "supplement-1"]);
  for (const sample of composed.samples) {
    assert.equal(digest(readFileSync(join(output, sample.snapshot))), sample.inputSha256);
  }
});

test("real-world corpus compose fills v3 shortfalls only from the same split, vertical, and discovered type", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-corpus-compose-cells-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const baseDirectory = join(fixtureRoot, "base");
  const incrementDirectory = join(fixtureRoot, "increment");
  const supplementDirectory = join(fixtureRoot, "supplement");
  const wrongOnlyDirectory = join(fixtureRoot, "wrong-only");
  const cell = (evaluationSplit, vertical, discoveredType) => ({ evaluationSplit, vertical, discoveredType });
  const train = cell("train", "新闻", "detail");
  const testPlace = cell("test", "本地生活", "place");
  const baseSample = fixtureSample(baseDirectory, "legacy", "https://legacy.example/page", {
    html: "<html><body><main>跨地址保持一致的基础正文</main></body></html>",
  });
  const trainUniqueHtml = "<html><body><article>训练集中的唯一正文</article></body></html>";
  const frozenDomSha256 = "a".repeat(64);
  const incrementSamples = [
    fixtureSample(incrementDirectory, "train-duplicate-base", "https://train-duplicate-base.example/page", {
      html: "<html><body><article>跨地址保持一致的基础正文</article></body></html>",
      metadata: train,
    }),
    fixtureSample(incrementDirectory, "train-unique", "https://train-unique.example/page", {
      html: trainUniqueHtml,
      metadata: train,
    }),
    fixtureSample(incrementDirectory, "test-one", "https://test-one.example/page", {
      html: "<html><body><main>本地生活详情的共同正文</main></body></html>",
      metadata: { ...testPlace, captureEvidence: { frozenDomSha256 } },
    }),
    fixtureSample(incrementDirectory, "test-duplicate-text", "https://test-duplicate-text.example/page", {
      html: "<html><body><section>本地生活详情的共同正文</section></body></html>",
      metadata: testPlace,
    }),
  ];
  const inputDuplicate = fixtureSample(
    supplementDirectory,
    "input-duplicate",
    "https://input-duplicate.example/page",
    { html: trainUniqueHtml, metadata: train },
  );
  const trainReplacement = fixtureSample(
    supplementDirectory,
    "train-replacement",
    "https://train-replacement.example/page",
    { metadata: train },
  );
  const frozenDomDuplicate = fixtureSample(
    supplementDirectory,
    "frozen-dom-duplicate",
    "https://frozen-dom-duplicate.example/page",
    { metadata: { ...testPlace, captureEvidence: { frozenDomSha256 } } },
  );
  const testReplacement = fixtureSample(
    supplementDirectory,
    "test-replacement",
    "https://test-replacement.example/page",
    { metadata: testPlace },
  );
  const unusedCorrectReplacement = fixtureSample(
    supplementDirectory,
    "unused-correct-replacement",
    "https://unused-correct-replacement.example/page",
    { metadata: testPlace },
  );
  writeFixtureCorpus(baseDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: 1,
    captured: 1,
    samples: [baseSample],
    failures: [],
  });
  writeFixtureCorpus(incrementDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: 4,
    captured: 4,
    samples: incrementSamples,
    failures: [],
    replacementPlan: {
      dimensions: ["evaluationSplit", "vertical", "discoveredType"],
      cells: [
        { ...train, quota: 2 },
        { ...testPlace, quota: 2 },
      ],
    },
  });
  writeFixtureCorpus(supplementDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: 5,
    captured: 5,
    samples: [inputDuplicate, trainReplacement, frozenDomDuplicate, testReplacement, unusedCorrectReplacement],
    failures: [],
  });

  const output = join(fixtureRoot, "combined");
  const result = runCompose(baseDirectory, incrementDirectory, output, [supplementDirectory]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const composed = JSON.parse(readFileSync(join(output, "manifest.json")));
  assert.equal(composed.target, 5, "supplement inventory must not enlarge the base plus increment target");
  assert.equal(composed.captured, 5);
  assert.deepEqual(composed.samples.map(sample => sample.siteId), [
    "legacy",
    "train-unique",
    "test-one",
    "train-replacement",
    "test-replacement",
  ]);
  const expansionSamples = composed.samples.slice(1);
  assert.deepEqual(Object.fromEntries(["train", "validation", "test"].map(split => [
    split,
    expansionSamples.filter(sample => sample.evaluationSplit === split).length,
  ])), { train: 2, validation: 0, test: 2 });
  assert.equal(expansionSamples.filter(sample => sample.vertical === "本地生活" && sample.discoveredType === "place").length, 2);
  assert.equal(composed.provenance.selection.mode, "replacement-cell");
  assert.deepEqual(composed.provenance.selection.selectedBySource, { increment: 2, "supplement-1": 2 });
  assert.deepEqual(composed.provenance.selection.exactDuplicatesSkipped, {
    canonicalUrl: 0,
    inputDom: 1,
    frozenDom: 1,
    normalizedText: 3,
  });

  mkdirSync(wrongOnlyDirectory, { recursive: true });
  const wrongOnlySample = fixtureSample(
    wrongOnlyDirectory,
    "wrong-only-replacement",
    "https://wrong-only-replacement.example/page",
    { metadata: train },
  );
  writeFixtureCorpus(wrongOnlyDirectory, {
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: 1,
    captured: 1,
    samples: [wrongOnlySample],
    failures: [],
  });
  const failedOutput = join(fixtureRoot, "failed-combined");
  const failed = runCompose(baseDirectory, incrementDirectory, failedOutput, [wrongOnlyDirectory]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /test\/本地生活\/place: 1/);
  assert.equal(existsSync(failedOutput), false);
});

test("real-world corpus compose leaves no partial output when supplements remain insufficient", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-corpus-compose-supplement-short-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const baseDirectory = join(fixtureRoot, "base");
  const incrementDirectory = join(fixtureRoot, "increment");
  const supplementDirectory = join(fixtureRoot, "supplement");
  const url = "https://example.com/same-page";
  const manifest = samples => ({
    schema: "qingzhou.article-extraction-corpus.v1",
    suite: "core",
    target: 1,
    captured: samples.length,
    samples,
    failures: [],
  });
  writeFixtureCorpus(baseDirectory, manifest([fixtureSample(baseDirectory, "base-dom", url)]));
  writeFixtureCorpus(incrementDirectory, manifest([fixtureSample(incrementDirectory, "increment-dom", url)]));
  writeFixtureCorpus(supplementDirectory, manifest([fixtureSample(supplementDirectory, "supplement-dom", url)]));

  const output = join(fixtureRoot, "combined");
  const result = runCompose(baseDirectory, incrementDirectory, output, [supplementDirectory]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /needs 2 unique canonical URLs but inputs provide only 1/);
  assert.equal(existsSync(output), false);
  assert.deepEqual(
    readdirSync(fixtureRoot).filter(name => name.startsWith("combined.compose-")),
    [],
    "an insufficient supplement must not leave a temporary corpus",
  );
});

test("snapshot sanitization neutralizes object payloads without deleting hydrated fallback content", t => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qingzhou-sanitize-object-"));
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const corpus = join(fixtureRoot, "corpus");
  mkdirSync(join(corpus, "snapshots"), { recursive: true });
  const html = Buffer.from(`<html><body><main><object data="https://external.invalid/widget" type="text/html"><param name="src" value="https://external.invalid/payload"><section id="hydrated-card">服务端已经渲染完成的十九张可见内容卡片</section><embed src="https://external.invalid/plugin"></object><iframe src="https://external.invalid/frame"><p>不可保留的 iframe fallback</p></iframe></main></body></html>`);
  const inputSha256 = digest(html);
  const snapshot = `snapshots/${inputSha256}.html`;
  writeFileSync(join(corpus, snapshot), html);
  writeFixtureCorpus(corpus, {
    schema: "qingzhou.article-extraction-corpus.v1",
    target: 1,
    captured: 1,
    samples: [{ id: "core-0001", siteId: "fixture", inputSha256, snapshot }],
    failures: [],
  });
  const result = spawnSync(process.execPath, [realworldRunner, "sanitize", "--corpus", corpus], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json")));
  const sanitized = readFileSync(join(corpus, manifest.samples[0].snapshot), "utf8");
  assert.match(sanitized, /id="hydrated-card">服务端已经渲染完成的十九张可见内容卡片/);
  assert.doesNotMatch(sanitized, /<(?:object|param|embed|iframe)\b|external\.invalid|不可保留的 iframe fallback/i);
});
