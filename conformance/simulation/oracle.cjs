'use strict';
/*
 * Oracle child process: runs one scenario through the pinned upstream server processes.
 *
 * Executed unmodified from the pinned checkouts:
 *  - storage: screeps/storage `lib/index.js` start() (LokiJS database, db/queue/pubsub RPC methods), in
 *    its own process (storage-process.cjs);
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
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const util = require('util');
const zlib = require('zlib');
const Module = require('module');
const { fork } = require('child_process');
const { COLLECTIONS, createResolver, clockAt, mulberry32Next } = require('./shared.cjs');

// ---- controlled nondeterminism (before any upstream module is loaded) -------------------------
const rng = { state: 0 };
// Draws made while a module is being evaluated (third-party initialization such as brace-expansion's
// escape tokens, lazily loaded during the first tick) are not game draws; they get their own stream.
const moduleInitRng = { state: 0x9e3779b9 };
// SIMULATION_ORACLE_RNG_TRACE=<file>: append every draw's call site (diagnosing draw-order mismatches).
const rngTrace = process.env.SIMULATION_ORACLE_RNG_TRACE;
Math.random = function random() {
  const stack = new Error().stack;
  const moduleInit = stack.includes('Module._compile');
  if (rngTrace) {
    const site = stack
      .split('\n')
      .slice(2, 5)
      .map((line) => line.trim())
      .join(' < ');
    fs.appendFileSync(rngTrace, `${moduleInit ? 'module-init' : rng.gameTime} ${site}\n`);
  }
  return mulberry32Next(moduleInit ? moduleInitRng : rng);
};
const clock = { now: () => 0 };
const RealDate = Date;
class ControlledDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock.now());
    else super(...args);
  }
  static now() {
    return clock.now();
  }
}
globalThis.Date = ControlledDate;

// ---- console capture ---------------------------------------------------------------------------
const logs = [];
let onLog = () => {};
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    const entry = { level, text: util.format(...args) };
    logs.push(entry);
    onLog(entry);
  };
}

function installResolution(REF) {
  const COMMON = path.join(REF, 'common');
  const DRIVER = path.join(REF, 'driver') + path.sep;
  const ENGINE = path.join(REF, 'engine');
  const unavailable = (what) =>
    function unavailableInOracle() {
      throw new Error(`conformance oracle: ${what} is not available to the processor oracle`);
    };
  const stub = (name, exports) => {
    const id = path.join(REF, 'driver', `__conformance_stub_${name}__.js`);
    const m = new Module(id);
    m.filename = id;
    m.loaded = true;
    m.exports = exports;
    require.cache[id] = m;
    return id;
  };
  const driverStubs = {
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
  Module._resolveFilename = function resolveForOracle(request, parent, isMain, options) {
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
      if (Object.prototype.hasOwnProperty.call(driverStubs, request)) return driverStubs[request];
      // The driver is not npm-installed (no native build); its pure JS deps come from the engine's.
      if (!request.startsWith('.') && !path.isAbsolute(request) && !request.startsWith('node:')) {
        return original.call(this, request, parent, isMain, { paths: [ENGINE] });
      }
    }
    return original.call(this, request, parent, isMain, options);
  };
}

/** Loki bookkeeping (`$loki`, `meta`) is not game state; strip it from documents and history objects. */
function stripLoki(doc) {
  if (doc && typeof doc === 'object') {
    delete doc.$loki;
    delete doc.meta;
  }
  return doc;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startStorage(REF, env) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'storage-process.cjs'), [], {
      env: { ...process.env, ...env, SIMULATION_REFERENCE_ROOT: REF },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('message', (message) => {
      if (message === 'storageLaunched') resolve(child);
    });
    child.on('exit', (code) =>
      reject(new Error(`storage process exited with code ${code}: ${output.slice(-2000)}`)),
    );
  });
}

async function run({ referenceRoot: REF, scenario }) {
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
  const ticks = [];
  let tick = newTickCapture();
  function newTickCapture() {
    return {
      savedUsers: [],
      processedRooms: [],
      objectOrder: {},
      roomStats: {},
      roomErrors: [],
      loopErrors: [],
    };
  }
  function finish(error) {
    if (finished) return;
    finished = true;
    storageChild.kill();
    fs.rmSync(dbDir, { recursive: true, force: true });
    const relevant = logs.filter((l) => l.level !== 'log' || /Error/.test(l.text)).slice(0, 50);
    process.send({ type: 'result', error, ticks, logs: relevant }, () => process.exit(0));
  }
  onLog = (entry) => {
    const match = /^Error processing room (\S+?):\s*([^\n]*)/.exec(entry.text);
    if (match) tick.roomErrors.push({ room: match[1], message: match[2] });
    if (
      /^(Error while main loop|'Error while main loop|Error in processor loop|Error in runner loop|Unhandled rejection)/.test(
        entry.text,
      )
    ) {
      tick.loopErrors.push(entry.text.split('\n').slice(0, 3).join('\n'));
      if (/main loop/.test(entry.text))
        finish(`upstream main loop error at game time ${gameTime}: ${entry.text.split('\n')[0]}`);
    }
  };

  // ---- populate storage through the real common client (as backend tooling does) ------------
  const common = require('@screeps/common');
  await common.storage._connect();
  const { db, env } = common.storage;
  const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
  for (const [collection, field] of COLLECTIONS) {
    const docs = Object.values(jsonCopy(world[field] || {}));
    if (docs.length) await db[collection].insert(docs);
  }
  const terrainDocs = Object.keys(world.terrain).map((room) => ({
    room,
    terrain: world.terrain[room],
    type: 'terrain',
  }));
  await db['rooms.terrain'].insert(terrainDocs);
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
  const driver = require(process.env.DRIVER_MODULE);
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
    (tick.objectOrder[object.room] ??= []).push(String(object._id));
  });

  async function snapshot(processedTime) {
    const out = { gameTime };
    for (const [collection, field] of COLLECTIONS) {
      out[field] = {};
      for (const doc of await db[collection].find({})) out[field][doc._id] = stripLoki(doc);
    }
    out.activeRooms = (await env.smembers(env.keys.ACTIVE_ROOMS)) || [];
    out.roomEventLogs = {};
    for (const [room, json] of Object.entries((await env.get(env.keys.ROOM_EVENT_LOG)) || {})) {
      out.roomEventLogs[room] = JSON.parse(json);
    }
    out.mapViews = {};
    const history = {};
    for (const room of Object.keys(world.rooms)) {
      const view = await env.get(env.keys.MAP_VIEW + room);
      if (view) out.mapViews[room] = JSON.parse(view);
      const data = await env.hget(env.keys.ROOM_HISTORY + room, String(processedTime));
      if (data) {
        const objects = JSON.parse(data);
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

  const utils = require(path.join(REF, 'engine/src/utils.js'));
  require(path.join(REF, 'engine/src/main.js'));
  require(path.join(REF, 'engine/src/processor.js'));

  // ---- runner role (engine runner.js with a single runner thread) ---------------------------
  const usersQueue = driver.queue.create('users', 'read');
  const runUser = async (userId) => {
    const index = gameTime - world.gameTime;
    const [objects, marketOrders, userPowerCreeps] = await Promise.all([
      db['rooms.objects'].find({}),
      db['market.orders'].find({}),
      db['users.power_creeps'].find({}),
    ]);
    const resolve = createResolver({ roomObjects: objects, marketOrders, userPowerCreeps });
    const flat = resolve((scenario.ticks[index].intents || {})[userId] || {});
    const runtimeData = {
      userObjects: {},
      roomObjects: Object.fromEntries(objects.map((o) => [o._id, o])),
    };
    const intents = utils.storeIntents(userId, flat, runtimeData, driver.config.customIntentTypes);
    tick.savedUsers.push(userId);
    await driver.saveUserIntents(userId, intents);
  };
  const runnerLoop = () => {
    usersQueue.fetch().then((userId) => {
      if (gameTime - world.gameTime >= scenario.ticks.length) return; // scenario over: main loop stays parked
      runUser(userId)
        .catch((error) =>
          console.error('Error in runner loop:', error && error.stack ? error.stack : error),
        )
        .then(() => usersQueue.markDone(userId))
        .then(runnerLoop);
    });
  };
  loading = false;
  runnerLoop();
}

process.on('message', (message) => {
  if (message.type !== 'run') return;
  run(message).catch((error) => {
    process.send(
      {
        type: 'result',
        error: error && error.stack ? error.stack : String(error),
        ticks: [],
        logs,
      },
      () => process.exit(1),
    );
  });
});
