'use strict';
/*
 * Oracle child process: runs one scenario through the pinned upstream server processes.
 *
 * Executed unmodified from the pinned checkouts:
 *  - storage: screeps/storage `lib/index.js` start() (LokiJS database, db/queue/pubsub RPC methods), in
 *    its own process (storage-process.cts);
 *  - engine `src/main.js` (main loop: user and room queues, global stage, game-time increment) and
 *    `src/processor.js` (room processor loop) with everything they load (processor intents, global
 *    market/power processors, fake NPC runtime, utils);
 *  - driver `lib/index.js` (room/intent/user persistence, notifications, history, room stats), `lib/bulk.js`,
 *    `lib/queue.js`, `lib/history.js`; common `lib/storage.js` over the real `lib/rpc.js` TCP protocol.
 * The runner role (engine `runner.js` → driver `saveUserIntents`) is played here with the engine's
 * `utils.storeIntents`, the call driver `lib/runtime/make.js` makes after running player code.
 *
 * Replaced: driver modules the processor never calls are stubs that throw if reached (native PathFinder
 * addon, player VM, runtime/make, runner pool, console HTML escaping). Observed through public hooks:
 * `driver.config` events (`processorLoopStage`), `driver.config.mainLoopCustomStage` (snapshot after each
 * tick), and a wrapper around `driver.getRoomStatsUpdater` (the private driver never persists stats).
 *
 * Controlled nondeterminism: `Math.random` replays mulberry32 from `world.rngState` (installed before
 * lodash captures it); `Date`/`Date.now` read a clock derived from the game time being processed.
 */
import type { ChildProcess } from 'node:child_process';
import type { Shared } from './shared.cts';
import type { ObservedWorld, OracleRequest, RawIntents, TickRecord } from './types.ts';
import type {
  Common,
  Driver,
  ModuleInternals,
  SnapshotWorld,
  StorageDocument,
  TickCapture,
  UpstreamUtils,
} from './upstream.ts';
import type * as Fs from 'node:fs';
import type * as Os from 'node:os';
import type * as Net from 'node:net';
import type { AddressInfo } from 'node:net';
import type * as Path from 'node:path';
import type * as Util from 'node:util';
import type * as Zlib from 'node:zlib';
import type ModuleType from 'node:module';
import type * as ChildProcesses from 'node:child_process';
import type * as AssertHelpers from '../assert.ts';
const { required } = require('../assert.ts') as typeof AssertHelpers;

const fs = require('node:fs') as typeof Fs;
const os = require('node:os') as typeof Os;
const net = require('node:net') as typeof Net;
const path = require('node:path') as typeof Path;
const util = require('node:util') as typeof Util;
const zlib = require('node:zlib') as typeof Zlib;
const Module = require('node:module') as typeof ModuleType & ModuleInternals;
const { fork } = require('node:child_process') as typeof ChildProcesses;
const { COLLECTIONS, createResolver, clockAt, mulberry32Next } = require('./shared.cts') as Shared;

// ---- controlled nondeterminism (before any upstream module is loaded) -------------------------
const rng: { state: number; readonly gameTime?: number | 'load' } = { state: 0 };
// Draws made while a module is being evaluated (third-party initialization such as brace-expansion's
// escape tokens, lazily loaded during the first tick) are not game draws; they get their own stream.
const moduleInitRng = { state: 0x9e3779b9 };
// SIMULATION_ORACLE_RNG_TRACE=<file>: append every draw's call site (diagnosing draw-order mismatches).
const rngTrace = process.env.SIMULATION_ORACLE_RNG_TRACE;
Math.random = function random() {
  const stack = new Error().stack ?? '';
  const moduleInit = stack.includes('Module._compile');
  if (rngTrace) {
    const site = stack
      .split('\n')
      .slice(2, 5)
      .map((line) => line.trim())
      .join(' < ');
    fs.appendFileSync(rngTrace, `${String(moduleInit ? 'module-init' : rng.gameTime)} ${site}\n`);
  }
  return mulberry32Next(moduleInit ? moduleInitRng : rng);
};
const clock = { now: () => 0 };
const RealDate = Date;
class ControlledDate extends RealDate {
  constructor(
    ...args:
      | []
      | [value: string | number | Date]
      | [
          year: number,
          month: number,
          date?: number,
          hours?: number,
          minutes?: number,
          seconds?: number,
          ms?: number,
        ]
  ) {
    if (args.length === 0) super(clock.now());
    else if (args.length === 1) super(args[0]);
    else if (args.length === 2) super(args[0], args[1]);
    else if (args.length === 3) super(args[0], args[1], args[2]);
    else if (args.length === 4) super(args[0], args[1], args[2], args[3]);
    else if (args.length === 5) super(args[0], args[1], args[2], args[3], args[4]);
    else if (args.length === 6) super(args[0], args[1], args[2], args[3], args[4], args[5]);
    else super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
  }
  static override now() {
    return clock.now();
  }
}
Reflect.set(globalThis, 'Date', ControlledDate);

// ---- console capture ---------------------------------------------------------------------------
const logs: Array<{ level: string; text: string }> = [];
let onLog: (entry: { level: string; text: string }) => void = () => {};
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  console[level] = (...args: unknown[]) => {
    const entry = { level, text: util.format(...args) };
    logs.push(entry);
    onLog(entry);
  };
}

function installResolution(REF: string) {
  const COMMON = path.join(REF, 'common');
  const DRIVER = path.join(REF, 'driver') + path.sep;
  const ENGINE = path.join(REF, 'engine');
  const unavailable = (what: string) =>
    function unavailableInOracle() {
      throw new Error(`conformance oracle: ${what} is not available to the processor oracle`);
    };
  const stub = (name: string, exports: unknown) => {
    const id = path.join(REF, 'driver', `__conformance_stub_${name}__.js`);
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports;
    require.cache[id] = m;
    return id;
  };
  const driverStubs: Record<string, string> = {
    '../native/build/Release/native': stub('native', {
      version: 11,
      loadTerrain() {},
      search: unavailable('the native PathFinder addon (PathFinder.search)'),
    }),
    './runtime/user-vm': stub('user-vm', {
      init: unavailable('runtime/user-vm'),
      get: unavailable('runtime/user-vm'),
      clear: unavailable('runtime/user-vm'),
      clearAll: unavailable('runtime/user-vm'),
    }),
    './runtime/make': stub('make', unavailable('runtime/make (player runtime)')),
    'generic-pool': stub('generic-pool', { createPool: unavailable('generic-pool (runner pool)') }),
    he: stub('he', { encode: unavailable('he (console escaping)') }),
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function resolveForOracle(
    this: typeof Module,
    request,
    parent,
    isMain,
    options,
  ) {
    if (request === '@screeps/common' || request.startsWith('@screeps/common/')) {
      return original.call(
        this,
        COMMON + request.slice('@screeps/common'.length),
        parent,
        isMain,
        options,
      );
    }
    const from = parent && parent.filename;
    if (from && from.startsWith(DRIVER)) {
      if (Object.prototype.hasOwnProperty.call(driverStubs, request))
        return required(driverStubs[request]);
      // The driver is not npm-installed (no native build); its pure JS deps come from the engine's.
      if (!request.startsWith('.') && !path.isAbsolute(request) && !request.startsWith('node:')) {
        return original.call(this, request, parent, isMain, { paths: [ENGINE] });
      }
    }
    return original.call(this, request, parent, isMain, options);
  };
}

/** Loki bookkeeping (`$loki`, `meta`) is not game state; strip it from documents and history objects. */
function stripLoki<T>(doc: T): T {
  if (doc && typeof doc === 'object') {
    Reflect.deleteProperty(doc, '$loki');
    Reflect.deleteProperty(doc, 'meta');
  }
  return doc;
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => {
      resolve(port);
    });
  });
  return promise;
}

function startStorage(REF: string, env: Record<string, string>): Promise<ChildProcess> {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>();
  const child = fork(path.join(__dirname, 'storage-process.cts'), [], {
    env: { ...process.env, ...env, SIMULATION_REFERENCE_ROOT: REF },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
  let output = '';
  required(child.stdout).on('data', (chunk: Buffer) => (output += chunk.toString()));
  required(child.stderr).on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.on('message', (message) => {
    if (message === 'storageLaunched') resolve(child);
  });
  child.on('exit', (code) => {
    reject(new Error(`storage process exited with code ${String(code)}: ${output.slice(-2000)}`));
  });
  return promise;
}

async function run({ referenceRoot: REF, scenario }: Omit<OracleRequest, 'type'>) {
  installResolution(REF);
  const world = scenario.world;
  rng.state = world.rngState >>> 0;
  let gameTime = world.gameTime;
  let loading = true;
  Object.defineProperty(rng, 'gameTime', { get: () => (loading ? 'load' : gameTime) });
  clock.now = () => clockAt(scenario, gameTime);

  // ---- storage server process ---------------------------------------------------------------
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screeps-simulation-oracle-'));
  const storageEnv = {
    STORAGE_PORT: String(await freePort()),
    STORAGE_HOST: '127.0.0.1',
    DB_PATH: path.join(dbDir, 'db.json'),
    MODFILE: path.join(dbDir, 'mods.json'), // absent: config-manager loads no mods
  };
  const storageChild = await startStorage(REF, storageEnv);
  Object.assign(process.env, storageEnv, { DRIVER_MODULE: path.join(REF, 'driver/lib/index.js') });

  let finished = false;
  const ticks: TickRecord[] = [];
  let tick = newTickCapture();
  function newTickCapture(): TickCapture {
    return {
      savedUsers: [],
      processedRooms: [],
      objectOrder: {},
      roomStats: {},
      roomErrors: [],
      loopErrors: [],
    };
  }
  function finish(error?: string) {
    if (finished) return;
    finished = true;
    storageChild.kill();
    fs.rmSync(dbDir, { recursive: true, force: true });
    const relevant = logs.filter((l) => l.level !== 'log' || /Error/.test(l.text)).slice(0, 50);
    required(process.send?.bind(process))({ type: 'result', error, ticks, logs: relevant }, () =>
      process.exit(0),
    );
  }
  onLog = (entry) => {
    const match = /^Error processing room (\S+?):\s*([^\n]*)/.exec(entry.text);
    if (match) tick.roomErrors.push({ room: required(match[1]), message: required(match[2]) });
    if (
      /^(Error while main loop|'Error while main loop|Error in processor loop|Error in runner loop|Unhandled rejection)/.test(
        entry.text,
      )
    ) {
      tick.loopErrors.push(entry.text.split('\n').slice(0, 3).join('\n'));
      if (/main loop/.test(entry.text))
        finish(
          `upstream main loop error at game time ${String(gameTime)}: ${String(entry.text.split('\n')[0])}`,
        );
    }
  };

  // ---- populate storage through the real common client (as backend tooling does) ------------
  const common = require('@screeps/common') as Common;
  await common.storage._connect();
  const { db, env } = common.storage;
  const jsonCopy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  for (const [collection, field] of COLLECTIONS) {
    const docs = Object.values(jsonCopy(world[field] || {}));
    if (docs.length) await required(db[collection]).insert(docs);
  }
  const terrainDocs = Object.keys(world.terrain).map((room) => ({
    room,
    terrain: world.terrain[room],
    type: 'terrain',
  }));
  await required(db['rooms.terrain']).insert(terrainDocs);
  await env.set(env.keys.GAMETIME, world.gameTime);
  await env.set(env.keys.MAIN_LOOP_MIN_DURATION, 1);
  await env.set(
    env.keys.TERRAIN_DATA,
    zlib
      .deflateSync(JSON.stringify(terrainDocs.map(({ room, terrain }) => ({ room, terrain }))))
      .toString('base64'),
  );
  if (world.activeRooms.length) await env.sadd(env.keys.ACTIVE_ROOMS, world.activeRooms);
  const eventLogs = Object.entries(world.roomEventLogs || {});
  if (eventLogs.length)
    await env.hmset(
      env.keys.ROOM_EVENT_LOG,
      Object.fromEntries(eventLogs.map(([room, log]) => [room, JSON.stringify(log)])),
    );
  for (const [room, view] of Object.entries(world.mapViews || {}))
    await env.set(env.keys.MAP_VIEW + room, JSON.stringify(view));

  // ---- upstream driver with observation hooks -----------------------------------------------
  const driver = require(required(process.env.DRIVER_MODULE)) as Driver;
  const originalStatsUpdater = driver.getRoomStatsUpdater;
  driver.getRoomStatsUpdater = (room) => {
    const updater = originalStatsUpdater(room);
    return {
      inc(name, userId, amount) {
        const users = (tick.roomStats[room] ??= {});
        const stats = (users[userId] ??= {});
        stats[name] = (stats[name] || 0) + amount;
        updater.inc(name, userId, amount);
      },
    };
  };
  driver.config.on('processorLoopStage', (stage, roomId) => {
    if (stage === 'processRoom') tick.processedRooms.push(roomId);
  });
  // Emitted for every object of a room in the order the processor iterates it (storage query order).
  driver.config.on('processObject', (object) => {
    (tick.objectOrder[object.room] ??= []).push(object._id);
  });

  async function snapshot(processedTime: number) {
    const out = { gameTime } as SnapshotWorld;
    // The main loop awaits this stage: these read-only RPCs see one completed tick. Keep collection
    // and document insertion order while avoiding eleven sequential TCP round trips per snapshot.
    const documents = await Promise.all(
      COLLECTIONS.map(([collection]) => required(db[collection]).find({})),
    );
    for (let index = 0; index < COLLECTIONS.length; index++) {
      const field = required(COLLECTIONS[index])[1];
      const indexed: Record<string, StorageDocument> = {};
      for (const doc of required(documents[index])) indexed[doc._id] = stripLoki(doc);
      Reflect.set(out, field, indexed);
    }
    out.activeRooms = (await env.smembers(env.keys.ACTIVE_ROOMS)) || [];
    out.roomEventLogs = {};
    for (const [room, json] of Object.entries(
      ((await env.get(env.keys.ROOM_EVENT_LOG)) as Record<string, string> | null | undefined) || {},
    )) {
      out.roomEventLogs[room] = JSON.parse(json) as ObservedWorld['roomEventLogs'][string];
    }
    out.mapViews = {};
    const history: TickRecord['history'] = {};
    for (const room of Object.keys(world.rooms)) {
      const view = await env.get(env.keys.MAP_VIEW + room);
      if (typeof view === 'string' && view)
        out.mapViews[room] = JSON.parse(view) as ObservedWorld['mapViews'][string];
      const data = await env.hget(env.keys.ROOM_HISTORY + room, String(processedTime));
      if (data) {
        const objects = JSON.parse(data) as Record<string, unknown>;
        for (const id of Object.keys(objects)) stripLoki(objects[id]);
        history[room] = objects;
      }
    }
    out.rngState = rng.state;
    return { world: out, history };
  }

  // Runs after notifyRoomsDone, before the next tick starts (the main loop awaits it).
  driver.config.mainLoopCustomStage = async () => {
    if (finished) return;
    const capture = tick;
    tick = newTickCapture();
    gameTime = await driver.getGameTime();
    const processedTime = gameTime - 1;
    const { world: state, history } = await snapshot(processedTime);
    ticks.push({
      gameTime: processedTime,
      savedUsers: capture.savedUsers,
      processedRooms: capture.processedRooms,
      objectOrder: capture.objectOrder,
      roomStats: capture.roomStats,
      history,
      roomErrors: capture.roomErrors,
      loopErrors: capture.loopErrors,
      world: state,
    });
    if (ticks.length >= scenario.ticks.length) finish();
  };

  const utils = require(path.join(REF, 'engine/src/utils.js')) as UpstreamUtils;
  require(path.join(REF, 'engine/src/main.js'));
  require(path.join(REF, 'engine/src/processor.js'));

  // ---- runner role (engine runner.js with a single runner thread) ---------------------------
  const usersQueue = driver.queue.create('users', 'read');
  const runUser = async (userId: string) => {
    const index = gameTime - world.gameTime;
    const [objects, marketOrders, userPowerCreeps] = await Promise.all([
      db['rooms.objects'].find({}),
      db['market.orders'].find({}),
      db['users.power_creeps'].find({}),
    ]);
    const resolve = createResolver({ roomObjects: objects, marketOrders, userPowerCreeps });
    const flat = resolve(
      (required(scenario.ticks[index]).intents || {})[userId] || {},
    ) as RawIntents;
    const runtimeData = {
      userObjects: {},
      roomObjects: Object.fromEntries(objects.map((o) => [o._id, o])),
    };
    const intents = utils.storeIntents(userId, flat, runtimeData, driver.config.customIntentTypes);
    tick.savedUsers.push(userId);
    await driver.saveUserIntents(userId, intents);
  };
  const runnerLoop = (): void => {
    void usersQueue.fetch().then((userId) => {
      if (gameTime - world.gameTime >= scenario.ticks.length) return; // scenario over: main loop stays parked
      void runUser(userId)
        .catch((error: unknown) => {
          console.error('Error in runner loop:', error instanceof Error ? error.stack : error);
        })
        .then(() => usersQueue.markDone(userId))
        .then(runnerLoop);
    });
  };
  loading = false;
  runnerLoop();
}

process.on('message', (payload) => {
  const message = payload as Omit<OracleRequest, 'type'> & { type?: string };
  if (message.type !== 'run') return;
  void run(message).catch((error: unknown) => {
    required(process.send?.bind(process))(
      {
        type: 'result',
        error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
        ticks: [],
        logs,
      },
      () => process.exit(1),
    );
  });
});
