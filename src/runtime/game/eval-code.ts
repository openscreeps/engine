/*
 * Player code evaluation inside the sandbox (screeps/driver `lib/runtime/runtime-driver.js` `evalCode`).
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { jsString } from '../../utils/js.ts';

/** A compiled script runnable in this sandbox's context (isolated-vm `Script` or a node:vm adapter). */
export interface CompiledScript {
  runSync(context: unknown, options: { timeout?: number }): unknown;
}

/** Compiles scripts for this sandbox (isolated-vm `Isolate` handle or a node:vm adapter). */
export interface ScriptCompiler {
  compileScriptSync(code: string, options: { filename: string }): CompiledScript;
}

/** The `module` object visible to player code. */
export interface PlayerModule {
  exports: unknown;
  user: string;
  timestamp?: number;
  name: string;
  code: string;
  __initGlobals?: unknown;
}

/** Thrown for player code failures; `toString()` yields the formatted message (no stack). */
export class EvalCodeError {
  readonly #message: string;

  constructor(message: string) {
    this.#message = message;
  }

  toString(): string {
    return this.#message;
  }
}

export interface EvalHost {
  compiler: ScriptCompiler;
  context: unknown;
  globals: Record<string, unknown>;
}

const moduleScripts: Record<string, { timestamp: number | undefined; script: CompiledScript }> = {};

function formatError(e: unknown): string {
  const stack: unknown = e !== null && typeof e === 'object' ? Reflect.get(e, 'stack') : undefined;
  if (stack) {
    let message = jsString(stack);
    message = message.replace(/</g, '&lt;');
    message = message.replace(/ *at.*?$/, '');
    message = message.replace(/_console\d+:\d+/, 'console');
    message = message.replace(/at __module \((.*)\)/g, 'at $1');
    return message;
  }
  const message: unknown =
    e !== null && typeof e === 'object' ? Reflect.get(e, 'message') : undefined;
  return jsString(message);
}

/**
 * Evaluates a player module (wrapped as `function __module(module, exports)`) or, with `returnValue`,
 * a console expression whose result is returned as a string.
 */
export function evalCode(
  host: EvalHost,
  module: PlayerModule,
  returnValue: boolean,
  timeout?: number,
): unknown {
  const { globals } = host;
  const options: { filename: string } = { filename: module.name };
  const runOptions: { timeout?: number } = {};

  const oldModule: unknown = globals.__module ?? {};

  Object.defineProperty(module, '__initGlobals', {
    value: undefined,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globals.require, 'initGlobals', {
    value: undefined,
    writable: false,
    configurable: false,
  });

  globals.__module = module;

  if (timeout !== undefined && timeout !== 0 && timeout != Infinity) {
    runOptions.timeout = Math.max(30, timeout + 5);
  }

  try {
    let result: unknown;
    if (returnValue) {
      const code =
        '(function(code,module,exports) { return "" + eval(code); })(' +
        JSON.stringify(module.code) +
        ', __module, __module.exports)';
      result = host.compiler.compileScriptSync(code, options).runSync(host.context, runOptions);
    } else {
      let cached = moduleScripts[module.name];
      if (!cached || cached.timestamp !== module.timestamp) {
        const code =
          '(function __module(module,exports){ ' + module.code + '\n})(__module, __module.exports)';
        cached = {
          timestamp: module.timestamp,
          script: host.compiler.compileScriptSync(code, options),
        };
        moduleScripts[module.name] = cached;
      }
      result = cached.script.runSync(host.context, runOptions);
    }
    // Upstream restores `globals.module` (not `__module`); reproduced verbatim.
    globals.module = oldModule;
    return result;
  } catch (e) {
    if (e instanceof EvalCodeError) {
      throw e;
    }
    if (
      e !== null &&
      typeof e === 'object' &&
      Reflect.get(e, 'message') === 'Script execution timed out.'
    ) {
      Reflect.set(e, 'message', 'Script execution timed out: CPU time limit reached');
      // V8 captured `stack` with the old message; keep it consistent with the rewritten message.
      const stack: unknown = Reflect.get(e, 'stack');
      if (typeof stack === 'string') {
        Reflect.set(
          e,
          'stack',
          stack.replace(
            'Script execution timed out.',
            'Script execution timed out: CPU time limit reached',
          ),
        );
      }
    }
    // Upstream throws a non-Error whose `toString()` is the formatted message (no stack).
    const failure: unknown = new EvalCodeError(formatError(e));
    throw failure;
  }
}
