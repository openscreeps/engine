/*
 * Runtime bundle entry evaluated inside every player isolate (screeps/driver `lib/runtime/runtime.js`,
 * `lib/runtime/runtime-driver.js` and `lib/runtime/mapgrid.js`). Exposes `SandboxEntry` on the global
 * only until the host has captured private references to it and deleted the global.
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { Buffer } from 'buffer/';
import { jsString } from '../../utils/js.ts';
import * as fakeConsole from '../game/console.ts';
import type { ScriptCompiler } from '../game/eval-code.ts';
import * as game from '../game/game.ts';
import type { HeapStatistics } from '../game/game.ts';
import { takeLocalChange } from '../game/inter-shard-memory.ts';
import { IntentRecorder } from '../game/intents.ts';
import { resetTerrain as resetPathFinderTerrain } from '../game/path-finder.ts';
import { createRawMemory, type SegmentRequests } from '../game/raw-memory.ts';
import type {
  MapGrid,
  MapGridRoomExits,
  RuntimeData,
  SandboxRuntimeData,
} from '../game/runtime-data.ts';
import type { SandboxGlobals } from '../game/scope.ts';
import { roomNameToXY } from '../../utils/index.ts';
import {
  SANDBOX_ENTRY_GLOBAL,
  type SandboxEntry,
  type SandboxResultMessage,
  type SandboxRunMessage,
} from '../protocol.ts';

/*
 * Intrinsics captured before any player code runs (driver `system-functions.js`): players may replace
 * the realm's globals, but the host boundary only uses these private references.
 */
/** A built-in method captured from its prototype before player code can replace it. */
function capturedMethod(target: object, name: string): (...args: never[]) => unknown {
  const fn: unknown = Object.getOwnPropertyDescriptor(target, name)?.value;
  if (typeof fn !== 'function') {
    throw new Error(`Missing built-in ${name}`);
  }
  return fn as (...args: never[]) => unknown;
}

const system = Object.freeze({
  jsonStringify: JSON.stringify,
  jsonParse: JSON.parse,
  objectKeys: Object.keys,
  objectEntries: Object.entries,
  objectSetPrototypeOf: Object.setPrototypeOf,
  objectCreate: Object.create,
  objectDefineProperty: Object.defineProperty,
  reflectGet: Reflect.get,
  reflectApply: Reflect.apply,
  reflectOwnKeys: Reflect.ownKeys,
  reflectDeleteProperty: Reflect.deleteProperty,
  reflectGetOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,
  toNumber: Number,
  arrayIsArray: Array.isArray,
  dateGetTime: capturedMethod(Date.prototype, 'getTime'),
  DateConstructor: Date,
  MapConstructor: Map,
  mapGet: capturedMethod(Map.prototype, 'get'),
  mapSet: capturedMethod(Map.prototype, 'set'),
  mapHas: capturedMethod(Map.prototype, 'has'),
  objectToString: capturedMethod(Object.prototype, 'toString'),
});

/** Thrown for values the reference transport (`ivm.ExternalCopy`, structured clone) cannot copy. */
class DataCloneError extends Error {
  override name = 'DataCloneError';
}

/** A property descriptor with a null prototype, so inherited `get`/`set`/… keys cannot leak in. */
function descriptor(value: unknown, data: boolean): PropertyDescriptor {
  const result = system.objectCreate(null) as PropertyDescriptor;
  result.value = value;
  if (data) {
    result.writable = true;
    result.enumerable = true;
    result.configurable = true;
  }
  return result;
}

function defineData(target: object, key: PropertyKey, value: unknown): void {
  system.objectDefineProperty(target, key, descriptor(value, true));
}

/**
 * Copies an outgoing value into a fresh structure of null-prototype objects, arrays and primitives
 * with structured-clone semantics (own enumerable string keys, getters read, cycles preserved,
 * functions and symbols rejected). It runs inside the billed phase using only intrinsics captured
 * before player code, so the final transport copy touches no player hooks or prototypes.
 */
function toTransport(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    if (typeof value === 'symbol') {
      throw new DataCloneError('Symbol() could not be cloned.');
    }
    return value;
  }
  if (typeof value === 'function') {
    throw new DataCloneError('function could not be cloned.');
  }
  if (system.reflectApply(system.mapHas, seen, [value])) {
    return system.reflectApply(system.mapGet, seen, [value]);
  }
  if (system.reflectApply(system.objectToString, value, []) === '[object Date]') {
    const time: unknown = system.reflectApply(system.dateGetTime, value, []);
    const copy = new system.DateConstructor(system.toNumber(time));
    system.reflectApply(system.mapSet, seen, [value, copy]);
    return copy;
  }
  const isArray = system.arrayIsArray(value);
  const copy: object = isArray ? [] : (system.objectCreate(null) as object);
  system.reflectApply(system.mapSet, seen, [value, copy]);
  const keys = system.reflectOwnKeys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string') {
      continue;
    }
    const descriptor = system.reflectGetOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      continue;
    }
    if (isArray && key === 'length') {
      continue;
    }
    defineData(copy, key, toTransport(system.reflectGet(value, key), seen));
  }
  if (isArray) {
    // Array `length` is non-configurable: only its value may be redefined (keeps holes like a clone).
    system.objectDefineProperty(
      copy,
      'length',
      descriptor(system.reflectGet(value, 'length'), false),
    );
  }
  return copy;
}

/** Isolate handle as seen from inside the sandbox (an isolated-vm `Isolate`). */
interface SandboxIsolate extends ScriptCompiler {
  readonly cpuTime: bigint;
  getHeapStatisticsSync(): HeapStatistics;
}

interface HostBindings {
  isolate: SandboxIsolate;
  context: unknown;
  halt: (() => void) | undefined;
  /**
   * Host callback sampling the isolate's CPU time at the boundaries of the billed phase
   * (`0` = right before `game.run()`, `1` = where the driver computes `usedCleanTime`).
   */
  cpuMark: (phase: number) => void;
}

const sandboxGlobal = globalThis as unknown as SandboxGlobals;

let host: HostBindings | undefined;
const staticTerrainData: Record<string, Uint8Array> = {};
let mapGrid: MapGrid | undefined;
let mapGridSource: string | undefined;

function isSandboxIsolate(value: unknown): value is SandboxIsolate {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof system.reflectGet(value, 'compileScriptSync') === 'function' &&
    typeof system.reflectGet(value, 'getHeapStatisticsSync') === 'function'
  );
}

function bindHalt(value: unknown): (() => void) | undefined {
  if (value !== null && typeof value === 'object') {
    const applySync: unknown = system.reflectGet(value, 'applySync');
    if (typeof applySync === 'function') {
      return () => {
        system.reflectApply(applySync, value, []);
      };
    }
  }
  return undefined;
}

function requireHost(): HostBindings {
  if (!host) {
    throw new Error('Sandbox host is not installed');
  }
  return host;
}

function nowCpuTime(): number {
  return system.toNumber(requireHost().isolate.cpuTime) / 1e6;
}

/** Driver `bufferFromBase64`: `Buffer.from(base64, 'base64')` with the webpack Buffer polyfill. */
function bufferFromBase64(data: string): Uint8Array {
  return Buffer.from(data, 'base64');
}

const GRID_DIRECTIONS: ReadonlyArray<
  readonly [keyof MapGridRoomExits, number, number, number, number]
> = [
  ['t', 0, 0, 1, 0],
  ['r', 49, 0, 0, 1],
  ['b', 0, 49, 1, 0],
  ['l', 0, 0, 0, 1],
];

/** Exit counts per accessible room (driver `WorldMapGrid._buildGridData`). */
function buildMapGrid(accessibleRooms: readonly string[]): MapGrid {
  const gridData: Record<string, MapGridRoomExits> = {};
  for (const roomName of accessibleRooms) {
    const [x, y] = roomNameToXY(roomName);
    const terrain = staticTerrainData[roomName];
    const roomData: MapGridRoomExits = {};
    for (const [dirName, startx, starty, dx, dy] of GRID_DIRECTIONS) {
      let curx = startx;
      let cury = starty;
      let numExits = 0;
      for (let i = 0; i < 50; ++i) {
        if (terrain?.[cury * 50 + curx] == 0) {
          numExits++;
        }
        curx += dx;
        cury += dy;
      }
      if (numExits > 0) {
        roomData[dirName] = numExits;
      }
    }
    gridData[`${String(x)},${String(y)}`] = roomData;
  }
  return { gridData };
}

function parseAccessibleRooms(source: string): string[] {
  const parsed: unknown = system.jsonParse(source);
  return system.arrayIsArray(parsed)
    ? parsed.filter((i): i is string => typeof i === 'string')
    : [];
}

function validateSegments(
  segments: Record<string, unknown>,
): Record<number, string> | string | undefined {
  const segmentKeys = system.objectKeys(segments);
  if (segmentKeys.length == 0) {
    return undefined;
  }
  if (segmentKeys.length > 10) {
    return 'Cannot save more than 10 memory segments on the same tick';
  }
  const result: Record<number, string> = {};
  for (const segmentKey of segmentKeys) {
    const key = parseInt(segmentKey);
    if (Number.isNaN(key) || key < 0 || key > 99) {
      return `"${segmentKey}" is not a valid memory segment ID`;
    }
    const value = segments[segmentKey];
    if (typeof value != 'string') {
      return `Memory segment #${segmentKey} is not a string`;
    }
    if (value.length > 100 * 1024) {
      return `Memory segment #${segmentKey} has exceeded 100 KB length limit`;
    }
    result[key] = value;
  }
  return result;
}

/** Upstream `_.isObject(e) && e.stack || e.toString()`. */
function errorText(e: unknown): string {
  if (e !== null && typeof e === 'object') {
    const stack: unknown = system.reflectGet(e, 'stack');
    if (stack) {
      return jsString(stack);
    }
  }
  return jsString(e);
}

function runTick(dataJson: string, cpu: number, cpuBucket: number): SandboxResultMessage {
  const bindings = requireHost();
  const parsed = system.jsonParse(dataJson) as Omit<RuntimeData, 'cpu' | 'cpuBucket'>;
  system.objectSetPrototypeOf(parsed, null);

  const startDirtyTime = nowCpuTime();
  let startTime = startDirtyTime;
  const requests: SegmentRequests = {
    activeSegments: undefined,
    publicSegments: undefined,
    defaultPublicSegment: undefined,
    activeForeignSegment: undefined,
  };
  const intents = new IntentRecorder();
  const rawMemory = createRawMemory(
    parsed.userMemory,
    parsed.memorySegments,
    parsed.foreignMemorySegment,
    requests,
  );
  rawMemory.interShardSegment = parsed.account.interShardSegment;

  if (!mapGrid || mapGridSource !== parsed.accessibleRooms) {
    mapGrid = buildMapGrid(parseAccessibleRooms(parsed.accessibleRooms));
    mapGridSource = parsed.accessibleRooms;
  }
  const data: SandboxRuntimeData = { ...parsed, cpu, cpuBucket, mapGrid, staticTerrainData };

  const getUsedCpu = (): number => nowCpuTime() + intents.cpu - startTime;
  const halt = bindings.halt;
  const cpuHalt = halt
    ? (): never => {
        halt();
        throw new Error('No one should ever see this message.');
      }
    : undefined;

  game.init({
    globals: sandboxGlobal,
    codeModules: data.userCode,
    runtimeData: data,
    intents,
    rawMemory,
    console: fakeConsole.makeConsole(),
    timeout: data.cpu,
    getUsedCpu,
    getHeapStatistics: () => bindings.isolate.getHeapStatisticsSync(),
    cpuHalt,
    evalHost: { compiler: bindings.isolate, context: bindings.context },
    bufferFromBase64,
  });

  startTime = nowCpuTime();
  bindings.cpuMark(0);
  let type: SandboxRunMessage['type'];
  let error: string | undefined;
  try {
    game.run();
    type = 'done';
  } catch (e) {
    type = 'error';
    error = errorText(e);
  }

  if (rawMemory._parsed) {
    data.userMemory.data = system.jsonStringify(rawMemory._parsed);
  }

  const memorySegments = validateSegments(rawMemory.segments);
  if (typeof memorySegments === 'string') {
    return { type: 'fatal', error: memorySegments };
  }

  const outMessage: SandboxRunMessage = {
    type,
    intentsList: intents.list,
    intentsCpu: intents.cpu,
    memory: data.userMemory.data,
    console: {
      log: fakeConsole.getMessages(),
      results: fakeConsole.getCommandResults(),
    },
  };
  if (error !== undefined) {
    outMessage.error = error;
  }
  if (memorySegments) {
    outMessage.memorySegments = memorySegments;
  }
  const visual = fakeConsole.getVisual();
  if (system.objectKeys(visual).length > 0) {
    outMessage.visual = visual;
  }
  if (requests.activeSegments) {
    outMessage.activeSegments = requests.activeSegments;
  }
  if (requests.activeForeignSegment !== undefined) {
    outMessage.activeForeignSegment = requests.activeForeignSegment;
  }
  if (requests.defaultPublicSegment !== undefined) {
    outMessage.defaultPublicSegment = requests.defaultPublicSegment;
  }
  if (requests.publicSegments) {
    outMessage.publicSegments = requests.publicSegments.join(',');
  }
  const interShardLocal = takeLocalChange();
  if (interShardLocal !== undefined) {
    outMessage.interShardLocal = interShardLocal;
  }
  const interShardSegment: unknown = rawMemory.interShardSegment;
  if (interShardSegment !== parsed.account.interShardSegment) {
    outMessage.interShardSegment = jsString(interShardSegment);
  }
  const shardLimits = game.takeShardLimitsRequest();
  if (shardLimits) {
    outMessage.shardLimits = shardLimits;
  }
  // The transport copy is part of the billed phase; after the end mark only our own plain
  // structure is handed to the host (structured clone, no player hooks).
  const transport = toTransport(
    outMessage,
    new system.MapConstructor<object, unknown>(),
  ) as SandboxRunMessage;
  bindings.cpuMark(1);
  return transport;
}

const entry: SandboxEntry = Object.freeze({
  install(): void {
    const isolate: unknown = system.reflectGet(globalThis, '_isolate');
    if (!isSandboxIsolate(isolate)) {
      throw new Error('Sandbox host did not provide a script compiler');
    }
    const cpuMark: unknown = system.reflectGet(globalThis, '_cpuMark');
    if (typeof cpuMark !== 'function') {
      throw new Error('Sandbox host did not provide a CPU mark callback');
    }
    host = {
      isolate,
      context: system.reflectGet(globalThis, '_context'),
      halt: bindHalt(system.reflectGet(globalThis, '_halt')),
      cpuMark: (phase: number): void => {
        system.reflectApply(cpuMark, undefined, [phase]);
      },
    };
    for (const name of [
      '_isolate',
      '_context',
      '_halt',
      '_cpuMark',
      '_ivm',
      SANDBOX_ENTRY_GLOBAL,
    ]) {
      Reflect.deleteProperty(globalThis, name);
    }
  },
  setStaticTerrainData(buffer: ArrayBuffer, roomOffsets: string): void {
    // Each load carries the complete terrain: removed rooms disappear and every cache derived from
    // the replaced arrays (map exit grid, PathFinder terrain) is rebuilt; player globals are kept.
    const offsets = system.jsonParse(roomOffsets) as Record<string, number>;
    for (const room of system.objectKeys(staticTerrainData)) {
      system.reflectDeleteProperty(staticTerrainData, room);
    }
    for (const [room, offset] of system.objectEntries(offsets)) {
      staticTerrainData[room] = new Uint8Array(buffer, offset, 2500);
    }
    mapGrid = undefined;
    resetPathFinderTerrain();
  },
  run(data: string, cpu: number, cpuBucket: number): SandboxResultMessage {
    try {
      return runTick(data, cpu, cpuBucket);
    } catch (e) {
      const fatal = system.objectCreate(null) as SandboxResultMessage;
      fatal.type = 'fatal';
      fatal.error = errorText(e);
      return fatal;
    }
  },
});

Object.defineProperty(globalThis, SANDBOX_ENTRY_GLOBAL, { value: entry, configurable: true });
