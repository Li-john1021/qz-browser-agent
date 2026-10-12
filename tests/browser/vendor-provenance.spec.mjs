import { expect, test } from "./fixtures.mjs";

test("npm partial JSON preserves incomplete tool argument previews in the browser", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const { createToolArgsPreview } = await import("/extension/sidepanel/tools/tool-args-preview.js");
    const preview = createToolArgsPreview({});
    return ['{"city":"Bei', '{"rows":[1,2', '{"done":true}'].map(argsText => preview.normalize({ argsText }));
  });
  expect(result.map(({ value, incomplete }) => ({ value, incomplete }))).toEqual([
    { value: { city: "Bei" }, incomplete: true },
    { value: { rows: [1, 2] }, incomplete: true },
    { value: { done: true }, incomplete: false },
  ]);
});

test("the product initializes all locked highlight languages and aliases outside vendor", async ({ page }) => {
  await page.goto("/__test_health");
  const result = await page.evaluate(async () => {
    const before = typeof globalThis.hljs;
    const {hljs} = await import("/extension/sidepanel/ui/highlight-config.js");
    const {highlightCode} = await import("/extension/sidepanel/ui/code-highlighter.js");
    const languages = ["bash", "c", "cpp", "css", "diff", "dockerfile", "go", "java", "javascript", "json", "markdown", "plaintext", "python", "rust", "shell", "sql", "typescript", "xml", "yaml"];
    const aliases = ["sh", "zsh", "console", "shellsession", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "python3", "html", "xhtml", "svg", "yml", "text", "txt", "plain"];
    return {before, supported: [...languages,...aliases].every(name => Boolean(hljs.getLanguage(name))), html: highlightCode('const value = "<script>";', "js").html};
  });
  expect(result.before).toBe("undefined");
  expect(result.supported).toBe(true);
  expect(result.html).toContain("hljs-keyword");
  expect(result.html).toContain("&lt;script&gt;");
});
