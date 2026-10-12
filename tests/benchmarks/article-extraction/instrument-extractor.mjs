import { tokenizer } from "acorn";

// Match JavaScript tokens so TypeScript compilation may change indentation or comments.
// Each seam still requires its exact token sequence and expected occurrence count.
function replaceCodeAnchor(source, anchor, replacement, expected, label) {
  const scan = value => Array.from(tokenizer(value, { ecmaVersion: "latest", sourceType: "module" }), token => ({
    key: `${token.type.label}:${JSON.stringify(token.value)}`, start: token.start, end: token.end,
  })).filter((token, index, tokens) => {
    const label = offset => tokens[index + offset]?.key.split(":")[0];
    if (token.key.startsWith(",:") && ["}", "]", ")"].includes(label(1))) return false;
    if (label(0) === "(" && label(1) === "name" && label(2) === ")" && label(3) === "=>") return false;
    if (label(0) === ")" && label(-1) === "name" && label(-2) === "(" && label(1) === "=>") return false;
    return true;
  });
  const tokens = scan(source), needle = scan(anchor), matches = [];
  for (let index = 0; index <= tokens.length - needle.length; index++) {
    if (!needle.every((token, offset) => token.key === tokens[index + offset].key)) continue;
    matches.push([tokens[index].start, tokens[index + needle.length - 1].end]);
    index += needle.length - 1;
  }
  if (matches.length !== expected) throw new Error(`article extractor benchmark ${label} anchor must occur exactly ${expected} times; found ${matches.length}`);
  for (const [start, end] of matches.reverse()) source = source.slice(0, start) + replacement + source.slice(end);
  return source;
}

const EXPORT_ANCHOR = "host.QingzhouArticleExtractor = Object.freeze({ extract });";
const TREE_DP_FUNCTION_ANCHOR = `  function treeDpExtract(doc) {
    const body = doc?.body;`;
const TREE_DP_DIAGNOSTICS_ANCHOR = `    let retainedTokens = 0;
    let retainedAnchorTokens = 0;
    let retainedBoilerplateTokens = 0;
    for (let index = 0; index < total; index += 1) {
      if (!retained[index]) continue;
      retainedTokens += ownTokens[index];
      if (nodes[index].anchor) retainedAnchorTokens += ownTokens[index];
      if (nodes[index].boilerplateHits) retainedBoilerplateTokens += ownTokens[index];
    }
    if (retainedTokens < TREE_DP_GUARD_MIN_TOKENS) return null;`;
const EXTRACT_FUNCTION_ANCHOR = `  function extract(doc, { readability, complete = false } = {}) {
    if (!doc?.body) return null;`;
const EXTRACT_LEGACY_ANCHOR = `    const legacy = chosen || readable || custom || getBaseline();
    let selected = legacy;`;
const EXTRACT_HAN_GATE_ANCHOR = `    if (hanDominantDocument(doc)) {
      // Reject obvious non-rescue cases before the more expensive structural
      // status walk. The selector still rechecks against the cleaned page text.
      const visiblePageLength = normalizedText(doc.body?.textContent || "").length;
      const legacyPageShare = legacy && visiblePageLength ? legacy.length / visiblePageLength : 0;
      if (legacyPageShare <= TREE_DP_RESCUE_PREFLIGHT_MAX_LEGACY_PAGE_SHARE) {`;
const EXTRACT_LEGACY_STATUS_ANCHOR = `        const legacyStatus = legacy
          ? pageCandidateStatus(legacy, doc, { requireCentralCollection: true })
          : null;
        if (!legacyCandidateIsSafe(legacy, doc, legacyStatus)) {`;
const EXTRACT_TREE_SELECTION_ANCHOR = `          let treeDp = null;
          try {
            treeDp = treeDpExtract(doc);
          } catch (_error) {
            treeDp = null;
          }
          selected = selectTreeDpCandidate(treeDp, legacy, doc, {
            allowConfidenceOverride: complete,
            getPageLength,
            treeCandidateStatus: treeDp
              ? pageCandidateStatus(treeDp, doc, { requireCentralCollection: true })
              : null,
          });`;
const EXTRACT_RESULT_ANCHOR = `    const status = complete && selected ? pageCandidateStatus(selected, doc) : null;
    const fallback = status && !status.complete
      ? centralPageCandidate(doc)
      : null;
    const result = fallback && (fallback.length >= selected.length || status.disjoint && fallback.length >= MIN_CONTENT_LENGTH) ? fallback : selected;
    return withMetadata(result, readability);`;
const MAKE_CANDIDATE_FUNCTION_ANCHOR = "  function makeCandidate(name, root) {";
const TOP_LEVEL_MATCHES_FUNCTION_ANCHOR = "  function topLevelMatches(doc, selectors) {";
const CLONE_REWRITES = Object.freeze([
  {
    anchor: "    return doc.cloneNode(true);",
    replacement: "    return qingzhouBenchmarkCloneNode(doc, true);",
    expected: 1,
    label: "document clone",
  },
  {
    anchor: "    const metadata = safeQueryAll(doc, metadataSelector).map(element => element.cloneNode(true));",
    replacement: "    const metadata = safeQueryAll(doc, metadataSelector).map(element => qingzhouBenchmarkCloneNode(element, true));",
    expected: 1,
    label: "metadata clone",
  },
  {
    anchor: "    const backup = root.cloneNode(true);",
    replacement: "    const backup = qingzhouBenchmarkCloneNode(root, true);",
    expected: 1,
    label: "pruning backup clone",
  },
  {
    anchor: "      wrapper.append(element.cloneNode(true));",
    replacement: "      wrapper.append(qingzhouBenchmarkCloneNode(element, true));",
    expected: 2,
    label: "selected element clones",
  },
  {
    anchor: "    wrapper.append(...[...root.childNodes].map(node => node.cloneNode(true)));",
    replacement: "    wrapper.append(...[...root.childNodes].map(node => qingzhouBenchmarkCloneNode(node, true)));",
    expected: 1,
    label: "root child clones",
  },
  {
    anchor: "    const searchRoot = pruneSections(cleanedDoc.body?.cloneNode(true), { focus });",
    replacement: "    const searchRoot = pruneSections(qingzhouBenchmarkCloneNode(cleanedDoc.body, true), { focus });",
    expected: 1,
    label: "recovery root clone",
  },
  {
    anchor: "    const clone = pageContentRoot(doc)?.cloneNode(true);",
    replacement: "    const clone = qingzhouBenchmarkCloneNode(pageContentRoot(doc), true);",
    expected: 1,
    label: "central page clone",
  },
  {
    anchor: "      const candidate = pruneSections(node.cloneNode(true), { focus });",
    replacement: "      const candidate = pruneSections(qingzhouBenchmarkCloneNode(node, true), { focus });",
    expected: 1,
    label: "rule root clone",
  },
  {
    anchor: "      const clone = nodes[rootIndex].element.cloneNode(true);",
    replacement: "      const clone = qingzhouBenchmarkCloneNode(nodes[rootIndex].element, true);",
    expected: 1,
    label: "Tree-DP root clone",
  },
]);

export const INTERNAL_CANDIDATE_KEYS = Object.freeze([
  "rules",
  "readability",
  "paragraph",
  "baseline",
  "recall",
  "treedp",
]);

const BENCHMARK_PROBE = `
  const qingzhouProductExtract = extract;
  const qingzhouBenchmarkReadabilityRegexps = Object.freeze({
    unlikely: /-ad-|ai2html|banner|breadcrumbs|combx|comment|community|cover-wrap|disqus|extra|footer|gdpr|header|legends|menu|related|remark|replies|rss|shoutbox|sidebar|skyscraper|social|sponsor|supplemental|ad-break|agegate|pagination|pager|popup|yom-remote/i,
    okMaybe: /and|article|body|column|content|main|shadow/i,
    positive: /article|body|content|entry|hentry|h-entry|main|page|pagination|post|text|blog|story/i,
    negative: /-ad-|hidden|^hid$| hid$| hid |^hid |banner|combx|comment|com-|contact|footer|gdpr|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|widget/i,
    extraneous: /print|archive|comment|discuss|e[\\-]?mail|share|reply|all|login|sign|single|utility/i,
    byline: /byline|author|dateline|writtenby|p-author/i,
    share: /(\\b|_)(share|sharedaddy)(\\b|_)/i,
  });
  const qingzhouBenchmarkReadabilityRejectedRoles = new Set([
    "menu", "menubar", "complementary", "navigation", "alert", "alertdialog", "dialog",
  ]);
  let qingzhouBenchmarkCandidates = new Map();
  let qingzhouBenchmarkForcedCandidate = null;
  let qingzhouBenchmarkLastExtractText = null;
  const qingzhouBenchmarkNodeProvenance = new WeakMap();
  const qingzhouBenchmarkCandidateProvenance = new WeakMap();
  let qingzhouBenchmarkGoldTextState = new WeakMap();
  let qingzhouBenchmarkProvenanceContext = null;
  let qingzhouBenchmarkTrackCloneProvenance = false;
  let qingzhouBenchmarkTrackGoldProvenance = false;

  function qingzhouBenchmarkVisibleChars(value) {
    return String(value || "").replace(/\\s/gu, "").length;
  }

  function qingzhouBenchmarkAlignmentText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\\u200b-\\u200f\\ufeff]/g, "")
      .replace(/\\s+/g, " ")
      .trim();
  }

  function qingzhouBenchmarkCloneNode(source, deep = false) {
    if (!source || typeof source.cloneNode !== "function") return null;
    const clone = source.cloneNode(Boolean(deep));
    if (!qingzhouBenchmarkTrackCloneProvenance && !qingzhouBenchmarkTrackGoldProvenance) return clone;
    const stack = [[source, clone]];
    while (stack.length) {
      const [sourceNode, cloneNode] = stack.pop();
      if (qingzhouBenchmarkTrackCloneProvenance) {
        const provenance = qingzhouBenchmarkNodeProvenance.get(sourceNode);
        if (provenance) qingzhouBenchmarkNodeProvenance.set(cloneNode, provenance);
      }
      if (qingzhouBenchmarkTrackGoldProvenance && qingzhouBenchmarkGoldTextState.has(sourceNode)) {
        qingzhouBenchmarkGoldTextState.set(cloneNode, qingzhouBenchmarkGoldTextState.get(sourceNode));
      }
      if (!deep) continue;
      const sourceChildren = sourceNode.childNodes || [];
      const cloneChildren = cloneNode.childNodes || [];
      const length = Math.min(sourceChildren.length, cloneChildren.length);
      for (let index = 0; index < length; index += 1) {
        stack.push([sourceChildren[index], cloneChildren[index]]);
      }
    }
    return clone;
  }

  function qingzhouBenchmarkBeginGoldSelection(doc, selection) {
    qingzhouBenchmarkGoldTextState = new WeakMap();
    if (!selection) return null;
    const status = String(selection.status || "");
    if (status !== "extract" && status !== "exclude") {
      throw new Error("gold selection status must be extract or exclude");
    }
    const annotationAttribute = String(selection.annotationAttribute || "");
    const keptAnnotationValues = Array.isArray(selection.keptAnnotationValues)
      ? [...new Set(selection.keptAnnotationValues.map(String))]
      : [];
    if (annotationAttribute || keptAnnotationValues.length) {
      if (status !== "extract") {
        throw new Error("annotation gold selection is only valid for extract pages");
      }
      if (annotationAttribute !== "data-anno-uid" || !keptAnnotationValues.length) {
        throw new Error("annotation gold selection requires data-anno-uid values");
      }
      const requested = new Set(keptAnnotationValues);
      const occurrences = new Map();
      for (const element of doc.querySelectorAll("[" + annotationAttribute + "]")) {
        const value = String(element.getAttribute(annotationAttribute) || "");
        if (requested.has(value)) occurrences.set(value, (occurrences.get(value) || 0) + 1);
      }
      const unresolved = keptAnnotationValues.filter(value => occurrences.get(value) !== 1);
      if (unresolved.length) {
        throw new Error("annotation gold selection values must resolve exactly once: "
          + unresolved.slice(0, 20).join(", "));
      }
      let sourceTextUnits = 0;
      let keptTextUnits = 0;
      let unknownTextUnits = 0;
      const visit = (element, inheritedValue = null) => {
        const ownValue = element.hasAttribute?.(annotationAttribute)
          ? String(element.getAttribute(annotationAttribute) || "")
          : inheritedValue;
        for (const child of element.childNodes || []) {
          if (child.nodeType === 3) {
            if (!qingzhouBenchmarkVisibleChars(child.nodeValue || "")) continue;
            sourceTextUnits += 1;
            if (!ownValue) {
              unknownTextUnits += 1;
              continue;
            }
            const keep = requested.has(ownValue);
            qingzhouBenchmarkGoldTextState.set(child, keep);
            if (keep) keptTextUnits += 1;
          } else if (child.nodeType === 1) {
            visit(child, ownValue);
          }
        }
      };
      if (doc.body) visit(doc.body);
      return Object.freeze({
        schema: "qingzhou.article-extraction-annotation-gold-selection.v1",
        status,
        annotationAttribute,
        requestedValues: keptAnnotationValues.length,
        resolvedValues: keptAnnotationValues.length,
        sourceTextUnits,
        keptTextUnits,
        unknownTextUnits,
      });
    }
    const includeIds = Array.isArray(selection.includeRegionIds)
      ? [...new Set(selection.includeRegionIds.map(String))]
      : [];
    const excludeIds = Array.isArray(selection.excludeRegionIds)
      ? [...new Set(selection.excludeRegionIds.map(String))]
      : [];
    if (status === "extract" && !includeIds.length) {
      throw new Error("extract gold selection requires an included region");
    }
    if (status === "exclude" && (includeIds.length || excludeIds.length)) {
      throw new Error("exclude gold selection cannot contain regions");
    }
    const hiddenByMarkup = (element) => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden
          || node.getAttribute("aria-hidden") === "true"
          || /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i.test(node.getAttribute("style") || "")) {
          return true;
        }
      }
      return false;
    };
    const visibleText = element => qingzhouBenchmarkAlignmentText(element?.innerText || "");
    const semanticRegionSelector = [
      "body", "main", "article", "[role='main']", "[role='article']", "[itemprop='articleBody']",
      "header", "nav", "aside", "footer", "dialog", "form", "figure",
      "[role='banner']", "[role='navigation']", "[role='complementary']", "[role='contentinfo']",
      "[role='dialog']", "[role='alertdialog']",
      "[itemtype$='/VideoObject']", "[itemtype$='/ImageObject']",
    ].join(",");
    const regionSelector = semanticRegionSelector + ",section,div,ul,ol,dl,table";
    const allRegions = [...doc.querySelectorAll(regionSelector)].filter(element => (
      !hiddenByMarkup(element)
      && visibleText(element).length >= (element.matches(semanticRegionSelector) ? 2 : 40)
    ));
    const semantic = new Set(allRegions.filter(element => element.matches(semanticRegionSelector)));
    const generic = allRegions
      .filter(element => !semantic.has(element))
      .sort((left, right) => visibleText(right).length - visibleText(left).length)
      .slice(0, 180);
    const keptRegions = new Set([...semantic, ...generic]);
    const regionElements = allRegions.filter(element => keptRegions.has(element));
    const regionById = new Map(regionElements.map((element, index) => [
      "R" + String(index + 1).padStart(4, "0"),
      element,
    ]));
    const missingInclude = includeIds.filter(id => !regionById.has(id));
    const missingExclude = excludeIds.filter(id => !regionById.has(id));
    if (missingInclude.length || missingExclude.length) {
      throw new Error("gold selection references unknown regions: "
        + [...missingInclude, ...missingExclude].join(", "));
    }
    const included = includeIds.map(id => regionById.get(id));
    const excluded = excludeIds.map(id => regionById.get(id));
    if (included.some((element, index) => included.some((other, otherIndex) => (
      index !== otherIndex && other.contains(element)
    )))) {
      throw new Error("gold included regions must not contain one another");
    }
    if (excluded.some(element => !included.some(root => root !== element && root.contains(element)))) {
      throw new Error("gold excluded regions must be strict descendants of an included region");
    }
    const includedSet = new Set(included);
    const excludedSet = new Set(excluded);
    let sourceTextUnits = 0;
    let keptTextUnits = 0;
    (function visit(element, state) {
      const next = {
        included: state.included || includedSet.has(element),
        excluded: state.excluded || excludedSet.has(element),
      };
      for (const child of element.childNodes || []) {
        if (child.nodeType === 3) {
          if (!qingzhouBenchmarkVisibleChars(child.nodeValue || "")) continue;
          const keep = status === "extract" && next.included && !next.excluded;
          qingzhouBenchmarkGoldTextState.set(child, keep);
          sourceTextUnits += 1;
          if (keep) keptTextUnits += 1;
        } else if (child.nodeType === 1) {
          visit(child, next);
        }
      }
    })(doc.body, { included: false, excluded: false });
    return Object.freeze({
      schema: "qingzhou.article-extraction-tree-dp-gold-selection.v1",
      status,
      requestedInclude: includeIds.length,
      resolvedInclude: included.length,
      requestedExclude: excludeIds.length,
      resolvedExclude: excluded.length,
      sourceTextUnits,
      keptTextUnits,
    });
  }

  function qingzhouBenchmarkBeginProvenance(doc) {
    const context = {
      elements: [],
      units: [],
      treeElements: [],
      treeTextSegments: [],
      sourceChars: 0,
      normalizedFrequency: new Map(),
      goldSelection: null,
    };
    const readabilityPhrasingTags = new Set([
      "abbr", "audio", "b", "bdo", "br", "button", "cite", "code", "data",
      "datalist", "dfn", "em", "embed", "i", "img", "input", "kbd", "label",
      "mark", "math", "meter", "noscript", "object", "output", "progress", "q",
      "ruby", "samp", "script", "select", "small", "span", "strong", "sub",
      "sup", "textarea", "time", "var", "wbr",
    ]);
    const readabilityIsPhrasing = (node) => {
      if (node.nodeType === 3) return true;
      if (node.nodeType !== 1) return false;
      const tag = String(node.tagName || "").toLowerCase();
      if (readabilityPhrasingTags.has(tag)) return true;
      if (tag !== "a" && tag !== "del" && tag !== "ins") return false;
      return Array.from(node.childNodes || []).every(readabilityIsPhrasing);
    };
    const readabilityPhrasingRuns = (element) => {
      if (String(element.tagName || "").toLowerCase() !== "div") return [];
      const runs = [];
      let text = "";
      const flush = () => {
        const normalized = String(text).trim().replace(/\s{2,}/g, " ");
        text = "";
        if (normalized.length < 25) return;
        const commas = (normalized.match(/[,،﹐︐︑⹁⸴⸲，]/g) || []).length;
        runs.push([normalized.length, commas]);
      };
      for (const node of element.childNodes || []) {
        if (readabilityIsPhrasing(node)) {
          const value = String(node.textContent || "");
          if (text || value.trim()) text += value;
        } else {
          flush();
        }
      }
      flush();
      return runs;
    };
    const siblingSignatureMetadata = new WeakMap();
    const siblingSignatureInfo = (element) => {
      const parent = element.parentElement;
      if (!parent) return { count: 1, group: 0, readabilityClassGroup: 0, hasClass: false };
      let metadata = siblingSignatureMetadata.get(parent);
      if (!metadata) {
        const counts = new Map();
        const groups = new Map();
        const readabilityClassGroups = new Map();
        for (const sibling of parent.children) {
          const className = typeof sibling.className === "string" ? sibling.className : "";
          const signature = \`\${sibling.tagName}|\${className}\`;
          counts.set(signature, (counts.get(signature) || 0) + 1);
          if (!groups.has(signature)) groups.set(signature, groups.size);
          if (!readabilityClassGroups.has(className)) {
            readabilityClassGroups.set(className, readabilityClassGroups.size);
          }
        }
        metadata = { counts, groups, readabilityClassGroups };
        siblingSignatureMetadata.set(parent, metadata);
      }
      const className = typeof element.className === "string" ? element.className : "";
      const signature = \`\${element.tagName}|\${className}\`;
      return {
        count: metadata.counts.get(signature) || 1,
        group: metadata.groups.get(signature) || 0,
        readabilityClassGroup: metadata.readabilityClassGroups.get(className) || 0,
        hasClass: className !== "",
      };
    };
    const treeElementState = (element, parentTreeIndex, state) => {
      if (!state || element.matches?.(TREE_DP_REMOVED_SELECTOR)) return null;
      if (element.hidden || element.getAttribute?.("aria-hidden") === "true") return null;
      const inlineStyle = element.getAttribute?.("style") || "";
      if (/display\\s*:\\s*none|visibility\\s*:\\s*(?:hidden|collapse)/i.test(inlineStyle)) return null;
      const tag = String(element.tagName || "").toLowerCase();
      const heading = /^h([1-6])$/.exec(tag);
      const className = typeof element.className === "string" ? element.className : "";
      const id = String(element.id || "");
      const classId = \`\${id} \${className}\`;
      let readabilityClassWeight = 0;
      let readabilityPositiveHits = 0;
      let readabilityNegativeHits = 0;
      for (const value of [className, id]) {
        if (!value) continue;
        if (qingzhouBenchmarkReadabilityRegexps.negative.test(value)) {
          readabilityClassWeight -= 25;
          readabilityNegativeHits += 1;
        }
        if (qingzhouBenchmarkReadabilityRegexps.positive.test(value)) {
          readabilityClassWeight += 25;
          readabilityPositiveHits += 1;
        }
      }
      const readabilityOkMaybe = qingzhouBenchmarkReadabilityRegexps.okMaybe.test(classId);
      const readabilityUnlikely = tag !== "body" && tag !== "a"
        && qingzhouBenchmarkReadabilityRegexps.unlikely.test(\`\${className} \${id}\`)
        && !qingzhouBenchmarkReadabilityRegexps.okMaybe.test(\`\${className} \${id}\`)
        && !element.parentElement?.closest?.("table,code");
      const readabilityRoleRejected = qingzhouBenchmarkReadabilityRejectedRoles.has(
        String(element.getAttribute?.("role") || "").toLowerCase(),
      );
      const sibling = siblingSignatureInfo(element);
      const next = {
        anchor: state.anchor || tag === "a",
        readabilityAnchorWeight: tag === "a"
          ? (String(element.getAttribute?.("href") || "").startsWith("#") ? 0.3 : 1)
          : state.readabilityAnchorWeight,
        listItem: state.listItem || tag === "li" || tag === "dt" || tag === "dd",
        boilerplateHits: state.boilerplateHits + (TREE_DP_BOILER_RE.test(classId) ? 1 : 0),
        contentHits: state.contentHits + (TREE_DP_CONTENT_RE.test(classId) ? 1 : 0),
        depth: state.depth + 1,
      };
      return {
        next,
        value: {
          parent: parentTreeIndex,
          tag,
          anchor: next.anchor,
          readabilityAnchorWeight: next.readabilityAnchorWeight,
          heading: heading ? Number(heading[1]) : 0,
          listItem: next.listItem,
          boilerplateHits: next.boilerplateHits,
          contentHits: next.contentHits,
          readabilityClassWeight,
          readabilityPositiveHits,
          readabilityNegativeHits,
          readabilityOkMaybe,
          readabilityExtraneous: qingzhouBenchmarkReadabilityRegexps.extraneous.test(classId),
          readabilityByline: qingzhouBenchmarkReadabilityRegexps.byline.test(classId),
          readabilityShare: qingzhouBenchmarkReadabilityRegexps.share.test(classId),
          readabilityUnlikely,
          readabilityRoleRejected,
          repeated: sibling.count,
          siblingGroup: sibling.group,
          readabilitySiblingClassGroup: sibling.readabilityClassGroup,
          readabilityHasClass: sibling.hasClass,
          readabilityPhrasingRuns: readabilityPhrasingRuns(element),
          depth: next.depth,
          ownRaw: [],
        },
      };
    };
    const visit = (element, parentElementIndex, parentTreeIndex, treeState) => {
      const elementIndex = context.elements.length;
      const tree = treeElementState(element, parentTreeIndex, treeState);
      const treeIndex = tree ? context.treeElements.length : -1;
      context.elements.push(Object.freeze({
        parentElementIndex,
        tag: String(element.tagName || "").toLowerCase(),
        treeIndex,
      }));
      if (tree) context.treeElements.push({ source: elementIndex, ...tree.value });
      for (const node of element.childNodes || []) {
        if (node.nodeType === 3) {
          const text = String(node.nodeValue || "");
          if (tree) {
            context.treeElements[treeIndex].ownRaw.push(text);
            context.treeTextSegments.push([
              treeIndex,
              text,
              qingzhouBenchmarkGoldTextState.has(node)
                ? qingzhouBenchmarkGoldTextState.get(node)
                : null,
            ]);
          }
          const chars = qingzhouBenchmarkVisibleChars(text);
          if (!chars) continue;
          const alignedText = qingzhouBenchmarkAlignmentText(text);
          const unit = Object.freeze({
            context,
            id: context.units.length,
            ownerElementIndex: elementIndex,
            ownerTreeIndex: treeIndex,
            text,
            alignedText,
            chars,
            tokens: alignedText ? treeDpTokens(alignedText) : 0,
            gold: qingzhouBenchmarkGoldTextState.has(node)
              ? qingzhouBenchmarkGoldTextState.get(node)
              : null,
          });
          context.units.push(unit);
          context.sourceChars += chars;
          context.normalizedFrequency.set(
            alignedText,
            (context.normalizedFrequency.get(alignedText) || 0) + 1,
          );
          qingzhouBenchmarkNodeProvenance.set(node, unit);
        } else if (node.nodeType === 1) {
          visit(
            node,
            elementIndex,
            tree ? treeIndex : -1,
            tree ? tree.next : null,
          );
        }
      }
    };
    if (doc?.body) visit(doc.body, -1, -1, {
      anchor: false,
      readabilityAnchorWeight: 0,
      listItem: false,
      boilerplateHits: 0,
      contentHits: 0,
      depth: 0,
    });
    const sourceUnitIdsByTreeElement = Array.from(
      { length: context.treeElements.length },
      () => [],
    );
    const goldStatesByTreeElement = Array.from(
      { length: context.treeElements.length },
      () => [],
    );
    for (const unit of context.units) {
      if (unit.ownerTreeIndex >= 0 && unit.tokens > 0) {
        sourceUnitIdsByTreeElement[unit.ownerTreeIndex].push(unit.id);
      }
      if (unit.ownerTreeIndex >= 0 && unit.gold !== null) {
        goldStatesByTreeElement[unit.ownerTreeIndex].push(unit.gold);
      }
    }
    for (const [index, element] of context.treeElements.entries()) {
      element.ownText = normalizedText(element.ownRaw.join(""));
      element.tokens = element.ownText ? treeDpTokens(element.ownText) : 0;
      element.ownChars = element.ownText.length;
      element.sourceUnitIds = Object.freeze(sourceUnitIdsByTreeElement[index]);
      const goldStates = goldStatesByTreeElement[index];
      element.goldKnown = Boolean(element.tokens && goldStates.length
        && goldStates.every(value => value === goldStates[0]));
      element.goldKeep = element.goldKnown ? goldStates[0] : null;
      delete element.ownRaw;
    }
    const pageTokens = context.treeElements.reduce((sum, element) => sum + element.tokens, 0);
    const anchorTokens = context.treeElements.reduce(
      (sum, element) => sum + (element.anchor ? element.tokens : 0),
      0,
    );
    const anchorShare = pageTokens ? anchorTokens / pageTokens : 0;
    for (const element of context.treeElements) {
      const text = element.ownText;
      const tokens = element.tokens;
      let category;
      if (element.heading) category = "h";
      else if (element.tag === "p") category = "p";
      else if (element.listItem && element.anchor) category = "a-ctx";
      else if (element.listItem) category = "li";
      else if (element.tag === "td" || element.tag === "th") category = "td";
      else if (element.anchor) category = "a-ctx";
      else category = "other";
      element.features = Object.freeze([
        category === "p" ? 1 : 0,
        category === "h" ? 1 : 0,
        category === "li" ? 1 : 0,
        category === "td" ? 1 : 0,
        category === "a-ctx" ? 1 : 0,
        category === "other" ? 1 : 0,
        element.anchor ? 1 : 0,
        Math.log1p(tokens),
        tokens ? (text.match(TREE_DP_PUNCT_RE) || []).length / tokens : 0,
        element.ownChars ? (text.match(TREE_DP_DIGIT_RE) || []).length / element.ownChars : 0,
        Math.min(3, element.boilerplateHits),
        Math.min(3, element.contentHits),
        Math.log1p(element.repeated),
        Math.min(30, element.depth) / 30,
        anchorShare,
        (element.anchor ? 1 : 0) * anchorShare,
      ]);
      let logit = TREE_DP_INTERCEPT;
      for (let index = 0; index < element.features.length; index += 1) {
        logit += TREE_DP_COEFFICIENTS[index] * element.features[index];
      }
      element.baseScore = tokens * logit;
      Object.freeze(element);
    }
    qingzhouBenchmarkProvenanceContext = context;
    return context;
  }

  function qingzhouBenchmarkCaptureCandidateProvenance(candidate) {
    const context = qingzhouBenchmarkProvenanceContext;
    if (!candidate?.root || !context) return;
    const retained = new Set();
    const duplicate = new Set();
    let outputChars = 0;
    let mappedChars = 0;
    let unmappedChars = 0;
    let changedSourceUnits = 0;
    const walker = candidate.root.ownerDocument?.createTreeWalker?.(candidate.root, 4);
    while (walker?.nextNode()) {
      const node = walker.currentNode;
      const value = String(node.nodeValue || "");
      const chars = qingzhouBenchmarkVisibleChars(value);
      if (!chars) continue;
      outputChars += chars;
      const unit = qingzhouBenchmarkNodeProvenance.get(node);
      if (!unit || unit.context !== context || value !== unit.text) {
        unmappedChars += chars;
        if (unit?.context === context) changedSourceUnits += 1;
        continue;
      }
      mappedChars += chars;
      if (retained.has(unit.id)) duplicate.add(unit.id);
      retained.add(unit.id);
    }
    qingzhouBenchmarkCandidateProvenance.set(candidate, Object.freeze({
      context,
      retained: Object.freeze([...retained].sort((left, right) => left - right)),
      duplicateSourceUnits: duplicate.size,
      changedSourceUnits,
      outputChars,
      mappedChars,
      unmappedChars,
    }));
  }

  function qingzhouBenchmarkCompressRanges(ids) {
    const ranges = [];
    for (const id of ids || []) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous[1] === id) previous[1] = id + 1;
      else ranges.push([id, id + 1]);
    }
    return ranges;
  }

  function qingzhouBenchmarkPositiveAlignment(candidate) {
    const context = qingzhouBenchmarkProvenanceContext;
    const strategy = String(candidate?.name || "");
    if (!candidate || !context) return { ids: [], chars: 0, reason: "candidate-unavailable" };
    if (strategy === "baseline-json" || strategy === "baseline-teaser") {
      return { ids: [], chars: 0, reason: "synthetic-metadata-candidate" };
    }
    const output = qingzhouBenchmarkAlignmentText(candidate.text);
    if (!output) return { ids: [], chars: 0, reason: "empty-candidate-text" };
    const matches = [];
    for (const unit of context.units) {
      const needle = unit.alignedText;
      if (qingzhouBenchmarkVisibleChars(needle) < 8) continue;
      if (context.normalizedFrequency.get(needle) !== 1) continue;
      const start = output.indexOf(needle);
      if (start < 0 || output.indexOf(needle, start + 1) >= 0) continue;
      matches.push({
        id: unit.id,
        start,
        end: start + needle.length,
        chars: unit.chars,
      });
    }
    let previousEnd = -1;
    for (const match of matches) {
      if (match.start < previousEnd) {
        return { ids: [], chars: 0, reason: "non-monotone-or-overlapping-matches" };
      }
      previousEnd = match.end;
    }
    return {
      ids: matches.map(match => match.id),
      chars: matches.reduce((sum, match) => sum + match.chars, 0),
      reason: matches.length ? "" : "no-unique-full-unit-match",
    };
  }

  function qingzhouBenchmarkCandidateProvenanceSnapshot(key, candidate) {
    const context = qingzhouBenchmarkProvenanceContext;
    const captured = candidate && qingzhouBenchmarkCandidateProvenance.get(candidate);
    const current = captured?.context === context ? captured : null;
    const clonePreserving = key === "rules" || key === "recall" || key === "treedp";
    const exact = Boolean(clonePreserving
      && current
      && current.outputChars > 0
      && current.mappedChars === current.outputChars
      && current.unmappedChars === 0
      && current.duplicateSourceUnits === 0
      && current.changedSourceUnits === 0
      && current.retained.length > 0);
    const positive = exact
      ? { ids: current.retained, chars: current.mappedChars, reason: "" }
      : qingzhouBenchmarkPositiveAlignment(candidate);
    let reason = "";
    if (!candidate) reason = "candidate-unavailable";
    else if (positive.ids.length) reason = "unique-monotone-positive-evidence";
    else if (positive.reason === "synthetic-metadata-candidate") reason = positive.reason;
    else if (!clonePreserving) reason = "candidate-reconstructs-text";
    else if (!current) reason = "provenance-unavailable";
    else if (current.changedSourceUnits) reason = "source-text-mutated";
    else if (current.duplicateSourceUnits) reason = "duplicate-source-unit";
    else if (current.unmappedChars) reason = "unmapped-output-text";
    else if (!current.retained.length) reason = "empty-source-mask";
    const outputChars = current?.outputChars || 0;
    const mappedChars = current?.mappedChars || 0;
    const exactRetained = exact ? current.retained : [];
    return {
      schema: "qingzhou.article-extraction-candidate-provenance.v1",
      coordinate: "prepared-dom-nonempty-text-node-preorder-v1",
      rangeEncoding: "zero-based-half-open",
      exact,
      status: exact ? "exact" : (positive.ids.length ? "positive-only" : (mappedChars > 0 ? "mixed" : "unmapped")),
      reason,
      evidenceMode: exact
        ? "exact-clone-mask"
        : (positive.ids.length ? "unique-monotone-full-unit" : "none"),
      unmatchedUnitSemantics: exact ? "drop" : "unknown",
      sourceUnitCount: context?.units.length || 0,
      retainedUnitCount: exactRetained.length,
      retainedRanges: qingzhouBenchmarkCompressRanges(exactRetained),
      positiveUnitCount: positive.ids.length,
      positiveRanges: qingzhouBenchmarkCompressRanges(positive.ids),
      positiveChars: positive.chars,
      positiveCoverage: outputChars ? Math.min(1, positive.chars / outputChars) : 0,
      outputChars,
      mappedChars,
      unmappedChars: current ? current.unmappedChars : outputChars,
      coverage: outputChars ? mappedChars / outputChars : 0,
      duplicateSourceUnits: current?.duplicateSourceUnits || 0,
      changedSourceUnits: current?.changedSourceUnits || 0,
    };
  }

  function qingzhouBenchmarkProvenanceSnapshot(candidates) {
    const context = qingzhouBenchmarkProvenanceContext;
    const snapshots = {};
    for (const key of ${JSON.stringify(INTERNAL_CANDIDATE_KEYS)}) {
      snapshots[key] = qingzhouBenchmarkCandidateProvenanceSnapshot(key, candidates.get(key));
    }
    return {
      schema: "qingzhou.article-extraction-provenance.v1",
      coordinate: "prepared-dom-nonempty-text-node-preorder-v1",
      rangeEncoding: "zero-based-half-open",
      sourceUnitCount: context?.units.length || 0,
      sourceChars: context?.sourceChars || 0,
      sourceTree: {
        elements: (context?.elements || []).map(element => ({
          parent: element.parentElementIndex,
          tag: element.tag,
          treeIndex: element.treeIndex,
        })),
        textUnits: (context?.units || []).map(unit => ({
          owner: unit.ownerElementIndex,
          treeOwner: unit.ownerTreeIndex,
          chars: unit.chars,
          tokens: unit.tokens,
          text: unit.text,
          gold: unit.gold,
        })),
        treeElements: (context?.treeElements || []).map(element => ({
          source: element.source,
          parent: element.parent,
          tag: element.tag,
          anchor: element.anchor,
          readabilityAnchorWeight: element.readabilityAnchorWeight,
          heading: element.heading,
          listItem: element.listItem,
          boilerplateHits: element.boilerplateHits,
          contentHits: element.contentHits,
          readabilityClassWeight: element.readabilityClassWeight,
          readabilityPositiveHits: element.readabilityPositiveHits,
          readabilityNegativeHits: element.readabilityNegativeHits,
          readabilityOkMaybe: element.readabilityOkMaybe,
          readabilityExtraneous: element.readabilityExtraneous,
          readabilityByline: element.readabilityByline,
          readabilityShare: element.readabilityShare,
          readabilityUnlikely: element.readabilityUnlikely,
          readabilityRoleRejected: element.readabilityRoleRejected,
          repeated: element.repeated,
          siblingGroup: element.siblingGroup,
          readabilitySiblingClassGroup: element.readabilitySiblingClassGroup,
          readabilityHasClass: element.readabilityHasClass,
          readabilityPhrasingRuns: element.readabilityPhrasingRuns,
          depth: element.depth,
          ownText: element.ownText,
          ownChars: element.ownChars,
          tokens: element.tokens,
          sourceUnitIds: element.sourceUnitIds,
          features: element.features,
          baseScore: element.baseScore,
          goldKnown: element.goldKnown,
          goldKeep: element.goldKeep,
        })),
        treeTextSegments: context?.treeTextSegments || [],
      },
      ...(context?.goldSelection ? { gold: context.goldSelection } : {}),
      candidates: snapshots,
    };
  }

  function qingzhouBenchmarkStatusSnapshot(status) {
    if (!status) return null;
    return {
      anchored: Boolean(status.anchored),
      anchoredShare: Number(status.anchoredShare) || 0,
      complete: Boolean(status.complete),
      disjoint: Boolean(status.disjoint),
      rootCoverage: Number(status.rootCoverage) || 0,
    };
  }

  function qingzhouBenchmarkCandidateSnapshot(candidate, pageLength, includeText = false) {
    if (!candidate) return null;
    const sourceText = String(candidate.text || "");
    return {
      available: true,
      strategy: candidate.name || "",
      rawOutputChars: candidate.length || 0,
      dirty: Boolean(candidate.dirty),
      features: qingzhouBenchmarkCandidateFeatures(candidate, pageLength),
      ...(includeText ? {
        sourceText: sourceText.slice(0, 80_000),
        truncated: sourceText.length > 80_000,
      } : {}),
    };
  }

  function qingzhouBenchmarkBuildTreeDpDiagnostics({
    nodes, ownTokens, pageTokens, anchorShare, children, subtreeTokens,
    keep, free, keepChoice, includeRoots, excluded, retained, retainedTokens,
    selectedKind, selectedRoot, selectedScore, emptyScore, ordinaryAvailable,
  }) {
    const includeRootTags = new Map();
    const rootMargins = [];
    const carveMargins = [];
    let rootCoverageTokens = 0;
    let largestRootTokens = 0;
    let excludedTokens = 0;
    let retainedAnchorTokens = 0;
    let retainedBoilerplateTokens = 0;
    let retainedContentTokens = 0;
    let invalidRootCount = 0;
    let hasBodyRoot = false;
    let hasOrphanListOrTableRoot = false;
    for (const root of includeRoots) {
      const sourceTag = String(nodes[root]?.tag || "").toLowerCase();
      const tag = sourceTag.toUpperCase();
      const hasDependentRoot = TREE_DP_DEPENDENT_ROOT_TAGS.has(sourceTag);
      includeRootTags.set(tag, (includeRootTags.get(tag) || 0) + 1);
      rootCoverageTokens += subtreeTokens[root] || 0;
      largestRootTokens = Math.max(largestRootTokens, subtreeTokens[root] || 0);
      if (tag === "BODY") hasBodyRoot = true;
      if (tag === "BODY" || hasDependentRoot) invalidRootCount += 1;
      if (hasDependentRoot) hasOrphanListOrTableRoot = true;
      const descend = children[root].reduce((sum, child) => sum + free[child], 0);
      rootMargins.push(
        (keep[root] - TREE_DP_ROOT_PENALTY - Math.max(0, descend))
          / Math.max(1, subtreeTokens[root]),
      );
    }
    for (const root of excluded) excludedTokens += subtreeTokens[root] || 0;
    for (let index = 0; index < nodes.length; index += 1) {
      if (!retained[index]) continue;
      const tokens = ownTokens[index] || 0;
      if (nodes[index].anchor) retainedAnchorTokens += tokens;
      if (nodes[index].boilerplateHits) retainedBoilerplateTokens += tokens;
      if (nodes[index].contentHits) retainedContentTokens += tokens;
      const choices = keepChoice[index] || [];
      for (let offset = 0; offset < children[index].length; offset += 1) {
        const child = children[index][offset];
        if (!(subtreeTokens[child] > 0)) continue;
        const excludePenalty = TREE_DP_EXCLUDE_PENALTY * Math.min(
          1,
          subtreeTokens[child] / TREE_DP_MIN_EXCLUDE_TOKENS,
        );
        const keptScore = keep[child];
        const excludedScore = -excludePenalty;
        const chosen = choices[offset] ? keptScore : excludedScore;
        const rejected = choices[offset] ? excludedScore : keptScore;
        carveMargins.push((chosen - rejected) / subtreeTokens[child]);
      }
    }
    const mean = values => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    return {
      schema: "qingzhou.article-extraction-tree-dp-diagnostics.v1",
      nodeCount: nodes.length,
      pageTokens,
      pageAnchorShare: anchorShare,
      bestDpScore: free[0] || 0,
      bestDpScorePerPageToken: pageTokens ? (free[0] || 0) / pageTokens : 0,
      actionModel: {
        schema: TREE_DP_ACTION_MODEL_ARTIFACT.schema,
        packedSha256: TREE_DP_ACTION_MODEL_ARTIFACT.packedSha256,
      },
      selectedAction: selectedKind,
      selectedRootIndex: selectedKind === "root" ? selectedRoot : null,
      selectedActionScore: selectedScore,
      emptyActionScore: emptyScore,
      ordinaryAvailable: Boolean(ordinaryAvailable),
      includeRootCount: includeRoots.length,
      includeRootTags: Object.fromEntries([...includeRootTags].sort(([left], [right]) => left.localeCompare(right))),
      invalidRootCount,
      hasBodyRoot,
      hasOrphanListOrTableRoot,
      retainedTokens,
      retainedTokenShare: pageTokens ? retainedTokens / pageTokens : 0,
      rootCoverageTokens,
      rootCoverageShare: pageTokens ? rootCoverageTokens / pageTokens : 0,
      excludedTokens,
      carvedShareOfRootCoverage: rootCoverageTokens ? excludedTokens / rootCoverageTokens : 0,
      largestRootTokens,
      largestRootShare: pageTokens ? largestRootTokens / pageTokens : 0,
      retainedAnchorShare: retainedTokens ? retainedAnchorTokens / retainedTokens : 0,
      retainedBoilerplateShare: retainedTokens ? retainedBoilerplateTokens / retainedTokens : 0,
      retainedContentShare: retainedTokens ? retainedContentTokens / retainedTokens : 0,
      minLocalRootDecisionMarginPerToken: rootMargins.length ? Math.min(...rootMargins) : null,
      meanLocalRootDecisionMarginPerToken: mean(rootMargins),
      minLocalCarveDecisionMarginPerToken: carveMargins.length ? Math.min(...carveMargins) : null,
      meanLocalCarveDecisionMarginPerToken: mean(carveMargins),
      guardPassed: retainedTokens >= TREE_DP_GUARD_MIN_TOKENS,
    };
  }

  function qingzhouBenchmarkTreeSelectorDiagnostics(
    treeDp,
    legacy,
    doc,
    treeStatus,
    getPageLength,
    { allowConfidenceOverride = false } = {},
  ) {
    if (!treeDp) return { treeAvailable: false };
    const confidence = TREE_DP_INTERNAL_DIAGNOSTICS.get(treeDp);
    const treeStructurallySafe = Boolean(confidence
      && !confidence.hasOrphanListOrTableRoot
      && !treeDp.dirty
      && treeStatus.anchoredShare >= TREE_DP_MIN_ANCHORED_SHARE
      && treeStatus.complete);
    const confidenceLengthPassed = !legacy || treeDp.length >= legacy.length;
    const preservesLegacy = treeDpPreservesLegacy(treeDp, legacy);
    const confidenceOverridePassed = Boolean(allowConfidenceOverride
      && treeStructurallySafe
      && confidence
      && confidence.includeRootCount === 1
      && !confidence.hasOrphanListOrTableRoot
      && confidence.retainedAnchorShare >= TREE_DP_CONFIDENT_MIN_RETAINED_ANCHOR_SHARE
      && confidence.retainedBoilerplateShare <= TREE_DP_CONFIDENT_MAX_RETAINED_BOILERPLATE_SHARE
      && Number.isFinite(confidence.minLocalRootDecisionMarginPerToken)
      && confidence.minLocalRootDecisionMarginPerToken
        >= TREE_DP_CONFIDENT_MIN_ROOT_MARGIN_PER_TOKEN
      && confidenceLengthPassed
      && preservesLegacy);
    if (confidenceOverridePassed) {
      return {
        treeAvailable: true,
        treeStructurallySafe,
        confidenceLengthPassed,
        preservesLegacy,
        confidenceOverrideAllowed: true,
        confidenceOverridePassed: true,
        clearGainPassed: null,
        allPassed: true,
      };
    }
    const comparablePageLength = getPageLength();
    const treeLinkShare = candidateLinkShare(treeDp);
    const legacyPageShare = legacy && comparablePageLength ? legacy.length / comparablePageLength : 0;
    const treePageShare = comparablePageLength ? treeDp.length / comparablePageLength : 0;
    const legacyPageSharePassed = legacyPageShare <= TREE_DP_RESCUE_MAX_LEGACY_PAGE_SHARE;
    const treeMinPageSharePassed = treePageShare >= TREE_DP_RESCUE_MIN_PAGE_SHARE;
    const treeMaxPageSharePassed = treePageShare < TREE_DP_MAX_PAGE_SHARE;
    const treeLinkSharePassed = treeLinkShare < TREE_DP_RESCUE_MAX_LINK_SHARE;
    const lengthRatioPassed = !legacy
      || treeDp.length >= TREE_DP_RESCUE_MIN_LENGTH_RATIO * legacy.length;
    return {
      treeAvailable: true,
      treeStructurallySafe,
      comparablePageLength,
      legacyPageShare,
      treePageShare,
      treeLinkShare,
      legacyPageSharePassed,
      treeMinPageSharePassed,
      treeMaxPageSharePassed,
      treeLinkSharePassed,
      lengthRatioPassed,
      confidenceLengthPassed,
      preservesLegacy,
      confidenceOverrideAllowed: Boolean(allowConfidenceOverride),
      confidenceOverridePassed: false,
      clearGainPassed: treeStructurallySafe
        && comparablePageLength > 0
        && legacyPageSharePassed
        && treeMinPageSharePassed
        && treeMaxPageSharePassed
        && treeLinkSharePassed
        && lengthRatioPassed
        && preservesLegacy,
      allPassed: treeStructurallySafe
        && comparablePageLength > 0
        && legacyPageSharePassed
        && treeMinPageSharePassed
        && treeMaxPageSharePassed
        && treeLinkSharePassed
        && lengthRatioPassed
        && preservesLegacy,
    };
  }

  function qingzhouBenchmarkProductDecisionSnapshot(trace, pageLength) {
    if (!trace) return null;
    return {
      schema: "qingzhou.article-extraction-product-decision.v1",
      completeRequested: trace.completeRequested,
      preTreeLegacy: qingzhouBenchmarkCandidateSnapshot(trace.preTreeLegacy, pageLength, true),
      hanDominant: trace.hanDominant,
      visiblePageLength: trace.visiblePageLength,
      legacyVisiblePageShare: trace.legacyVisiblePageShare,
      preflightPassed: trace.preflightPassed,
      legacyStatus: qingzhouBenchmarkStatusSnapshot(trace.legacyStatus),
      legacySafe: trace.legacySafe,
      treeAttempted: trace.treeAttempted,
      treeCandidate: qingzhouBenchmarkCandidateSnapshot(trace.treeCandidate, pageLength),
      treeCandidateStatus: qingzhouBenchmarkStatusSnapshot(trace.treeCandidateStatus),
      treeSelector: trace.treeSelector,
      treeSelected: trace.treeSelected,
      selectedBeforeCompleteStrategy: trace.selectedBeforeComplete?.name || "",
      completeStatus: qingzhouBenchmarkStatusSnapshot(trace.completeStatus),
      completeFallbackStrategy: trace.fallback?.name || "",
      completeFallbackSelected: trace.completeFallbackSelected,
      finalStrategy: trace.result?.name || "",
    };
  }

  function qingzhouBenchmarkCandidateFeatures(candidate, pageLength) {
    if (!candidate?.root) return null;
    const root = candidate.root;
    const blocks = safeQueryAll(root, "blockquote,h1,h2,h3,h4,h5,h6,li,p,pre,td,th")
      .map(textOf)
      .filter(Boolean);
    const blockLength = blocks.reduce((sum, text) => sum + text.length, 0);
    const links = collectLinkInfo(root);
    const text = normalizedText(candidate.text);
    const visibleCharacters = text.replace(/\\s/g, "").length;
    const cjkCharacters = (text.match(/[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]/gu) || []).length;
    const sentenceMarks = (text.match(/[。！？.!?]/g) || []).length;
    return {
      chars: candidate.length,
      pageShare: pageLength ? candidate.length / pageLength : 0,
      paragraphCount: candidate.paragraphCount,
      headingCount: candidate.headingCount,
      tableCount: candidate.tableCount,
      listItemCount: safeQueryAll(root, "li").length,
      imageCount: safeQueryAll(root, "img,picture").length,
      linkCount: links.count,
      linkTextShare: candidate.length ? links.length / candidate.length : 0,
      topLevelBlocks: root.children?.length || 0,
      averageBlockChars: blocks.length ? blockLength / blocks.length : 0,
      shortBlockShare: blocks.length ? blocks.filter(value => value.length < 24).length / blocks.length : 0,
      longBlockShare: blocks.length ? blocks.filter(value => value.length >= 120).length / blocks.length : 0,
      cjkShare: visibleCharacters ? cjkCharacters / visibleCharacters : 0,
      sentenceMarksPerK: candidate.length ? sentenceMarks * 1000 / candidate.length : 0,
      repeatedContentScore: repeatedContentScore(root),
      dirty: candidate.dirty,
    };
  }

  function qingzhouBenchmarkCollect(doc, { readability, provenance = false, goldSelection = null } = {}) {
    const provenanceEnabled = provenance === true;
    const gold = provenanceEnabled
      ? qingzhouBenchmarkBeginGoldSelection(doc, goldSelection)
      : null;
    const previousGoldTracking = qingzhouBenchmarkTrackGoldProvenance;
    qingzhouBenchmarkTrackGoldProvenance = Boolean(gold);
    try {
      doc = prepareDocument(doc);
    } finally {
      qingzhouBenchmarkTrackGoldProvenance = previousGoldTracking;
    }
    qingzhouBenchmarkProvenanceContext = null;
    qingzhouBenchmarkTrackCloneProvenance = false;
    if (provenanceEnabled) {
      const context = qingzhouBenchmarkBeginProvenance(doc);
      context.goldSelection = gold;
    }
    if (readability === undefined) readability = parseReadability(doc);
    qingzhouBenchmarkForcedCandidate = null;
    qingzhouBenchmarkCandidates = new Map();
    const collected = new Map();
    const errors = {};
    const elapsedMs = {};
    const attempt = (key, factory) => {
      const started = performance.now();
      const previousTracking = qingzhouBenchmarkTrackCloneProvenance;
      qingzhouBenchmarkTrackCloneProvenance = provenanceEnabled
        && (key === "rules" || key === "recall" || key === "treedp");
      try {
        const candidate = factory();
        if (candidate) collected.set(key, candidate);
      } catch (error) {
        errors[key] = \`\${error?.name || "Error"}: \${error?.message || error}\`;
      } finally {
        qingzhouBenchmarkTrackCloneProvenance = previousTracking;
        elapsedMs[key] = performance.now() - started;
      }
    };
    const rawReadability = parseReadabilityCandidate(doc, readability);
    attempt("rules", () => runCustomExtractor(doc, "balanced"));
    attempt("readability", () => sanitizeReadability(doc, rawReadability, "balanced"));
    attempt("paragraph", () => paragraphRescue(doc));
    attempt("baseline", () => baseline(doc));
    attempt("recall", () => runCustomExtractor(doc, "recall"));
    // The tree-DP candidate reuses the product implementation so benchmark
    // diagnostics always measure the shipped weights; the candidate itself
    // stays ungated even though the product auto path gates it to Han-dominant pages.
    attempt("treedp", () => treeDpExtract(doc));
    let forcedTreeDpDiagnostics = null;
    const previousTreeDiagnosticsActive = qingzhouBenchmarkTreeDiagnosticsActive;
    qingzhouBenchmarkTreeDiagnosticsActive = true;
    try {
      // Replay only the shipped Tree-DP body after its isolated timing sample.
      // The heavier benchmark diagnostics must never enter product or candidate
      // timing, including compare-upstream's optional Tree-DP row.
      treeDpExtract(doc);
      forcedTreeDpDiagnostics = qingzhouBenchmarkLastTreeDpDiagnostics;
    } finally {
      qingzhouBenchmarkTreeDiagnosticsActive = previousTreeDiagnosticsActive;
    }
    qingzhouBenchmarkCandidates = collected;

    const pageLength = pageTextLength(doc);
    let currentStrategy = "";
    let currentError = "";
    const previousProductDiagnosticsActive = qingzhouBenchmarkProductDiagnosticsActive;
    qingzhouBenchmarkProductDiagnosticsActive = true;
    try {
      currentStrategy = qingzhouProductExtract(doc, { readability, complete: true })?.name || "";
    } catch (error) {
      currentError = \`\${error?.name || "Error"}: \${error?.message || error}\`;
    } finally {
      qingzhouBenchmarkProductDiagnosticsActive = previousProductDiagnosticsActive;
    }
    return {
      page: {
        chars: pageLength,
        visibleChars: normalizedText(doc.body?.textContent || "").length,
        paragraphCount: safeQueryAll(doc.body, "p").length,
        headingCount: safeQueryAll(doc.body, "h1,h2,h3,h4,h5,h6").length,
        tableCount: safeQueryAll(doc.body, "table").length,
        listItemCount: safeQueryAll(doc.body, "li").length,
        linkCount: safeQueryAll(doc.body, "a").length,
      },
      currentStrategy,
      currentError,
      diagnostics: {
        schema: "qingzhou.article-extraction-benchmark-diagnostics.v1",
        candidateProvenanceEnabled: provenanceEnabled,
        forcedTreeDp: forcedTreeDpDiagnostics,
        ...(provenanceEnabled ? {
          provenance: qingzhouBenchmarkProvenanceSnapshot(collected),
        } : {}),
        productDecision: qingzhouBenchmarkProductDecisionSnapshot(
          qingzhouBenchmarkLastProductDecision,
          pageLength,
        ),
      },
      candidates: ${JSON.stringify(INTERNAL_CANDIDATE_KEYS)}.map(key => {
        const candidate = collected.get(key);
        return {
          key,
          available: Boolean(candidate),
          strategy: candidate?.name || "",
          error: errors[key] || "",
          elapsedMs: elapsedMs[key] || 0,
          features: qingzhouBenchmarkCandidateFeatures(candidate, pageLength),
          rawOutputChars: candidate?.length || 0,
          readabilityRawChars: key === "readability" ? (rawReadability?.length || 0) : undefined,
        };
      }),
    };
  }

  globalThis.__qingzhouArticleBenchmark = Object.freeze({
    collect: qingzhouBenchmarkCollect,
    force(key) {
      qingzhouBenchmarkForcedCandidate = null;
      const candidate = qingzhouBenchmarkCandidates.get(String(key || ""));
      if (!candidate) throw new Error(\`article benchmark candidate is unavailable: \${key}\`);
      qingzhouBenchmarkForcedCandidate = candidate;
      return { key, strategy: candidate.name };
    },
    clear() {
      qingzhouBenchmarkForcedCandidate = null;
    },
    clearLastExtractText() {
      qingzhouBenchmarkLastExtractText = null;
    },
    lastExtractText() {
      return qingzhouBenchmarkLastExtractText;
    },
  });

  globalThis.QingzhouArticleExtractor = Object.freeze({
    extract(...args) {
      const result = qingzhouBenchmarkForcedCandidate || qingzhouProductExtract(...args);
      qingzhouBenchmarkLastExtractText = result ? String(result.text || "") : null;
      return result;
    },
  });`;

export function instrumentArticleExtractorSource(source) {
  const value = String(source || "");
  const replaceSingle = (input, anchor, replacement, label) => replaceCodeAnchor(input, anchor, replacement, 1, label);
  const replaceExpected = (input, anchor, replacement, expected, label) => replaceCodeAnchor(input, anchor, replacement, expected, label);
  const exportOccurrences = value.split(EXPORT_ANCHOR).length - 1;
  if (exportOccurrences !== 1) {
    throw new Error(`article extractor benchmark export anchor must occur exactly once; found ${exportOccurrences}`);
  }
  let instrumented = replaceSingle(value, TREE_DP_FUNCTION_ANCHOR, `  let qingzhouBenchmarkLastTreeDpDiagnostics = null;
  let qingzhouBenchmarkLastProductDecision = null;
  let qingzhouBenchmarkTreeDiagnosticsActive = false;
  let qingzhouBenchmarkProductDiagnosticsActive = false;

  function treeDpExtract(doc) {
    if (qingzhouBenchmarkTreeDiagnosticsActive) qingzhouBenchmarkLastTreeDpDiagnostics = null;
    const body = doc?.body;`, "Tree-DP function");
  instrumented = replaceSingle(instrumented, TREE_DP_DIAGNOSTICS_ANCHOR, `    let retainedTokens = 0;
    let retainedAnchorTokens = 0;
    let retainedBoilerplateTokens = 0;
    for (let index = 0; index < total; index += 1) {
      if (!retained[index]) continue;
      retainedTokens += ownTokens[index];
      if (nodes[index].anchor) retainedAnchorTokens += ownTokens[index];
      if (nodes[index].boilerplateHits) retainedBoilerplateTokens += ownTokens[index];
    }
    if (qingzhouBenchmarkTreeDiagnosticsActive) {
      qingzhouBenchmarkLastTreeDpDiagnostics = qingzhouBenchmarkBuildTreeDpDiagnostics({
        nodes, ownTokens, pageTokens, anchorShare, children, subtreeTokens,
        keep, free, keepChoice, includeRoots, excluded, retained, retainedTokens,
        selectedKind, selectedRoot, selectedScore, emptyScore, ordinaryAvailable,
      });
    }
    if (retainedTokens < TREE_DP_GUARD_MIN_TOKENS) return null;`, "Tree-DP diagnostics");
  instrumented = replaceSingle(instrumented, EXTRACT_FUNCTION_ANCHOR, `  function extract(doc, { readability, complete = false } = {}) {
    if (qingzhouBenchmarkProductDiagnosticsActive) qingzhouBenchmarkLastProductDecision = null;
    if (!doc?.body) return null;`, "extract function");
  instrumented = replaceSingle(instrumented, EXTRACT_LEGACY_ANCHOR, `    const legacy = chosen || readable || custom || getBaseline();
    let selected = legacy;
    const qingzhouBenchmarkDecision = qingzhouBenchmarkProductDiagnosticsActive ? {
      completeRequested: Boolean(complete),
      preTreeLegacy: legacy,
      hanDominant: null,
      visiblePageLength: null,
      legacyVisiblePageShare: null,
      preflightPassed: null,
      legacyStatus: null,
      legacySafe: null,
      treeAttempted: false,
      treeCandidate: null,
      treeCandidateStatus: null,
      treeSelector: null,
      treeSelected: false,
      selectedBeforeComplete: null,
      completeStatus: null,
      fallback: null,
      completeFallbackSelected: false,
      result: null,
    } : null;
    if (qingzhouBenchmarkDecision) qingzhouBenchmarkLastProductDecision = qingzhouBenchmarkDecision;`, "legacy decision");
  instrumented = replaceSingle(instrumented, EXTRACT_HAN_GATE_ANCHOR, `    const qingzhouBenchmarkHanDominant = hanDominantDocument(doc);
    if (qingzhouBenchmarkDecision) qingzhouBenchmarkDecision.hanDominant = qingzhouBenchmarkHanDominant;
    if (qingzhouBenchmarkHanDominant) {
      // Reject obvious non-rescue cases before the more expensive structural
      // status walk. The selector still rechecks against the cleaned page text.
      const visiblePageLength = normalizedText(doc.body?.textContent || "").length;
      const legacyPageShare = legacy && visiblePageLength ? legacy.length / visiblePageLength : 0;
      const qingzhouBenchmarkPreflightPassed = legacyPageShare <= TREE_DP_RESCUE_PREFLIGHT_MAX_LEGACY_PAGE_SHARE;
      if (qingzhouBenchmarkDecision) {
        qingzhouBenchmarkDecision.visiblePageLength = visiblePageLength;
        qingzhouBenchmarkDecision.legacyVisiblePageShare = legacyPageShare;
        qingzhouBenchmarkDecision.preflightPassed = qingzhouBenchmarkPreflightPassed;
      }
      if (qingzhouBenchmarkPreflightPassed) {`, "Han gate");
  instrumented = replaceSingle(instrumented, EXTRACT_LEGACY_STATUS_ANCHOR, `        const legacyStatus = legacy
          ? pageCandidateStatus(legacy, doc, { requireCentralCollection: true })
          : null;
        const qingzhouBenchmarkLegacySafe = legacyCandidateIsSafe(legacy, doc, legacyStatus);
        if (qingzhouBenchmarkDecision) {
          qingzhouBenchmarkDecision.legacyStatus = legacyStatus;
          qingzhouBenchmarkDecision.legacySafe = qingzhouBenchmarkLegacySafe;
        }
        if (!qingzhouBenchmarkLegacySafe) {`, "legacy status");
  instrumented = replaceSingle(instrumented, EXTRACT_TREE_SELECTION_ANCHOR, `          if (qingzhouBenchmarkDecision) qingzhouBenchmarkDecision.treeAttempted = true;
          let treeDp = null;
          try {
            treeDp = treeDpExtract(doc);
          } catch (_error) {
            treeDp = null;
          }
          const treeCandidateStatus = treeDp
            ? pageCandidateStatus(treeDp, doc, { requireCentralCollection: true })
            : null;
          selected = selectTreeDpCandidate(treeDp, legacy, doc, {
            allowConfidenceOverride: complete,
            getPageLength,
            treeCandidateStatus,
          });
          if (qingzhouBenchmarkDecision) {
            qingzhouBenchmarkDecision.treeCandidate = treeDp;
            qingzhouBenchmarkDecision.treeCandidateStatus = treeCandidateStatus;
            qingzhouBenchmarkDecision.treeSelector = qingzhouBenchmarkTreeSelectorDiagnostics(
              treeDp,
              legacy,
              doc,
              treeCandidateStatus,
              getPageLength,
              { allowConfidenceOverride: complete },
            );
            qingzhouBenchmarkDecision.treeSelected = Boolean(treeDp && selected === treeDp);
          }`, "Tree-DP selection");
  instrumented = replaceSingle(instrumented, EXTRACT_RESULT_ANCHOR, `    const status = complete && selected ? pageCandidateStatus(selected, doc) : null;
    const fallback = status && !status.complete
      ? centralPageCandidate(doc)
      : null;
    const result = fallback && (
      fallback.length >= selected.length
      || (status.disjoint && fallback.length >= MIN_CONTENT_LENGTH)
    ) ? fallback : selected;
    if (qingzhouBenchmarkDecision) {
      qingzhouBenchmarkDecision.selectedBeforeComplete = selected;
      qingzhouBenchmarkDecision.completeStatus = status;
      qingzhouBenchmarkDecision.fallback = fallback;
      qingzhouBenchmarkDecision.completeFallbackSelected = Boolean(fallback && result === fallback);
      qingzhouBenchmarkDecision.result = result;
    }
    return withMetadata(result, readability);`, "final result");
  instrumented = replaceSingle(
    instrumented,
    MAKE_CANDIDATE_FUNCTION_ANCHOR,
    "  function qingzhouProductMakeCandidate(name, root) {",
    "candidate function",
  );
  instrumented = replaceSingle(instrumented, TOP_LEVEL_MATCHES_FUNCTION_ANCHOR, `  function makeCandidate(name, root) {
    const candidate = qingzhouProductMakeCandidate(name, root);
    if (candidate) qingzhouBenchmarkCaptureCandidateProvenance(candidate);
    return candidate;
  }

  function topLevelMatches(doc, selectors) {`, "candidate provenance wrapper");
  for (const rewrite of CLONE_REWRITES) {
    instrumented = replaceExpected(
      instrumented,
      rewrite.anchor,
      rewrite.replacement,
      rewrite.expected,
      rewrite.label,
    );
  }
  return instrumented.replace(EXPORT_ANCHOR, BENCHMARK_PROBE);
}
