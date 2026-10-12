const originalWarn = console.warn.bind(console);
const originalLog = console.log.bind(console);
const originalDebug = console.debug.bind(console);

const ignoredPdfWarnings = [
  /^Warning: Cannot load "@napi-rs\/canvas" package:/,
  /^Warning: Cannot polyfill `(DOMMatrix|ImageData|Path2D)`, rendering may be broken\.$/,
];

console.warn = (...args) => {
  if (ignoredPdfWarnings.some(pattern => pattern.test(String(args[0] || "")))) return;
  originalWarn(...args);
};

console.log = (...args) => {
  if (ignoredPdfWarnings.some(pattern => pattern.test(String(args[0] || "")))) return;
  originalLog(...args);
};

console.debug = (...args) => {
  if (String(args[0] || "") === "[轻舟] collect artifact table meta failed:") return;
  originalDebug(...args);
};
