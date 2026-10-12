const mathJaxConfig = {
  tex: {
    inlineMath: [["$", "$"], ["\\(", "\\)"]],
    displayMath: [["$$", "$$"], ["\\[", "\\]"]],
    processEscapes: true,
    processEnvironments: true,
    packages: { "[+]": ["ams", "newcommand", "noerrors", "noundefined"] },
  },
  options: {
    skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    ignoreHtmlClass: "tex2jax_ignore",
    processHtmlClass: "math-formula",
  },
  svg: {
    fontCache: "local",
    mtextInheritFont: true,
  },
  startup: {
    typeset: false,
  },
};

(globalThis as typeof globalThis & { MathJax?: typeof mathJaxConfig }).MathJax = mathJaxConfig;
