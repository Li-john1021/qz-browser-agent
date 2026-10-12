import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { compileEmbeddedScript } from '../../scripts/build-extension.mjs';

const sourceDir = fileURLToPath(new URL('../../src/', import.meta.url));
const runtimes = new Map();
const hosts = new Map();

export function compileScriptRuntime(mode = 'development') {
  if (!runtimes.has(mode)) runtimes.set(mode, compileEmbeddedScript({
    sourceDir, entry: 'shared/script-runtime.ts', globalName: 'QZ_SCRIPT_RUNTIME', mode,
  }));
  return runtimes.get(mode);
}

/** Build the real registrar, including the same embedded source definition as the extension. */
export function compileScriptToolHost(mode = 'development') {
  if (!hosts.has(mode)) hosts.set(mode, compileScriptRuntime(mode).then(async runtime => {
    const result = await build({
      stdin: { contents: `export { createScriptTools } from './capabilities/script/tools.ts';
        export { ToolExecutionError } from './background/tools/arguments.ts';`, resolveDir: sourceDir },
      bundle: true, write: false, format: 'iife', globalName: 'QZ_SCRIPT_TEST', target: 'chrome114',
      minify: mode === 'production', define: { SCRIPT_RUNTIME_SOURCE: JSON.stringify(runtime) },
    });
    return result.outputFiles[0].text;
  }));
  return hosts.get(mode);
}
