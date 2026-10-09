import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ivm from 'isolated-vm';
import { referenceRoot } from '../references.mjs';
import { loadNativePathFinder, nativePathFinderAddonPath } from '../native.mjs';
import { createOracleLoader } from './loader.mjs';
import { attachFixtureStorage } from './storage.mjs';

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
async function runtimeBundle() {
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
  const idOf = (path) => {
    const key = Object.keys(result.metafile.inputs).find(
      (input) => !input.includes(':') && resolve(input) === path,
    );
    assert.ok(key !== undefined, `Oracle module graph lacks ${path}`);
    return ids.get(key);
  };
  const modules = Object.entries(result.metafile.inputs).map(([key, input]) => {
    let source;
    if (key.startsWith('unused-infrastructure:')) source = unusedInfrastructure;
    else {
      assert.ok(!key.includes(':'), `Unexpected oracle module namespace ${key}`);
      source = readFileSync(resolve(key), 'utf8');
      if (key.endsWith('.json')) source = `module.exports = ${source};`;
    }
    const requests = {};
    for (const entry of input.imports) {
      if (entry.external) continue;
      assert.equal(entry.kind, 'require-call', `Unexpected ${entry.kind} in ${key}`);
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
Buffer = load(${idOf(bufferEntry)}).Buffer;
load(${idOf(runtimeEntry)});
})();`;
}

// Native terrain is process-global inside the addon and never forgotten, so one process may load
// exactly one terrain set; a different set fails closed instead of searching stale rooms.
let nativeTerrainLoaded;

// Real pinned runtime.js/game modules in a V8 isolate. The adapter replaces only storage RPC and
// webpack's bundling/bootstrap. The native path finder is either the authentic pinned driver addon
// (`nativeTerrain`: driver lib/path-finder.js `init` host-side plus a per-isolate
// `ivm.NativeModule` instance exactly like driver user-vm.js) or a stub whose search fails
// explicitly. CPU billing, native heap/CPU termination and full driver/server scheduling are NOT
// conformance claims. No gameplay return codes or intent rules are implemented in this adapter.
export async function createRuntimeOracle({ now, nativeTerrain }) {
  for (const [name, version] of [
    ['lodash', '3.10.1'],
    ['@screeps/pathfinding', '0.4.17'],
    ['heap', '0.2.5'],
  ]) {
    assert.equal(
      upstreamRequire(`${name}/package.json`).version,
      version,
      `Oracle dependency ${name} must match the pinned lockfile; run conformance:setup`,
    );
  }
  const replacements = new Map([
    ['generic-pool', unavailable],
    ['he', unavailable],
    [resolve(driverRoot, 'lib/runtime/user-vm.js'), unavailable],
    [resolve(driverRoot, 'lib/runtime/make.js'), unavailable],
    [resolve(driverRoot, 'native/build/Release/native'), {}],
    ['../native/build/Release/native', {}],
  ]);
  const loader = createOracleLoader({ packages, replacements, now });
  const common = loader.load(resolve(commonRoot, 'index.js'));
  const storage = attachFixtureStorage(common);
  const driver = loader.load(resolve(driverRoot, 'lib/index.js'));
  replacements.set('~runtime-driver', driver);
  replacements.set('@screeps/core', driver);
  const utils = loader.load(resolve(engine, 'src/utils.js'));
  const dataModule = loader.load(resolve(driverRoot, 'lib/runtime/data.js'));
  const bundle = await runtimeBundle();
  let nativeModule;
  if (nativeTerrain) {
    const rooms = Object.entries(nativeTerrain).map(([room, terrain]) => ({ room, terrain }));
    const signature = JSON.stringify(rooms);
    assert.ok(
      nativeTerrainLoaded === undefined || nativeTerrainLoaded === signature,
      'Native path finder terrain is process-global: run each native terrain set in its own process',
    );
    if (nativeTerrainLoaded === undefined) {
      loader.load(resolve(driverRoot, 'lib/path-finder.js')).init(loadNativePathFinder(), rooms);
      nativeTerrainLoaded = signature;
    }
    nativeModule = new ivm.NativeModule(nativePathFinderAddonPath);
  }
  const states = {};
  const sandboxes = new Map();
  let connected = false;
  let timestamp = now;

  function user(id) {
    return (states[id] ??= {
      modules: {},
      timestamp: 0,
      memory: '',
      segments: {},
      activeSegments: [],
      consoleCommands: [],
    });
  }
  async function sandbox(id, world, data) {
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
      const start = await context.global.get('_start', { reference: true });
      const setTerrain = await context.global.get('_setStaticTerrainData', { reference: true });
      const rooms = Object.keys(world.terrain);
      const terrain = new Uint8Array(rooms.length * 2500);
      const offsets = {};
      rooms.forEach((room, index) => {
        offsets[room] = index * 2500;
        for (let i = 0; i < 2500; i++) terrain[index * 2500 + i] = Number(world.terrain[room][i]);
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
    setCode(id, modules) {
      Object.assign(user(id), { modules: structuredClone(modules), timestamp: ++timestamp });
    },
    setMemory(id, memory) {
      user(id).memory = memory;
    },
    setSegment(id, segment, value) {
      user(id).segments[segment] = value;
    },
    enqueueConsoleCommand(id, expression, hidden = false) {
      user(id).consoleCommands.push({ expression, hidden });
    },
    async run(world, id) {
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
      let result;
      try {
        result = await run.apply(undefined, [], { timeout: 5000 });
      } finally {
        run.release();
      }
      assert.ok(
        result && (result.type === 'done' || result.type === 'error'),
        'Original runtime returned a tick result',
      );
      result.intents = utils.storeIntents(id, result.intentsList, data, {});
      const state = user(id);
      state.consoleCommands = [];
      if (result.memory) {
        await driver.saveUserMemory(id, result.memory);
        state.memory = storage.values.get(common.storage.env.keys.MEMORY + id);
      }
      if (result.memorySegments) {
        await driver.saveUserMemorySegments(id, result.memorySegments);
        state.segments = structuredClone(
          storage.hashes.get(common.storage.env.keys.MEMORY_SEGMENTS + id),
        );
      }
      for (const key of ['activeSegments', 'publicSegments', 'defaultPublicSegment']) {
        if (result[key] !== undefined) state[key] = structuredClone(result[key]);
      }
      if (result.activeForeignSegment !== undefined) {
        if (result.activeForeignSegment === null) delete state.activeForeignSegment;
        else {
          const requested = result.activeForeignSegment;
          const target = Object.values(world.users).find(
            (entry) => entry.username === requested.username,
          );
          state.activeForeignSegment = { ...requested, user_id: target?._id };
          if (!requested.id && target && states[target._id]?.defaultPublicSegment)
            state.activeForeignSegment.id = states[target._id].defaultPublicSegment;
        }
      }
      return { ...result, memory: state.memory, persistent: structuredClone(state) };
    },
    dispose() {
      for (const instance of sandboxes.values()) instance.isolate.dispose();
      sandboxes.clear();
    },
  };
}
