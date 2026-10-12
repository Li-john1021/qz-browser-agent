/** Existing fixtures are Chinese; locale-specific tests override the browser API explicitly. */
if (globalThis.navigator) {
  Object.defineProperties(globalThis.navigator, {
    language: { configurable: true, value: "zh-CN" },
    languages: { configurable: true, value: Object.freeze(["zh-CN"]) },
  });
}
