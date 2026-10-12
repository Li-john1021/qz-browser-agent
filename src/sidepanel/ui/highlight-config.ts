import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Register the supported grammars once per UI context; importing the full library defeats that budget.
for (const [language, definition] of Object.entries({ bash, c, cpp, css, diff, dockerfile, go, java, javascript, json, markdown, plaintext, python, rust, shell, sql, typescript, xml, yaml })) hljs.registerLanguage(language, definition);
for (const [language, aliases] of Object.entries({
  bash: ["sh", "zsh"], shell: ["console", "shellsession"], javascript: ["js", "jsx", "mjs", "cjs"],
  typescript: ["ts", "tsx"], python: ["py", "python3"], xml: ["html", "xhtml", "svg"],
  yaml: ["yml"], plaintext: ["text", "txt", "plain"],
})) hljs.registerAliases(aliases, { languageName: language });
hljs.configure({ ignoreUnescapedHTML: true, throwUnescapedHTML: false });
export { hljs };
