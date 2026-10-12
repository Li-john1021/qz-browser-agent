interface MathJaxRuntime {
  startup?: { promise?: Promise<unknown> };
  typesetPromise?(targets: Element[]): Promise<unknown>;
  typesetClear?(targets: Element[]): void;
}

declare global { interface Window { MathJax?: MathJaxRuntime } }

type ReadyMathJax = MathJaxRuntime & Required<Pick<MathJaxRuntime, "typesetPromise">>;
let loading: Promise<ReadyMathJax> | undefined;
let typesetting: Promise<unknown> = Promise.resolve();

/** MathJax 3 shares one mutable document; concurrent renders can replace each other's targets. */
export function withMathRuntime<T>(render: (runtime: ReadyMathJax) => Promise<T>): Promise<T> {
  const next = typesetting.then(async () => render(await loadMathRuntime()));
  typesetting = next.catch(() => {});
  return next;
}

/** One local runtime per panel; a failed load must not poison later formula requests. */
function loadMathRuntime(): Promise<ReadyMathJax> {
  if (loading) return loading;
  let script: HTMLScriptElement | undefined;
  const previous = window.MathJax;
  const configuration = previous?.typesetPromise ? previous : structuredClone(previous);
  loading = (async () => {
    if (!window.MathJax?.typesetPromise) {
      await new Promise<void>((resolve, reject) => {
        script = document.createElement("script");
        script.src = globalThis.chrome?.runtime?.getURL("vendor/mathjax/tex-svg-full.js")
          || new URL("../vendor/mathjax/tex-svg-full.js", document.baseURI).href;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("MathJax could not be loaded"));
        document.head.append(script);
      });
    }
    const runtime = window.MathJax;
    await runtime?.startup?.promise;
    if (!runtime?.typesetPromise) throw new Error("MathJax did not initialize");
    return runtime as ReadyMathJax;
  })().catch(error => {
    script?.remove();
    window.MathJax = configuration;
    loading = undefined;
    throw error;
  });
  return loading;
}
