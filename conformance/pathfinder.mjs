// Differential conformance: src/utils/pathfinder.ts against the pinned screeps/driver path finder
// (lib/path-finder.js glue + the compiled native/src addon), executed unmodified in this process.
//
//   node conformance/pathfinder.mjs [--seeds N] [--start S] [--seed S] [--handcrafted-only]
//                                   [--max-failures K] [--report file.json]
//
// Runs the handcrafted cases plus N seeded random cases (default 1000 or $PATHFINDER_SEEDS, seeds
// S..S+N-1, default S=1); `--seed S` reruns one random case. Exits 1 on any mismatch; the native addon
// must be built by `npm run conformance:setup` (conformance/native.mjs), otherwise the suite fails.
//
// Every case is materialized independently for both sides from one JSON spec (fresh objects, matrices,
// proxies and callbacks), then the complete observable outcome is compared: result keys/order, path
// positions, ops, cost, incomplete, thrown error class/message/identity, and an ordered observation log
// (room callback invocations with arguments and receiver, option/goal/origin property reads, valueOf
// coercions, nested searches and RoomPosition constructions). Searches run on one long-lived finder per
// side, so state carried between repeated searches is exercised as well.
//
// Boundary: this compares the driver-level search (`driver.pathFinder.search`). The engine/runtime
// `PathFinder.search` wrapper (empty-goal short-circuit, RoomPosition class, `PathFinder.use` register)
// and the in-isolate native module are runtime-bridge concerns not exercised here.
import { isDeepStrictEqual, inspect } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { PathFinder } from '../src/utils/pathfinder.ts';
import { loadNativePathFinder } from './native.mjs';
import { referenceRoot } from './references.mjs';

// ---------------------------------------------------------------------------------------------------
// CLI

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}
const singleSeed = argument('--seed');
const seedCount =
  singleSeed !== undefined
    ? 1
    : Number(argument('--seeds', process.env.PATHFINDER_SEEDS ?? '1000'));
const seedStart = Number(singleSeed ?? argument('--start', '1'));
const handcraftedOnly = process.argv.includes('--handcrafted-only');
const runHandcrafted = singleSeed === undefined;
const maxFailures = Number(argument('--max-failures', '12'));
const reportPath = argument('--report');
if (!Number.isInteger(seedCount) || seedCount < 0 || !Number.isInteger(seedStart))
  throw new Error('--seeds/--start/--seed must be integers');

// ---------------------------------------------------------------------------------------------------
// Oracle: pinned driver lib/path-finder.js over the pinned native addon

const native = loadNativePathFinder();
const driverRoot = resolve(referenceRoot, 'driver');
const driverLock = JSON.parse(readFileSync(resolve(driverRoot, 'package-lock.json'), 'utf8'));
const localRequire = createRequire(import.meta.url);
const lodash = localRequire('lodash');
if (lodash.VERSION !== driverLock.packages['node_modules/lodash'].version)
  throw new Error(
    `driver pins lodash ${driverLock.packages['node_modules/lodash'].version}, engine provides ${lodash.VERSION}`,
  );

function loadDriverPathFinder() {
  const filename = resolve(driverRoot, 'lib', 'path-finder.js');
  const factory = vm.compileFunction(
    readFileSync(filename, 'utf8'),
    ['exports', 'require', 'module', '__filename', '__dirname'],
    {
      filename,
    },
  );
  const module = { exports: {} };
  factory(
    module.exports,
    (request) => {
      if (request === 'lodash') return lodash;
      throw new Error(`driver lib/path-finder.js requested unexpected module ${request}`);
    },
    module,
    filename,
    resolve(driverRoot, 'lib'),
  );
  return module.exports;
}
const driverModule = loadDriverPathFinder();

// ---------------------------------------------------------------------------------------------------
// World layout: a fixed set of rooms (terrain contents vary per case). The native addon keeps terrain in
// process-global storage and never forgets a room, so both sides always load exactly this set.

const kHalf = 127;
function roomName(mx, my) {
  return (
    (mx <= kHalf ? `W${kHalf - mx}` : `E${mx - kHalf - 1}`) +
    (my <= kHalf ? `N${kHalf - my}` : `S${my - kHalf - 1}`)
  );
}
const gridRooms = [];
for (let my = 126; my <= 128; ++my) for (let mx = 125; mx <= 129; ++mx) gridRooms.push([mx, my]);
const cornerRooms = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
  [255, 255],
  [254, 255],
  [255, 254],
  [0, 255],
  [255, 0],
];
const worldRooms = [...gridRooms, ...cornerRooms].map(([mx, my]) => ({
  mx,
  my,
  name: roomName(mx, my),
}));
const worldByName = new Map(worldRooms.map((room) => [room.name, room]));
const roomNames = worldRooms.map((room) => room.name);
const gridNames = gridRooms.map(([mx, my]) => roomName(mx, my));
const cornerNames = cornerRooms.map(([mx, my]) => roomName(mx, my));

// ---------------------------------------------------------------------------------------------------
// Deterministic randomness

function mulberry32(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
  };
  return rng;
}

// ---------------------------------------------------------------------------------------------------
// Terrain: spec { seed, style?, open?, rooms?: { [name]: { style?, fill?: [[x1,y1,x2,y2,code]] } } }
// open: grid perimeter left passable (searches may then touch unloaded rooms and throw upstream's error).

const terrainStyles = ['plain', 'sparse', 'dense', 'swampy', 'mixed', 'maze', 'stripes'];

function roomTerrain(rng, style) {
  const cells = new Array(2500).fill('0');
  const set = (x, y, code) => {
    if (x >= 0 && x < 50 && y >= 0 && y < 50) cells[y * 50 + x] = code;
  };
  switch (style) {
    case 'plain':
      break;
    case 'sparse':
      for (let ii = 0; ii < 2500; ++ii)
        if (rng.chance(0.08)) cells[ii] = rng.chance(0.7) ? '1' : '2';
      break;
    case 'dense':
      for (let ii = 0; ii < 2500; ++ii) if (rng.chance(0.3)) cells[ii] = '1';
      break;
    case 'swampy':
      for (let ii = 0; ii < 2500; ++ii)
        cells[ii] = rng.chance(0.55) ? '2' : rng.chance(0.08) ? '1' : '0';
      break;
    case 'mixed': {
      for (let blob = rng.int(4, 14); blob > 0; --blob) {
        const cx = rng.int(0, 49);
        const cy = rng.int(0, 49);
        const radius = rng.int(1, 7);
        const code = rng.pick(['1', '1', '2', '3']);
        for (let x = cx - radius; x <= cx + radius; ++x)
          for (let y = cy - radius; y <= cy + radius; ++y)
            if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) set(x, y, code);
      }
      break;
    }
    case 'maze':
      for (let x = 2; x < 48; x += rng.int(3, 6)) {
        const gap = rng.int(1, 47);
        for (let y = 1; y < 49; ++y) if (Math.abs(y - gap) > rng.int(0, 2)) set(x, y, '1');
      }
      break;
    case 'stripes':
      for (let y = 0; y < 50; ++y)
        for (let x = 0; x < 50; ++x) if ((x + y) % rng.int(3, 5) === 0) set(x, y, '2');
      break;
    default:
      throw new Error(`unknown terrain style ${style}`);
  }
  return cells;
}

function buildTerrain(spec) {
  const rng = mulberry32(spec.seed ?? 0);
  const rooms = new Map();
  for (const room of worldRooms) {
    const custom = spec.rooms?.[room.name] ?? {};
    const style = custom.style ?? spec.style ?? rng.pick(terrainStyles);
    const cells = roomTerrain(rng, style);
    if (!spec.open) {
      // Close the edges facing rooms outside the loaded set.
      const loaded = (dx, dy) =>
        worldByName.has(roomName((room.mx + dx) & 0xff, (room.my + dy) & 0xff));
      for (let ii = 0; ii < 50; ++ii) {
        if (!loaded(-1, 0)) cells[ii * 50] = '1';
        if (!loaded(1, 0)) cells[ii * 50 + 49] = '1';
        if (!loaded(0, -1)) cells[ii] = '1';
        if (!loaded(0, 1)) cells[49 * 50 + ii] = '1';
      }
    }
    for (const [x1, y1, x2, y2, code] of custom.fill ?? [])
      for (let x = x1; x <= x2; ++x)
        for (let y = y1; y <= y2; ++y) cells[y * 50 + x] = String(code);
    rooms.set(room.name, cells.join(''));
  }
  return [...rooms].map(([room, terrain]) => ({ room, terrain }));
}

// ---------------------------------------------------------------------------------------------------
// Value DSL. Plain JSON stays as is (arrays/objects recurse); objects with a `$` key are special:
//   {$:'undefined'|'NaN'|'Infinity'|'-Infinity'|'-0'|'symbol'|'function'}
//   {$:'bigint', value:'5'}                  {$:'valueOf', label, value}  (logs each coercion)
//   {$:'proxy', label, target}               (logs get/has/ownKeys/getOwnPropertyDescriptor)
//   {$:'sparse', length, items:{index:value}} {$:'throwingGetter', label, key, base}
//   {$:'callback', ...}                       (see makeCallback)

function describeKey(key) {
  return typeof key === 'symbol' ? key.toString() : key;
}

function materialize(desc, ctx) {
  if (desc === null || typeof desc !== 'object') return desc;
  if (Array.isArray(desc)) return desc.map((item) => materialize(item, ctx));
  if (!('$' in desc)) {
    const out = {};
    for (const [key, value] of Object.entries(desc)) out[key] = materialize(value, ctx);
    return out;
  }
  switch (desc.$) {
    case 'undefined':
      return undefined;
    case 'NaN':
      return NaN;
    case 'Infinity':
      return Infinity;
    case '-Infinity':
      return -Infinity;
    case '-0':
      return -0;
    case 'symbol':
      return Symbol('value');
    case 'function':
      return function value() {};
    case 'bigint':
      return BigInt(desc.value);
    case 'valueOf': {
      const value = materialize(desc.value, ctx);
      return {
        valueOf() {
          ctx.log.push(`valueOf ${desc.label}`);
          return value;
        },
      };
    }
    case 'proxy': {
      const target = materialize(desc.target, ctx);
      return new Proxy(target, {
        get(object, key, receiver) {
          ctx.log.push(`get ${desc.label}.${describeKey(key)}`);
          return Reflect.get(object, key, receiver);
        },
        has(object, key) {
          ctx.log.push(`has ${desc.label}.${describeKey(key)}`);
          return Reflect.has(object, key);
        },
        ownKeys(object) {
          ctx.log.push(`ownKeys ${desc.label}`);
          return Reflect.ownKeys(object);
        },
        getOwnPropertyDescriptor(object, key) {
          ctx.log.push(`getOwnPropertyDescriptor ${desc.label}.${describeKey(key)}`);
          return Reflect.getOwnPropertyDescriptor(object, key);
        },
      });
    }
    case 'sparse': {
      const array = new Array(desc.length);
      for (const [index, value] of Object.entries(desc.items))
        array[Number(index)] = materialize(value, ctx);
      return array;
    }
    case 'throwingGetter': {
      const base = materialize(desc.base ?? {}, ctx);
      Object.defineProperty(base, desc.key, {
        enumerable: true,
        get() {
          ctx.log.push(`throw ${desc.label}.${desc.key}`);
          throw new RangeError(`getter ${desc.label}.${desc.key}`);
        },
      });
      return base;
    }
    case 'callback':
      return makeCallback(desc, ctx);
    default:
      throw new Error(`unknown descriptor ${desc.$}`);
  }
}

// Cost matrix bytes for a {matrix} action: deterministic from its seed.
function matrixBytes(seed, density) {
  const rng = mulberry32(seed);
  const bytes = new Uint8Array(2500);
  const mode = rng.int(0, 3);
  for (let ii = 0; ii < 2500; ++ii) {
    if (!rng.chance(density ?? 0.15)) continue;
    bytes[ii] =
      mode === 0 ? 255 : mode === 1 ? rng.int(1, 254) : rng.pick([255, 255, 1, 2, 10, 50, 254]);
  }
  if (mode === 3) {
    // A blocking line with a single gap, column-major like CostMatrix (x * 50 + y).
    const x = rng.int(3, 46);
    const gap = rng.int(0, 49);
    for (let y = 0; y < 50; ++y) if (y !== gap) bytes[x * 50 + y] = 255;
  }
  return bytes;
}

// Returns what the callback hands back for a {matrix} action, per container kind.
function matrixContainer(action) {
  const bytes = matrixBytes(action.matrix, action.density);
  switch (action.kind ?? 'u8') {
    case 'u8':
      return { _bits: bytes };
    case 'u16':
      return { _bits: new Uint16Array(bytes.buffer) };
    case 'u32':
      return { _bits: new Uint32Array(bytes.buffer) };
    case 'f64': // 2500 bytes is not a multiple of 8: no such view exists; use 2504 bytes (313 elements)
      return { _bits: new Float64Array(313) };
    case 'dataview':
      return { _bits: new DataView(bytes.buffer) };
    case 'offset': {
      const backing = new Uint8Array(2600);
      backing.set(bytes, 100);
      return { _bits: backing.subarray(100, 2600) };
    }
    case 'short':
      return { _bits: bytes.subarray(0, 2499) };
    case 'long': {
      const backing = new Uint8Array(2501);
      backing.set(bytes);
      return { _bits: backing };
    }
    case 'array':
      return { _bits: Array.from(bytes) };
    case 'buffer':
      return { _bits: bytes.buffer };
    case 'bitsNull':
      return { _bits: null };
    case 'bitsMissing':
      return {};
    case 'shared': {
      const shared = new Uint8Array(new SharedArrayBuffer(2500));
      shared.set(bytes);
      return { _bits: shared };
    }
    default:
      throw new Error(`unknown matrix kind ${action.kind}`);
  }
}

const callbackSentinel = Symbol('callback error');

// {$:'callback', sloppy?, rules?:{room:action}, default?:action, label?}
// actions: 'undefined'|'false'|'null'|'zero'|'true'|'emptyString'|'nan'|'object'|'throw'|
//          {matrix, kind?, density?}|{nested:{origin, goal, options}, then?:action}|
//          {mutate:{room, x, y, value}, then?:action}
function makeCallback(desc, ctx) {
  const returned = new Map();
  const apply = (action, name) => {
    if (typeof action === 'string') {
      switch (action) {
        case 'undefined':
          return undefined;
        case 'false':
          return false;
        case 'null':
          return null;
        case 'zero':
          return 0;
        case 'true':
          return true;
        case 'emptyString':
          return '';
        case 'nan':
          return NaN;
        case 'object':
          return {};
        case 'throw': {
          const error = new Error(`callback threw for ${name}`);
          error[callbackSentinel] = true;
          throw error;
        }
        default:
          throw new Error(`unknown callback action ${action}`);
      }
    }
    if ('matrix' in action) {
      const container = matrixContainer(action);
      returned.set(name, container);
      return container;
    }
    if ('nested' in action) {
      const outcome = ctx.run(action.nested, `${ctx.depth + 1}`);
      ctx.log.push(`nested from ${name}: ${JSON.stringify(outcome)}`);
      return apply(action.then ?? 'undefined', name);
    }
    if ('mutate' in action) {
      const { room, x, y, value } = action.mutate;
      const container = returned.get(room);
      if (container?._bits)
        new Uint8Array(container._bits.buffer, container._bits.byteOffset)[x * 50 + y] = value;
      ctx.log.push(`mutate ${room} ${container ? 'hit' : 'miss'}`);
      return apply(action.then ?? 'undefined', name);
    }
    throw new Error(`unknown callback action ${JSON.stringify(action)}`);
  };
  const body = (receiver, args) => {
    const name = args[0];
    const kind =
      receiver === undefined ? 'undefined' : receiver === globalThis ? 'global' : typeof receiver;
    ctx.log.push(
      `callback ${desc.label ?? ''}(${args.map((arg) => inspect(arg)).join(', ')}) this=${kind}`,
    );
    return apply(desc.rules?.[name] ?? desc.default ?? 'undefined', name);
  };
  if (desc.sloppy) {
    // Sloppy-mode function: an undefined receiver is observed as the global object.
    return new Function(
      'body',
      'return function () { return body(this, Array.prototype.slice.call(arguments)); }',
    )(body);
  }
  return function (...args) {
    return body(this, args);
  };
}

// ---------------------------------------------------------------------------------------------------
// Sides

class Position {
  constructor(x, y, roomName) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  }
}

function normalizeError(error) {
  if (error === null || typeof error !== 'object') return { thrown: inspect(error) };
  return {
    class: error.constructor?.name,
    message: error.message,
    fromCallback: Boolean(error[callbackSentinel]),
  };
}

function normalizeResult(result, positions) {
  if (result === null || typeof result !== 'object') return { value: inspect(result) };
  const out = { keys: Object.keys(result) };
  for (const key of out.keys) {
    const value = result[key];
    if (key === 'path' && Array.isArray(value)) {
      out.path = value.map((pos) =>
        pos instanceof Position ? [pos.x, pos.y, pos.roomName] : { foreign: inspect(pos) },
      );
    } else out[key] = value;
  }
  out.positionsConstructed = positions.count;
  return out;
}

function makeSide(name, search) {
  const positions = { count: 0 };
  return { name, search, positions };
}

const ports = new PathFinder();
const driverSearch = driverModule.create(native);
driverSearch.make({
  RoomPosition: class RoomPosition extends Position {
    constructor(x, y, roomName) {
      super(x, y, roomName);
      sides.native.positions.count++;
    }
  },
});
const sides = {
  native: makeSide('native', (origin, goal, options) => driverSearch.search(origin, goal, options)),
  port: makeSide('port', (origin, goal, options) =>
    ports.search(origin, goal, options, (x, y, roomName) => {
      sides.port.positions.count++;
      return new Position(x, y, roomName);
    }),
  ),
};

function loadWorld(side, rooms) {
  if (side === sides.native) driverModule.init(native, rooms);
  else ports.loadTerrain(rooms);
}

/** Runs one search spec on one side; returns a JSON-able outcome. */
function runSearch(side, spec, log, depth) {
  const ctx = {
    log,
    depth,
    run: (nested, label) => runSearch(side, nested, log, label),
  };
  const before = side.positions.count;
  const origin = materialize(spec.origin, ctx);
  const goal = materialize(spec.goal, ctx);
  const options = materialize(spec.options, ctx);
  const argc = spec.argc ?? 3;
  const args = [origin, goal, options].slice(0, argc);
  try {
    const result = side.search(...args);
    const positions = { count: side.positions.count - before };
    return { ok: normalizeResult(result, positions) };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

function runCase(side, testCase) {
  loadWorld(side, testCase.rooms);
  const runs = [];
  for (let ii = 0; ii < (testCase.spec.repeat ?? 1); ++ii) {
    const log = [];
    const outcome = runSearch(side, testCase.spec, log, '0');
    runs.push({ ...outcome, log });
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------
// Case construction

const U = { $: 'undefined' };
const pos = (x, y, roomName) => ({ x, y, roomName });
const goal = (p, range) => (range === undefined ? { pos: p } : { pos: p, range });

function handcrafted() {
  const plain = { seed: 1, style: 'plain' };
  const cases = [];
  const add = (name, tags, spec, terrain = plain) => cases.push({ name, tags, spec, terrain });
  const base = pos(25, 25, 'W1N0');

  // Existing pinned observation (test/pathfinder.test.ts), on a world with E0S0/E1S0 neighbours.
  add('pinned-tie-cross-room', ['cross-room', 'ties', 'callback-false', 'maxRooms'], {
    origin: pos(48, 25, 'E0S0'),
    goal: goal(pos(2, 25, 'E1S0'), 0),
    options: {
      maxRooms: 2,
      roomCallback: {
        $: 'callback',
        rules: { E0S0: 'undefined', E1S0: 'undefined' },
        default: 'false',
      },
    },
  });
  add('pinned-maxOps-partial', ['cross-room', 'maxOps', 'incomplete'], {
    origin: pos(48, 25, 'E0S0'),
    goal: goal(pos(2, 25, 'E1S0'), 0),
    options: {
      maxOps: 1,
      roomCallback: {
        $: 'callback',
        rules: { E0S0: 'undefined', E1S0: 'undefined' },
        default: 'false',
      },
    },
  });
  add('same-position', ['same-room', 'trivial'], { origin: base, goal: base, options: U });
  add('within-range', ['same-room', 'range'], {
    origin: base,
    goal: goal(pos(27, 27, 'W1N0'), 3),
    options: U,
  });
  add('range-coercion', ['same-room', 'range', 'coercion'], {
    origin: base,
    goal: [
      goal(pos(40, 40, 'W1N0'), '2'),
      goal(pos(5, 5, 'W1N0'), -4),
      goal(pos(45, 5, 'W1N0'), 2.9),
      goal(pos(5, 45, 'W1N0'), { $: 'NaN' }),
    ],
    options: U,
  });
  add('plain-straight', ['same-room'], { origin: base, goal: pos(45, 25, 'W1N0'), options: U });
  add('plain-diagonal', ['same-room', 'ties'], {
    origin: base,
    goal: pos(40, 40, 'W1N0'),
    options: U,
  });
  add('cross-W-E', ['cross-room'], {
    origin: pos(40, 10, 'W0N0'),
    goal: pos(10, 30, 'E0N0'),
    options: U,
  });
  add('cross-N-S', ['cross-room'], {
    origin: pos(10, 40, 'W1N0'),
    goal: pos(10, 10, 'W1S0'),
    options: U,
  });
  add('cross-diagonal-corner', ['cross-room', 'edge'], {
    origin: pos(48, 48, 'W1N0'),
    goal: pos(1, 1, 'W0S0'),
    options: U,
  });
  add('two-rooms-away', ['cross-room'], {
    origin: pos(25, 25, 'W2N1'),
    goal: pos(25, 25, 'E0S0'),
    options: { maxOps: 20000 },
  });
  add('origin-on-exit', ['cross-room', 'edge'], {
    origin: pos(0, 25, 'W0N0'),
    goal: pos(10, 25, 'W0N0'),
    options: U,
  });
  add('goal-on-exit', ['cross-room', 'edge'], {
    origin: pos(10, 25, 'W0N0'),
    goal: pos(49, 25, 'W0N0'),
    options: U,
  });
  add('corner-tiles', ['edge'], {
    origin: pos(0, 0, 'W0N0'),
    goal: pos(49, 49, 'W0N0'),
    options: U,
  });
  add('flee-basic', ['flee'], {
    origin: base,
    goal: goal(pos(27, 25, 'W1N0'), 5),
    options: { flee: true },
  });
  add('flee-already-safe', ['flee', 'trivial'], {
    origin: base,
    goal: goal(pos(40, 25, 'W1N0'), 3),
    options: { flee: true },
  });
  add('flee-multi', ['flee', 'multi-goal'], {
    origin: base,
    goal: [goal(pos(23, 25, 'W1N0'), 6), goal(pos(28, 28, 'W1N0'), 8), pos(25, 24, 'W1N0')],
    options: { flee: 1 },
  });
  add('flee-cross-room', ['flee', 'cross-room'], {
    origin: pos(45, 25, 'W1N0'),
    goal: goal(pos(40, 25, 'W1N0'), 10),
    options: { flee: 'yes' },
  });
  add('multi-goal-nearest', ['multi-goal'], {
    origin: base,
    goal: [pos(5, 5, 'W1N0'), goal(pos(45, 45, 'W1N0'), 4), goal(pos(25, 10, 'W0N0'), 1)],
    options: U,
  });
  add(
    'goal-in-wall',
    ['same-room', 'incomplete'],
    { origin: base, goal: pos(30, 30, 'W1N0'), options: { maxOps: 500 } },
    {
      ...plain,
      rooms: { W1N0: { fill: [[28, 28, 32, 32, 1]] } },
    },
  );
  add(
    'enclosed-origin',
    ['same-room', 'incomplete'],
    { origin: base, goal: pos(40, 25, 'W1N0'), options: U },
    {
      ...plain,
      rooms: {
        W1N0: {
          fill: [
            [23, 23, 27, 23, 1],
            [23, 27, 27, 27, 1],
            [23, 24, 23, 26, 1],
            [27, 24, 27, 26, 1],
          ],
        },
      },
    },
  );
  add(
    'swamp-detour',
    ['same-room', 'swamp'],
    { origin: pos(5, 25, 'W1N0'), goal: pos(45, 25, 'W1N0'), options: U },
    {
      ...plain,
      rooms: { W1N0: { fill: [[10, 0, 40, 30, 2]] } },
    },
  );
  add(
    'swamp-costs',
    ['same-room', 'swamp', 'coercion'],
    {
      origin: pos(5, 25, 'W1N0'),
      goal: pos(45, 25, 'W1N0'),
      options: { plainCost: 2, swampCost: 1 },
    },
    { ...plain, rooms: { W1N0: { fill: [[10, 0, 40, 30, 2]] } } },
  );
  add(
    'terrain-code-3',
    ['same-room', 'walls'],
    { origin: pos(5, 25, 'W1N0'), goal: pos(45, 25, 'W1N0'), options: U },
    {
      ...plain,
      rooms: { W1N0: { fill: [[20, 0, 20, 40, 3]] } },
    },
  );
  for (const [label, value] of [
    ['zero', 0],
    ['negative', -5],
    ['huge', 1e12],
    ['string', '7'],
    ['fraction', 2.9],
    ['NaN', { $: 'NaN' }],
    ['Infinity', { $: 'Infinity' }],
    ['valueOf', { $: 'valueOf', label: 'maxOps', value: 3 }],
    ['null', null],
    ['true', true],
  ]) {
    add(
      `maxOps-${label}`,
      ['maxOps', 'coercion'],
      { origin: base, goal: pos(45, 40, 'W0N0'), options: { maxOps: value } },
      { seed: 5 },
    );
    add(
      `maxCost-${label}`,
      ['maxCost', 'coercion'],
      { origin: base, goal: pos(45, 40, 'W0N0'), options: { maxCost: value } },
      { seed: 5 },
    );
    add(
      `maxRooms-${label}`,
      ['maxRooms', 'coercion'],
      { origin: base, goal: pos(45, 40, 'W0N0'), options: { maxRooms: value } },
      { seed: 5 },
    );
    add(
      `heuristicWeight-${label}`,
      ['heuristicWeight', 'coercion'],
      {
        origin: base,
        goal: pos(45, 40, 'W0N0'),
        options: { heuristicWeight: value },
      },
      { seed: 5 },
    );
    add(
      `plainCost-${label}`,
      ['costs', 'coercion'],
      { origin: base, goal: pos(45, 40, 'W0N0'), options: { plainCost: value, swampCost: value } },
      { seed: 5 },
    );
  }
  add(
    'heuristicWeight-max',
    ['heuristicWeight'],
    { origin: base, goal: pos(45, 40, 'W0S0'), options: { heuristicWeight: 9 } },
    { seed: 7 },
  );
  add(
    'heuristicWeight-fraction',
    ['heuristicWeight'],
    { origin: base, goal: pos(45, 40, 'W0S0'), options: { heuristicWeight: 1.0001 } },
    { seed: 7 },
  );
  add(
    'maxCost-cutoff',
    ['maxCost', 'incomplete'],
    { origin: base, goal: pos(45, 40, 'W0S0'), options: { maxCost: 30 } },
    { seed: 7 },
  );
  add('maxRooms-1-cross', ['maxRooms', 'cross-room', 'incomplete'], {
    origin: base,
    goal: pos(25, 25, 'W0N0'),
    options: { maxRooms: 1 },
  });
  add(
    'maxRooms-64',
    ['maxRooms', 'cross-room'],
    {
      origin: pos(5, 5, 'W2N1'),
      goal: pos(45, 45, 'E1S0'),
      options: { maxRooms: 64, maxOps: 100000 },
    },
    { seed: 9 },
  );
  add('empty-goal-array', ['invalid', 'multi-goal'], {
    origin: base,
    goal: [],
    options: { maxOps: 50 },
  });
  add('empty-goal-array-flee', ['invalid', 'flee'], {
    origin: base,
    goal: [],
    options: { flee: true },
  });

  // Invalid inputs and coercion
  for (const [label, origin] of [
    ['null', null],
    ['undefined', U],
    ['empty', {}],
    ['x50', pos(50, 1, 'W1N0')],
    ['x-1', pos(-1, 1, 'W1N0')],
    ['strings', pos('5', '6', 'W1N0')],
    ['fraction', pos(5.9, 6.9, 'W1N0')],
    ['negative-fraction', pos(-0.5, 6, 'W1N0')],
    ['bad-room', pos(5, 5, 'X1N0')],
    ['lowercase-room', pos(5, 5, 'w1n0')],
    ['room-out-of-world', pos(5, 5, 'W128N0')],
    ['room-object', pos(5, 5, { toString: { $: 'function' } })],
    ['bigint', pos({ $: 'bigint', value: '5' }, 5, 'W1N0')],
    ['symbol', pos({ $: 'symbol' }, 5, 'W1N0')],
    ['primitive', 5],
    ['unloaded-room', pos(25, 25, 'E50S50')],
    [
      'valueOf',
      pos(
        { $: 'valueOf', label: 'origin.x', value: 4 },
        { $: 'valueOf', label: 'origin.y', value: 7 },
        'W1N0',
      ),
    ],
    [
      'throwing-getter',
      { $: 'throwingGetter', label: 'origin', key: 'roomName', base: { x: 1, y: 1 } },
    ],
  ])
    add(`origin-${label}`, ['invalid', 'origin'], {
      origin,
      goal: pos(30, 30, 'W1N0'),
      options: U,
    });
  for (const [label, target] of [
    ['null', null],
    ['undefined', U],
    ['array-null', [null]],
    ['array-undefined', [U]],
    ['sparse', { $: 'sparse', length: 2, items: { 1: pos(30, 30, 'W1N0') } }],
    ['sparse-trailing', { $: 'sparse', length: 3, items: { 0: pos(30, 30, 'W1N0') } }],
    ['number', 7],
    ['string', 'W1N0'],
    ['pos-null', { pos: null, range: 1 }],
    ['pos-missing-room', { x: 3, y: 3 }],
    ['range-object', goal(pos(30, 30, 'W1N0'), { $: 'valueOf', label: 'range', value: 2 })],
    ['partial-pos-and-pos', { x: 1, y: 2, pos: pos(30, 30, 'W1N0') }],
    ['x-null-y-room', { x: null, y: 1, roomName: 'W1N0' }],
    ['bad-room', pos(3, 3, 'W1N')],
    ['out-of-room', pos(3, 51, 'W1N0')],
    ['unloaded-room-goal', pos(25, 25, 'E50S50')],
    ['throwing-goal', { $: 'throwingGetter', label: 'goal', key: 'y', base: { x: 1 } }],
    ['goal-error-order', [pos(3, 3, 'W1N0'), null]],
    ['array-like', { 0: pos(30, 30, 'W1N0'), length: 1 }],
  ])
    add(`goal-${label}`, ['invalid', 'goal'], { origin: base, goal: target, options: U });
  add('goal-and-origin-both-invalid', ['invalid'], {
    origin: null,
    goal: [pos(1, 1, 'X')],
    options: U,
  });
  for (const [label, options] of [
    ['null', null],
    ['number', 5],
    ['string', 'flee'],
    ['array', [1, 2]],
    ['false', false],
    ['throwing-getter', { $: 'throwingGetter', label: 'options', key: 'maxOps', base: {} }],
    [
      'throwing-callback-getter',
      { $: 'throwingGetter', label: 'options', key: 'roomCallback', base: { maxOps: 10 } },
    ],
  ])
    add(`options-${label}`, ['invalid', 'options'], {
      origin: base,
      goal: pos(30, 30, 'W1N0'),
      options,
    });
  add('argc-1', ['invalid'], { origin: base, goal: U, options: U, argc: 1 });
  add('argc-2', ['invalid'], { origin: base, goal: pos(30, 30, 'W1N0'), options: U, argc: 2 });

  // Proxies: exact property read order and coercion.
  add('proxy-reads', ['proxy', 'coercion', 'multi-goal'], {
    origin: { $: 'proxy', label: 'origin', target: pos(10, 10, 'W1N0') },
    goal: {
      $: 'proxy',
      label: 'goals',
      target: [
        { $: 'proxy', label: 'g0', target: pos(30, 30, 'W1N0') },
        {
          $: 'proxy',
          label: 'g1',
          target: goal({ $: 'proxy', label: 'g1.pos', target: pos(40, 10, 'W0N0') }, 2),
        },
      ],
    },
    options: {
      $: 'proxy',
      label: 'options',
      target: {
        plainCost: { $: 'valueOf', label: 'plainCost', value: 2 },
        swampCost: { $: 'valueOf', label: 'swampCost', value: 3 },
        maxOps: { $: 'valueOf', label: 'maxOps', value: 3000 },
        maxCost: { $: 'valueOf', label: 'maxCost', value: 3000 },
        maxRooms: { $: 'valueOf', label: 'maxRooms', value: 4 },
        heuristicWeight: { $: 'valueOf', label: 'heuristicWeight', value: 1.5 },
        flee: { $: 'valueOf', label: 'flee', value: false },
        roomCallback: { $: 'callback' },
      },
    },
  });
  add('proxy-single-goal', ['proxy'], {
    origin: { $: 'proxy', label: 'origin', target: pos(10, 10, 'W1N0') },
    goal: { $: 'proxy', label: 'goal', target: goal(pos(30, 30, 'W1N0'), 1) },
    options: { $: 'proxy', label: 'options', target: {} },
  });

  // Room callbacks
  const target = pos(25, 25, 'E0S0');
  const cross = { origin: pos(25, 25, 'W1N0'), goal: target };
  add('callback-default', ['callback'], { ...cross, options: { roomCallback: { $: 'callback' } } });
  add('callback-sloppy-receiver', ['callback'], {
    ...cross,
    options: { roomCallback: { $: 'callback', sloppy: true } },
  });
  for (const action of ['false', 'null', 'zero', 'true', 'emptyString', 'nan', 'object'])
    add(`callback-all-${action}`, ['callback', `callback-${action}`], {
      ...cross,
      options: { roomCallback: { $: 'callback', default: action } },
    });
  for (const kind of [
    'u8',
    'u16',
    'u32',
    'f64',
    'dataview',
    'offset',
    'short',
    'long',
    'array',
    'buffer',
    'bitsNull',
    'bitsMissing',
    'shared',
  ])
    add(`callback-matrix-${kind}`, ['callback', 'cost-matrix', `matrix-${kind}`], {
      ...cross,
      options: { roomCallback: { $: 'callback', default: { matrix: 42, kind, density: 0.3 } } },
    });
  add('callback-origin-false', ['callback', 'callback-false'], {
    ...cross,
    options: { roomCallback: { $: 'callback', rules: { W1N0: 'false' } } },
  });
  add('callback-throw-origin', ['callback', 'callback-throw'], {
    ...cross,
    options: { roomCallback: { $: 'callback', rules: { W1N0: 'throw' } } },
  });
  add('callback-throw-later', ['callback', 'callback-throw'], {
    ...cross,
    options: { roomCallback: { $: 'callback', rules: { W0S0: 'throw', E0N0: 'throw' } } },
  });
  add('callback-after-throw-reuse', ['callback', 'repeat'], {
    ...cross,
    repeat: 3,
    options: { roomCallback: { $: 'callback', rules: { W0N0: 'throw' } } },
  });
  add('callback-not-function', ['callback', 'callback-nonfunction'], {
    ...cross,
    options: { roomCallback: 5 },
  });
  add('callback-not-function-object', ['callback', 'callback-nonfunction'], {
    ...cross,
    options: { roomCallback: { _bits: 1 } },
  });
  add('callback-mutate-live-matrix', ['callback', 'cost-matrix'], {
    origin: pos(5, 25, 'W1N0'),
    goal: pos(45, 25, 'W0N0'),
    options: {
      roomCallback: {
        $: 'callback',
        rules: {
          W1N0: { matrix: 7, density: 0 },
          W0N0: {
            mutate: { room: 'W1N0', x: 6, y: 25, value: 255 },
            then: { matrix: 8, density: 0.05 },
          },
        },
      },
    },
  });
  const nestedSpec = (depth) => ({
    origin: pos(10, 10, 'W0N0'),
    goal: goal(pos(40, 40, 'W0N0'), 1),
    options: {
      maxOps: 300,
      roomCallback:
        depth > 0
          ? {
              $: 'callback',
              label: `depth${depth}`,
              rules: { W0N0: { nested: nestedSpec(depth - 1), then: { matrix: 50 + depth } } },
            }
          : { $: 'callback', label: 'leaf' },
    },
  });
  add('nested-search-depth-3', ['callback', 'nested', 'repeat'], {
    ...cross,
    repeat: 2,
    options: nestedSpec(3).options,
  });
  add('nested-search-throw', ['callback', 'nested', 'callback-throw'], {
    ...cross,
    options: {
      roomCallback: {
        $: 'callback',
        rules: {
          W1N0: {
            nested: {
              origin: base,
              goal: pos(5, 5, 'W1N0'),
              options: { roomCallback: { $: 'callback', default: 'throw' } },
            },
          },
        },
      },
    },
  });

  // Unloaded terrain is an error once a search expands into it.
  add(
    'unloaded-neighbour',
    ['edge', 'missing-terrain'],
    { origin: pos(2, 25, 'W2N0'), goal: pos(25, 25, 'W2N0'), options: { flee: true } },
    { seed: 3, style: 'plain', open: true },
  );
  add(
    'unloaded-neighbour-blocked',
    ['edge', 'missing-terrain', 'callback-false'],
    {
      origin: pos(2, 25, 'W2N0'),
      goal: goal(pos(2, 25, 'W2N0'), 10),
      options: { flee: true, roomCallback: { $: 'callback', rules: { W3N0: 'false' } } },
    },
    { seed: 3, style: 'plain', open: true },
  );

  // World edges: (0, 0) is native `world_position_t::null()`; map coordinates wrap at 256.
  const corner = { seed: 11, style: 'plain', open: true };
  add(
    'world-null-origin',
    ['edge', 'world-edge'],
    { origin: pos(0, 0, 'W127N127'), goal: pos(10, 10, 'W127N127'), options: U },
    corner,
  );
  add(
    'world-null-goal',
    ['edge', 'world-edge'],
    { origin: pos(10, 10, 'W127N127'), goal: pos(0, 0, 'W127N127'), options: U },
    corner,
  );
  add(
    'world-null-jump',
    ['edge', 'world-edge'],
    { origin: pos(5, 5, 'W127N127'), goal: pos(0, 0, 'W127N127'), options: { maxOps: 50 } },
    corner,
  );
  add(
    'world-edge-flee',
    ['edge', 'world-edge', 'flee'],
    { origin: pos(2, 2, 'W127N127'), goal: goal(pos(3, 3, 'W127N127'), 6), options: U },
    corner,
  );
  add(
    'world-edge-flee-active',
    ['edge', 'world-edge', 'flee'],
    {
      origin: pos(2, 2, 'W127N127'),
      goal: goal(pos(3, 3, 'W127N127'), 6),
      options: { flee: true },
    },
    corner,
  );
  add(
    'world-wrap-east',
    ['edge', 'world-edge', 'cross-room'],
    { origin: pos(45, 25, 'E127S127'), goal: pos(5, 25, 'W127S127'), options: U },
    corner,
  );
  add(
    'world-wrap-south',
    ['edge', 'world-edge', 'cross-room'],
    { origin: pos(25, 45, 'E127S127'), goal: pos(25, 5, 'E127N127'), options: U },
    corner,
  );
  add(
    'world-wrap-west',
    ['edge', 'world-edge', 'cross-room'],
    { origin: pos(3, 25, 'W127N127'), goal: pos(45, 25, 'E127N127'), options: { maxOps: 200 } },
    corner,
  );
  add(
    'world-wrap-north',
    ['edge', 'world-edge', 'cross-room'],
    { origin: pos(25, 3, 'W127N127'), goal: pos(25, 45, 'W127S127'), options: { maxOps: 200 } },
    corner,
  );
  add(
    'world-corner-diagonal',
    ['edge', 'world-edge', 'cross-room'],
    { origin: pos(47, 47, 'W127N127'), goal: pos(2, 2, 'W126N126'), options: U },
    corner,
  );
  return cases;
}

// Random cases ---------------------------------------------------------------------------------------

const valuePools = {
  plainCost: [U, U, 1, 2, 3, 10, 254, 255, 0, -2, '4', 2.5, { $: 'NaN' }, null],
  swampCost: [U, U, 1, 2, 5, 10, 25, 254, 0, '3', 1.9],
  maxOps: [U, U, 1, 2, 5, 20, 100, 500, 2000, 10000, 0, -1, '30', 7.7],
  maxCost: [U, U, 1, 3, 10, 30, 60, 120, 300, 0, -3, 2 ** 31, 2 ** 32 + 5],
  maxRooms: [U, U, 1, 2, 3, 4, 16, 64, 100, 0, -2, '2'],
  heuristicWeight: [U, U, 1, 1.2, 1.5, 2, 3.7, 9, 12, 0.5, 0, '2', { $: 'NaN' }],
  flee: [U, false, true, 1, 0, ''],
};

function randomPosition(rng, roomPool) {
  const room = rng.pick(roomPool);
  const coord = () => (rng.chance(0.2) ? rng.pick([0, 1, 2, 47, 48, 49]) : rng.int(0, 49));
  return pos(coord(), coord(), room);
}

function nearbyRoom(rng, name) {
  const room = worldByName.get(name);
  const candidates = worldRooms.filter((other) => {
    const dx = Math.min(Math.abs(other.mx - room.mx), 256 - Math.abs(other.mx - room.mx));
    const dy = Math.min(Math.abs(other.my - room.my), 256 - Math.abs(other.my - room.my));
    return Math.max(dx, dy) <= 2;
  });
  return rng.pick(candidates).name;
}

function randomCallback(rng, origin) {
  const roll = rng.next();
  if (roll < 0.35) return U;
  if (roll < 0.4) return rng.pick([5, 'fn', {}, null, true]);
  const rules = {};
  const actions = [
    'undefined',
    'undefined',
    'false',
    'null',
    () => ({ matrix: rng.int(1, 1e6), density: rng.pick([0.02, 0.1, 0.3, 0.6]) }),
    () => ({ matrix: rng.int(1, 1e6), density: rng.pick([0.05, 0.2]) }),
    () => ({
      matrix: rng.int(1, 1e6),
      kind: rng.pick(['u16', 'offset', 'short', 'array', 'dataview']),
    }),
  ];
  const draw = () => {
    const action = rng.pick(actions);
    return typeof action === 'function' ? action() : action;
  };
  for (const name of roomNames) if (rng.chance(0.5)) rules[name] = draw();
  if (rng.chance(0.05)) rules[nearbyRoom(rng, origin.roomName)] = 'throw';
  if (rng.chance(0.08) && rules[origin.roomName] === undefined) rules[origin.roomName] = 'false';
  return {
    $: 'callback',
    sloppy: rng.chance(0.1),
    rules,
    default: rng.chance(0.7) ? 'undefined' : draw(),
  };
}

function randomCase(seed) {
  const rng = mulberry32(seed);
  const tags = [];
  const roomPool = rng.chance(0.85) ? gridNames : cornerNames;
  const terrain = { seed: rng.int(1, 2 ** 31), open: roomPool === cornerNames || rng.chance(0.05) };
  if (rng.chance(0.3)) terrain.style = rng.pick(terrainStyles);
  const origin = randomPosition(rng, roomPool);
  const goalCount = rng.chance(0.55) ? 1 : rng.int(2, 4);
  const goals = [];
  for (let ii = 0; ii < goalCount; ++ii) {
    const target = randomPosition(rng, [
      rng.chance(0.4) ? origin.roomName : nearbyRoom(rng, origin.roomName),
    ]);
    goals.push(
      rng.chance(0.4) ? target : goal(target, rng.pick([0, 1, 1, 2, 3, 5, 8, 15, U, -1, '2'])),
    );
  }
  let goalValue = goalCount === 1 && rng.chance(0.6) ? goals[0] : goals;
  if (rng.chance(0.03))
    goalValue = rng.pick([[], null, [null], { $: 'sparse', length: 2, items: { 1: goals[0] } }]);
  const options = {};
  for (const [key, pool] of Object.entries(valuePools))
    if (rng.chance(key === 'flee' ? 0.25 : 0.3)) options[key] = rng.pick(pool);
  if (rng.chance(0.05)) options.maxOps = { $: 'valueOf', label: 'maxOps', value: rng.int(1, 3000) };
  const callback = randomCallback(rng, origin);
  if (callback !== U) options.roomCallback = callback;
  const spec = {
    origin,
    goal: goalValue,
    options: rng.chance(0.03) ? rng.pick([null, U, 5]) : options,
  };
  if (rng.chance(0.1)) spec.repeat = 2;
  if (rng.chance(0.05)) {
    spec.origin = { $: 'proxy', label: 'origin', target: spec.origin };
    if (spec.options === options)
      spec.options = { $: 'proxy', label: 'options', target: spec.options };
  }
  // Tags for reporting.
  const goalRooms = goals.map((item) => (item.pos ?? item).roomName);
  tags.push(goalRooms.every((name) => name === origin.roomName) ? 'same-room' : 'cross-room');
  if (roomPool === cornerNames) tags.push('world-edge');
  if (goalCount > 1) tags.push('multi-goal');
  if (options.flee !== undefined && options.flee !== U) tags.push('flee');
  for (const key of ['maxOps', 'maxCost', 'maxRooms', 'heuristicWeight'])
    if (key in options) tags.push(key);
  if ('plainCost' in options || 'swampCost' in options) tags.push('costs');
  if (callback !== U) tags.push(callback?.$ === 'callback' ? 'callback' : 'callback-nonfunction');
  if (goalValue !== goals && !(goalCount === 1 && goalValue === goals[0])) tags.push('invalid');
  if (spec.repeat) tags.push('repeat');
  if (terrain.open) tags.push('open-perimeter');
  return { name: `seed-${seed}`, seed, tags, spec, terrain };
}

// ---------------------------------------------------------------------------------------------------
// Runner

function firstDifference(a, b, path = '') {
  if (isDeepStrictEqual(a, b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const found = firstDifference(a[key], b[key], `${path}/${key}`);
      if (found) return found;
    }
  }
  return { at: path || '/', native: a, port: b };
}

const cases = [...(runHandcrafted ? handcrafted() : [])];
if (!handcraftedOnly)
  for (let seed = seedStart; seed < seedStart + seedCount; ++seed) cases.push(randomCase(seed));

const tagCounts = new Map();
const failures = [];
let compared = 0;
let completed = 0;
let errored = 0;
const errorMessages = new Map();
let incomplete = 0;
for (const testCase of cases) {
  testCase.rooms = buildTerrain(testCase.terrain);
  const expected = runCase(sides.native, testCase);
  const actual = runCase(sides.port, testCase);
  compared += expected.length;
  for (const run of expected) {
    if (run.error) {
      errored++;
      const message = `${run.error.class}: ${run.error.fromCallback ? '<room callback error>' : run.error.message}`;
      errorMessages.set(message, (errorMessages.get(message) ?? 0) + 1);
    } else if (run.ok?.incomplete) incomplete++;
    else completed++;
  }
  const outcomeTags = expected.map((run) =>
    run.error ? 'outcome:error' : run.ok?.incomplete ? 'outcome:incomplete' : 'outcome:complete',
  );
  const difference = firstDifference(expected, actual);
  for (const tag of new Set([...testCase.tags, ...outcomeTags])) {
    const count = tagCounts.get(tag) ?? { cases: 0, mismatches: 0 };
    count.cases++;
    if (difference) count.mismatches++;
    tagCounts.set(tag, count);
  }
  if (difference) {
    const { rooms: _rooms, ...rest } = testCase;
    failures.push({ ...rest, difference, native: expected, port: actual });
  }
}

const summary = {
  oracle:
    'pinned screeps/driver lib/path-finder.js + native/src addon (node-gyp build of driver commit)',
  source: 'src/utils/pathfinder.ts PathFinder',
  boundary:
    'driver-level search; engine/runtime PathFinder.search wrapper and isolate bridge not exercised',
  node: process.version,
  cases: cases.length,
  searches: compared,
  outcomes: { complete: completed, incomplete, error: errored },
  oracleErrors: Object.fromEntries([...errorMessages].sort(([, a], [, b]) => b - a)),
  handcrafted: runHandcrafted ? handcrafted().length : 0,
  seeds: handcraftedOnly ? 0 : { start: seedStart, count: seedCount },
  matching: cases.length - failures.length,
  mismatching: failures.length,
  tags: Object.fromEntries(
    [...tagCounts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => [tag, `${count.cases - count.mismatches}/${count.cases} matching`]),
  ),
};
const { tags, ...totals } = summary;
console.log(JSON.stringify(totals, null, 2));
console.log(
  Object.entries(tags)
    .map(([tag, text]) => `  ${tag}: ${text}`)
    .join('\n'),
);
for (const failure of failures.slice(0, maxFailures)) {
  console.log(
    `\nMISMATCH ${failure.name}${failure.seed !== undefined ? ` (rerun: --seed ${failure.seed})` : ''} [${failure.tags.join(', ')}]`,
  );
  console.log(
    inspect(
      { difference: failure.difference, spec: failure.spec, terrain: failure.terrain },
      { depth: 8, breakLength: 160 },
    ),
  );
}
if (failures.length > maxFailures)
  console.log(`\n... ${failures.length - maxFailures} more mismatches (--max-failures)`);
if (reportPath) writeFileSync(reportPath, `${JSON.stringify({ summary, failures }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
