import { createRequire, isBuiltin } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import vm from 'node:vm';

// A private CommonJS cache and realm: no require.cache/process.env mutation and no shared oracle
// singletons with the processor conformance runner. Replacements are infrastructure only.
export function createOracleLoader({ packages, replacements = new Map(), now }) {
  const cache = new Map();
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const context = vm.createContext({
    Buffer,
    console,
    Date: FixedDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    process: { env: {}, on() {} },
  });
  function resolveRequest(request, filename) {
    if (isBuiltin(request)) return request;
    for (const [name, directory] of Object.entries(packages)) {
      if (request === name || request.startsWith(`${name}/`)) {
        const suffix = request.slice(name.length);
        return createRequire(resolve(directory, 'package.json')).resolve(
          suffix ? `.${suffix}` : directory,
        );
      }
    }
    return createRequire(filename).resolve(request);
  }
  function load(filename) {
    if (isBuiltin(filename)) return createRequire(import.meta.url)(filename);
    if (replacements.has(filename)) return replacements.get(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    if (extname(filename) === '.json') {
      module.exports = JSON.parse(readFileSync(filename, 'utf8'));
      return module.exports;
    }
    if (extname(filename) === '.node')
      throw new Error(`Oracle native module is unavailable: ${filename}`);
    const require = (request) => {
      if (replacements.has(request)) return replacements.get(request);
      return load(resolveRequest(request, filename));
    };
    require.resolve = (request) => resolveRequest(request, filename);
    const source = readFileSync(filename, 'utf8').replace(/^#![^\n]*\n/, '');
    const fn = new vm.Script(
      `(function(exports, require, module, __filename, __dirname) {\n${source}\n})`,
      { filename },
    ).runInContext(context);
    fn(module.exports, require, module, filename, dirname(filename));
    return module.exports;
  }
  return { load, context, cache };
}
