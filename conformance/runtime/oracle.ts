import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ivm from 'isolated-vm';
import { referenceRoot } from '../references.ts';
import { required } from '../assert.ts';
import { loadNativePathFinder, nativePathFinderAddonPath } from '../native.ts';
import { createOracleLoader } from './loader.ts';
import { attachFixtureStorage, type FixtureCommon } from './storage.ts';
import type { WorldState } from '../../src/simulation/state.ts';
import type {
  CodeModules,
  ConsoleCommand,
  RuntimeData,
} from '../../src/runtime/game/runtime-data.ts';
import type { SandboxRunMessage } from '../../src/runtime/protocol.ts';
import type { Constants } from '../../src/constants.ts';

export interface OracleUserState {
  modules: CodeModules;
  timestamp: number;
  memory: string;
  segments: Record<string, string>;
  activeSegments: number[];
  consoleCommands: ConsoleCommand[];
  publicSegments?: string;
  defaultPublicSegment?: number | null;
  activeForeignSegment?: { username: unknown; id: number | undefined; user_id: string | undefined };
}
export interface OracleRunResult extends SandboxRunMessage {
  intents: Record<string, unknown>;
  persistent: OracleUserState;
}
export interface RuntimeOracle {
  states: Record<string, OracleUserState>;
  setCode(id: string, modules: CodeModules): void;
  setMemory(id: string, memory: string): void;
  setSegment(id: string, segment: number, value: string): void;
  enqueueConsoleCommand(id: string, expression: string, hidden?: boolean): void;
  run(world: WorldState, id: string): Promise<OracleRunResult>;
  dispose(): void;
}
interface OracleDriver {
  constants: Constants;
  getWorldSize(): number;
  connect(name: string): Promise<void>;
  updateAccessibleRoomsList(): Promise<void>;
  updateRoomStatusData(): Promise<void>;
  saveUserMemory(id: string, memory: string): Promise<void>;
  saveUserMemorySegments(id: string, segments: Record<number, string>): Promise<void>;
}
type OracleStart = (data: RuntimeData) => ivm.Reference<() => ivm.Copy<SandboxRunMessage>>;
interface OracleSandbox {
  isolate: ivm.Isolate;
  context: ivm.Context;
  start: ivm.Reference<OracleStart>;
  timestamp: number;
}

const engine = resolve(referenceRoot, 'engine');
const commonRoot = resolve(referenceRoot, 'common');
const driverRoot = resolve(referenceRoot, 'driver');
const upstreamRequire = createRequire(resolve(engine, 'package.json'));
const localRequire = createRequire(import.meta.url);
const packages = {
  '@screeps/engine': engine,
  '@screeps/common': commonRoot,
  lodash: resolve(engine, 'node_modules/lodash'),
  q: resolve(engine, 'node_modules/q'),
};
const unavailable = new Proxy(
  {},
  {
    get(_target, name) {
      throw new Error(`Unexercised oracle infrastructure: ${String(name)}`);
    },
  },
);

const unusedInfrastructure =
  'module.exports = new Proxy({}, {get() { throw new Error("Unavailable oracle infrastructure"); }});';

// esbuild only RESOLVES the pinned runtime's module graph (metafile); the isolate script is then
// assembled like upstream's webpack bundle: every module's original source text in its own
// function wrapper with a module-scoped Buffer. esbuild's own output is not used because it
// renames identifiers (e.g. `name` -> `name2` next to utils' direct eval, changing upstream
// error messages) and would hoist a "use strict" from this repo's tsconfig over sloppy modules.
async function buildRuntimeBundle() {
  const bufferEntry = localRequire.resolve('buffer/');
  const runtimeEntry = resolve(driverRoot, 'lib/runtime/runtime.js');
  const result = await build({
    entryPoints: [runtimeEntry, bufferEntry],
    bundle: true,
    write: false,
    outdir: 'oracle-unused-output',
    metafile: true,
    format: 'iife',
    platform: 'neutral',
    mainFields: ['main', 'module'],
    logLevel: 'silent',
    tsconfigRaw: {},
    plugins: [
      {
        name: 'pinned-runtime-resolution',
        setup(builder) {
          builder.onResolve({ filter: /^util$|^@screeps\/core$/ }, (args) => ({
            path: args.path,
            namespace: 'unused-infrastructure',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'unused-infrastructure' }, () => ({
            contents: unusedInfrastructure,
          }));
          builder.onResolve({ filter: /^~runtime-driver$/ }, () => ({
            path: resolve(driverRoot, 'lib/runtime/runtime-driver.js'),
          }));
          builder.onResolve({ filter: /^lodash$|^@screeps\// }, (args) => {
            for (const [name, directory] of Object.entries(packages)) {
              if (args.path === name || args.path.startsWith(`${name}/`)) {
                const suffix = args.path.slice(name.length);
                return {
                  path: createRequire(resolve(directory, 'package.json')).resolve(
                    suffix ? `.${suffix}` : directory,
                  ),
                };
              }
            }
            return { path: upstreamRequire.resolve(args.path) };
          });
        },
      },
    ],
  });
  const ids = new Map(Object.keys(result.metafile.inputs).map((key, index) => [key, index]));
  const idOf = (path: string) => {
    const key = Object.keys(result.metafile.inputs).find(
      (input) => !input.includes(':') && resolve(input) === path,
    );
    assert.ok(key !== undefined, `Oracle module graph lacks ${path}`);
    return required(ids.get(key));
  };
  const modules = Object.entries(result.metafile.inputs).map(([key, input]) => {
    let source;
    if (key.startsWith('unused-infrastructure:')) source = unusedInfrastructure;
    else {
      assert.ok(!key.includes(':'), `Unexpected oracle module namespace ${key}`);
      source = readFileSync(resolve(key), 'utf8');
      if (key.endsWith('.json')) source = `module.exports = ${source};`;
    }
    const requests: Record<string, number | undefined> = {};
    for (const entry of input.imports) {
      if (entry.external) continue;
      assert.equal(entry.kind, 'require-call', `Unexpected ${entry.kind} in ${key}`);
      assert.ok(entry.original, `Oracle import lacks request in ${key}`);
      requests[entry.original] = ids.get(entry.path);
    }
    return `[function (exports, require, module, __filename, __dirname, Buffer) {\n${source}\n}, ${JSON.stringify(requests)}]`;
  });
  return `(function () {
var modules = [\n${modules.join(',\n')}\n];
var cache = [];
var Buffer;
function load(id) {
  if (cache[id]) return cache[id].exports;
  var module = (cache[id] = { exports: {} });
  var requests = modules[id][1];
  modules[id][0].call(module.exports, module.exports, function (request) {
    if (!Object.prototype.hasOwnProperty.call(requests, request)) throw new Error('Cannot find module "' + request + '"');
    return load(requests[request]);
  }, module, '/index.js', '/', Buffer);
  return module.exports;
}
Buffer = load(${String(idOf(bufferEntry))}).Buffer;
load(${String(idOf(runtimeEntry))});
})();`;
}

// Cache only immutable original-source text; each scenario still gets a fresh module realm and
// real player isolates. Re-resolving the identical graph is not part of the conformance boundary.
let bundlePromise: Promise<string> | undefined;

// Native terrain is process-global inside the addon and never forgotten, so one process may load
// exactly one terrain set; a different set fails closed instead of searching stale rooms.
let nativeTerrainLoaded: string | undefined;

// Real pinned runtime.js/game modules in a V8 isolate. The adapter replaces only storage RPC and
// webpack's bundling/bootstrap. The native path finder is either the authentic pinned driver addon
// (`nativeTerrain`: driver lib/path-finder.js `init` host-side plus a per-isolate
// `ivm.NativeModule` instance exactly like driver user-vm.js) or a stub whose search fails
// explicitly. CPU billing, native heap/CPU termination and full driver/server scheduling are NOT
// conformance claims. No gameplay return codes or intent rules are implemented in this adapter.
export async function createRuntimeOracle({
  now,
  nativeTerrain,
  freezeCpuTime = false,
}: {
  now: number;
  nativeTerrain?: Record<string, string>;
  freezeCpuTime?: boolean;
}): Promise<RuntimeOracle> {
  for (const [name, version] of [
    ['lodash', '3.10.1'],
    ['@screeps/pathfinding', '0.4.17'],
    ['heap', '0.2.5'],
  ] as const) {
    const dependency = upstreamRequire(`${name}/package.json`) as { version: string };
    assert.equal(
      dependency.version,
      version,
      `Oracle dependency ${name} must match the pinned lockfile; run conformance:setup`,
    );
  }
  const replacements = new Map<string, unknown>([
    ['generic-pool', unavailable],
    ['he', unavailable],
    [resolve(driverRoot, 'lib/runtime/user-vm.js'), unavailable],
    [resolve(driverRoot, 'lib/runtime/make.js'), unavailable],
    [resolve(driverRoot, 'native/build/Release/native'), {}],
    ['../native/build/Release/native', {}],
  ]);
  const loader = createOracleLoader({ packages, replacements, now });
  const common = loader.load(resolve(commonRoot, 'index.js')) as FixtureCommon;
  const storage = attachFixtureStorage(common);
  const driver = loader.load(resolve(driverRoot, 'lib/index.js')) as OracleDriver;
  replacements.set('~runtime-driver', driver);
  replacements.set('@screeps/core', driver);
  const utils = loader.load(resolve(engine, 'src/utils.js')) as {
    storeIntents: (
      id: string,
      intents: SandboxRunMessage['intentsList'],
      data: RuntimeData,
      custom: object,
    ) => Record<string, unknown>;
  };
  const dataModule = loader.load(resolve(driverRoot, 'lib/runtime/data.js')) as {
    get: (id: string) => Promise<RuntimeData>;
  };
  const bundle = await (bundlePromise ??= buildRuntimeBundle());
  let nativeModule: ivm.NativeModule | undefined;
  if (nativeTerrain) {
    const rooms = Object.entries(nativeTerrain).map(([room, terrain]) => ({ room, terrain }));
    const signature = JSON.stringify(rooms);
    assert.ok(
      nativeTerrainLoaded === undefined || nativeTerrainLoaded === signature,
      'Native path finder terrain is process-global: run each native terrain set in its own process',
    );
    if (nativeTerrainLoaded === undefined) {
      const finder = loader.load(resolve(driverRoot, 'lib/path-finder.js')) as {
        init: (native: unknown, rooms: Array<{ room: string; terrain: string }>) => void;
      };
      finder.init(loadNativePathFinder(), rooms);
      nativeTerrainLoaded = signature;
    }
    nativeModule = new ivm.NativeModule(nativePathFinderAddonPath);
  }
  const states: Record<string, OracleUserState> = {};
  const sandboxes = new Map<string, OracleSandbox>();
  let connected = false;
  let timestamp = now;

  function user(id: string): OracleUserState {
    return (states[id] ??= {
      modules: {},
      timestamp: 0,
      memory: '',
      segments: {},
      activeSegments: [],
      consoleCommands: [],
    });
  }
  async function sandbox(id: string, world: WorldState, data: RuntimeData): Promise<OracleSandbox> {
    const existing = sandboxes.get(id);
    if (existing && existing.timestamp === data.userCodeTimestamp) return existing;
    if (existing) existing.isolate.dispose();
    const isolate = new ivm.Isolate({ memoryLimit: 256 });
    try {
      const context = await isolate.createContext();
      await context.global.set('global', context.global.derefInto());
      await (
        await isolate.compileScript(bundle, { filename: 'upstream-runtime.bundle.js' })
      ).run(context);
      await context.global.set('_ivm', ivm);
      await context.global.set('_isolate', isolate);
      // Accounting-only conformance: freeze measured time, not the intent accumulator.
      // The real isolate still executes player code and enforces the host timeout.
      if (freezeCpuTime) {
        await context.eval(`_isolate = {
          cpuTime: 0n,
          compileScriptSync: _isolate.compileScriptSync.bind(_isolate),
          getHeapStatisticsSync: _isolate.getHeapStatisticsSync.bind(_isolate)
        };`);
      }
      await context.global.set('_context', context);
      await context.global.set('_worldSize', driver.getWorldSize());
      if (nativeModule) {
        assert.equal(
          JSON.stringify(
            Object.entries(world.terrain).map(([room, terrain]) => ({ room, terrain })),
          ),
          nativeTerrainLoaded,
          'Player terrain must be the terrain loaded into the native path finder',
        );
        const instance = await nativeModule.create(context);
        await context.global.set('_nativeMod', instance.derefInto());
      } else {
        await context.eval(
          'global._nativeMod = { search() { throw new Error("Upstream native PathFinder search is excluded from this adapter"); } };',
        );
      }
      await context.global.set('_constants', new ivm.ExternalCopy(driver.constants).copyInto());
      await context.global.set('_customObjectPrototypes', new ivm.ExternalCopy([]).copyInto());
      await context.global.set('_customIntentTypes', new ivm.ExternalCopy({}).copyInto());
      await context.global.set(
        '_halt',
        new ivm.Reference(() => {
          throw new Error('CPU halt excluded from constrained oracle');
        }),
      );
      await context.eval('_init();');
      // Original _start returns a reference whose callback transfers an ExternalCopy tick result.
      const start = (await context.global.get('_start', {
        reference: true,
      })) as ivm.Reference<OracleStart>;
      const setTerrain = await context.global.get('_setStaticTerrainData', { reference: true });
      const rooms = Object.keys(world.terrain);
      const terrain = new Uint8Array(rooms.length * 2500);
      const offsets: Record<string, number> = {};
      rooms.forEach((room, index) => {
        offsets[room] = index * 2500;
        for (let i = 0; i < 2500; i++)
          terrain[index * 2500 + i] = Number(required(world.terrain[room])[i]);
      });
      await setTerrain.apply(undefined, [
        new ivm.ExternalCopy(terrain.buffer).copyInto(),
        new ivm.ExternalCopy(offsets).copyInto(),
      ]);
      setTerrain.release();
      await context.eval(`
        for (const key of ['_ivm','_isolate','_context','_init','_evalFn','_start','_setStaticTerrainData','_worldSize','_nativeMod','_constants','_halt','_customObjectPrototypes','_customIntentTypes']) delete global[key];
      `);
      const result = { isolate, context, start, timestamp: data.userCodeTimestamp };
      sandboxes.set(id, result);
      return result;
    } catch (error) {
      isolate.dispose();
      throw error;
    }
  }
  return {
    states,
    setCode(id: string, modules: CodeModules) {
      Object.assign(user(id), { modules: structuredClone(modules), timestamp: ++timestamp });
    },
    setMemory(id: string, memory: string) {
      user(id).memory = memory;
    },
    setSegment(id: string, segment: number, value: string) {
      user(id).segments[segment] = value;
    },
    enqueueConsoleCommand(id: string, expression: string, hidden = false) {
      user(id).consoleCommands.push({ expression, hidden });
    },
    async run(world: WorldState, id: string) {
      storage.sync(world, states);
      if (!connected) {
        await driver.connect('conformance');
        connected = true;
      }
      await driver.updateAccessibleRoomsList();
      await driver.updateRoomStatusData();
      const data = await dataModule.get(id);
      const instance = await sandbox(id, world, data);
      const run = await instance.start.apply(undefined, [new ivm.ExternalCopy(data).copyInto()]);
      // Matches the driver's playerSandbox shard injection, with hostname replaced by fixture name.
      await instance.context.eval(
        `Game.shard = {name: ${JSON.stringify(world.shardName)}, type: 'normal', ptr: false};`,
      );
      let result: SandboxRunMessage;
      try {
        // isolated-vm unwraps the upstream ExternalCopy.copyInto() transfer; its declaration
        // retains Copy<T>, so describe that exact transport boundary rather than the wrapper.
        const transferred: unknown = await run.apply(undefined, [], { timeout: 5000 });
        assert.ok(
          transferred &&
            typeof transferred === 'object' &&
            'type' in transferred &&
            (transferred.type === 'done' || transferred.type === 'error'),
          'Original runtime returned a tick result',
        );
        result = transferred as SandboxRunMessage;
      } finally {
        run.release();
      }
      const intents = utils.storeIntents(id, result.intentsList, data, {});
      const state = user(id);
      state.consoleCommands = [];
      if (result.memory) {
        await driver.saveUserMemory(id, result.memory);
        state.memory = required(storage.values.get(common.storage.env.keys.MEMORY + id));
      }
      if (result.memorySegments) {
        await driver.saveUserMemorySegments(id, result.memorySegments);
        state.segments = structuredClone(
          required(storage.hashes.get(common.storage.env.keys.MEMORY_SEGMENTS + id)),
        );
      }
      if (result.activeSegments !== undefined)
        state.activeSegments = structuredClone(result.activeSegments);
      if (result.publicSegments !== undefined) state.publicSegments = result.publicSegments;
      if (result.defaultPublicSegment !== undefined)
        state.defaultPublicSegment = result.defaultPublicSegment;
      if (result.activeForeignSegment !== undefined) {
        if (result.activeForeignSegment === null) delete state.activeForeignSegment;
        else {
          const requested = result.activeForeignSegment;
          const target = Object.values(world.users).find(
            (entry) => entry.username === requested.username,
          );
          state.activeForeignSegment = { ...requested, user_id: target?._id };
          if (!requested.id && target && states[target._id]?.defaultPublicSegment)
            state.activeForeignSegment.id = required(
              required(states[target._id]).defaultPublicSegment,
            );
        }
      }
      return { ...result, intents, memory: state.memory, persistent: structuredClone(state) };
    },
    dispose() {
      for (const instance of sandboxes.values()) instance.isolate.dispose();
      sandboxes.clear();
    },
  };
}
