const CONTENT_READY_ANCHOR = "host.__QZ_CONTENT_READY = true;";

const BENCHMARK_SERIALIZER_BRIDGE = `host.__QZ_CONTENT_READY = true;
  globalThis.__qingzhouContentBenchmark = Object.freeze({
    serializeArticleContent(article) {
      return serializeArticleContent(article);
    },
  });`;

export function instrumentContentScriptSource(source) {
  const value = String(source || "");
  const occurrences = value.split(CONTENT_READY_ANCHOR).length - 1;
  if (occurrences !== 1) {
    throw new Error(`content script benchmark anchor must occur exactly once; found ${occurrences}`);
  }
  return value.replace(CONTENT_READY_ANCHOR, BENCHMARK_SERIALIZER_BRIDGE);
}
