/*
 * Room, RoomVisual and Room.Terrain (screeps/engine `src/game/rooms.js`), including the room path
 * finding helpers backed by the shared PathFinder or the legacy grid path finder.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { clone, cloneDeep, contains, isArray, isUndefined, jsSetSloppy } from './compat.ts';
import { exposeGlobal, gameConstructor, type GameConstructor } from './define.ts';
import { RoomPosition } from './room-position.ts';
import { RoomObject } from './room-object.ts';
import { AStarFinder, chebyshev, DijkstraFinder, Grid } from './legacy-pathfinding.ts';
import { CostMatrix, PathFinder } from './path-finder.ts';
import { memoryRoot, scope } from './scope.ts';
import type { Flag } from './flags.ts';
import type { StructureController, StructureStorage, StructureTerminal } from './structures.ts';
import type { EventLogEntry } from '../../simulation/state.ts';
import {
  checkConstructionSite,
  checkControllerAvailability,
  deserializePath,
  fetchXYArguments,
  getDirection,
  jsAdd,
  jsBitAnd,
  jsConcat,
  jsGe,
  jsGt,
  jsLe,
  jsLt,
  jsMul,
  jsString,
  jsSub,
  serializePath,
  toNumber,
  toPrimitive,
  toPropertyKey,
} from '../../utils/index.ts';
import type { PathStep } from '../../utils/index.ts';
import { isNumber, isObject, isString, size } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';

/**
 * One step of a path returned by `Room.findPath`. Coordinates and deltas keep the raw values upstream
 * stored (numbers for RoomPositions; duck-typed targets may carry other values).
 */
export interface RoomPathStep {
  x: unknown;
  y: unknown;
  dx: unknown;
  dy: unknown;
  direction: number | undefined;
}

// ---------------------------------------------------------------------------------------------
// Untrusted-value helpers (JS property access and lodash 3 callback semantics)
// ---------------------------------------------------------------------------------------------

/** `obj[key]` where `key` is a raw player value (ToPropertyKey applied, then the JS property read). */
export function readProp(obj: unknown, key: unknown): unknown {
  return getProp(obj, typeof key === 'string' ? key : toPropertyKey(key));
}

/** Sloppy-mode `obj[key] = value` where `key` is a raw player value. */
function writeProp(obj: unknown, key: unknown, value: unknown): void {
  jsSetSloppy(obj, toPropertyKey(key), value);
}

/** Upstream `utils.getDirection(dx, dy)` on raw deltas (its `Math.abs(dx)`, `Math.abs(dy)` ToNumber them in order). */
function pathDirection(dx: unknown, dy: unknown): number | undefined {
  return getDirection(toNumber(dx), toNumber(dy));
}

/** `v++` value: ToNumeric then increment (unlike `v + 1`, strings do not concatenate). */
function jsInc(v: unknown): number | bigint {
  const numeric = toPrimitive(v, 'number');
  return typeof numeric === 'bigint' ? numeric + 1n : toNumber(numeric) + 1;
}

/** Template-literal ToString (`${v}`): string-hint ToPrimitive; Symbols throw. */
export function jsTemplate(v: unknown): string {
  if (typeof v === 'symbol') {
    throw new TypeError('Cannot convert a Symbol value to a string');
  }
  return jsString(v);
}

/** Upstream `x < 0 || x > 49 || y < 0 || y > 49` on raw coordinates (same evaluation order). */
function outOfRoom(x: unknown, y: unknown): boolean {
  return jsLt(x, 0) || jsGt(x, 49) || jsLt(y, 0) || jsGt(y, 49);
}

/** `obj.method(...args)` on an untrusted value; `expr` is the upstream call expression for the error. */
function callMethod(obj: unknown, name: string, args: unknown[], expr: string = name): unknown {
  const fn = readProp(obj, name);
  if (typeof fn !== 'function') {
    throw new TypeError(`${expr} is not a function`);
  }
  const result: unknown = Reflect.apply(fn, obj, args);
  return result;
}

/** Upstream `opts = opts || {}` for an options object that may be mutated afterwards. */
export function toOptions(value: unknown): Record<string, unknown> {
  const opts: unknown = value || {};
  if (typeof opts === 'object' || typeof opts === 'function') {
    return opts as Record<string, unknown>;
  }
  // Upstream (sloppy mode) silently drops writes to primitives: write to a throwaway wrapper.
  return Object(opts) as Record<string, unknown>;
}

/** lodash 3 `baseEach` values: array-likes (incl. strings/functions) by index, else own enumerable keys. */
function collectionValues(collection: unknown): unknown[] {
  const length = collection ? getProp(collection, 'length') : 0;
  if (
    typeof length === 'number' &&
    length > -1 &&
    length % 1 == 0 &&
    length <= Number.MAX_SAFE_INTEGER
  ) {
    const values: unknown[] = [];
    for (let i = 0; i < length; i++) {
      values.push(getProp(collection, i));
    }
    return values;
  }
  return isObject(collection) ? Object.keys(collection).map((key) => getProp(collection, key)) : [];
}

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

/** lodash 3 `baseIsEqual(source, value, undefined, isLoose = true)` used by `_.matches`. */
function looseEqual(source: unknown, value: unknown): boolean {
  if (source === value) {
    return true;
  }
  if (
    source === null ||
    value === null ||
    source === undefined ||
    value === undefined ||
    (!isObject(source) && !isObject(value))
  ) {
    return source !== source && value !== value;
  }
  const tag = tagOf(source);
  if (tag !== tagOf(value)) {
    return false;
  }
  if (tag === '[object Date]' || tag === '[object Boolean]' || tag === '[object Number]') {
    const a = Number(source);
    const b = Number(value);
    return a != a ? b != b : a == b;
  }
  if (tag === '[object String]' || tag === '[object RegExp]') {
    return jsString(source) == jsString(value);
  }
  if (Array.isArray(source) && Array.isArray(value)) {
    if (source.length != value.length && !(value.length > source.length)) {
      return false;
    }
    return source.every((item: unknown) =>
      value.some((other: unknown) => item === other || looseEqual(item, other)),
    );
  }
  if (!isObject(source) || !isObject(value)) {
    return false;
  }
  for (const key of Object.keys(source)) {
    if (!(key in value)) {
      return false;
    }
    const srcValue = readProp(source, key);
    const objValue = readProp(value, key);
    if (!(srcValue === objValue || looseEqual(srcValue, objValue))) {
      return false;
    }
  }
  return true;
}

/** lodash 3 `_.matches(source)` predicate. */
function isMatch(object: unknown, source: object): boolean {
  const keys = Object.keys(source);
  if (object === null || object === undefined) {
    return !keys.length;
  }
  const target: object =
    typeof object === 'object' || typeof object === 'function'
      ? object
      : (Object(object) as object);
  for (const key of keys) {
    const srcValue = readProp(source, key);
    const objValue = readProp(target, key);
    if (srcValue === srcValue && !isObject(srcValue)) {
      if (!(objValue === srcValue && (srcValue !== undefined || key in target))) {
        return false;
      }
    } else if ((objValue === undefined && !(key in target)) || !looseEqual(srcValue, objValue)) {
      return false;
    }
  }
  return true;
}

/** lodash 3 `_.callback(predicate)` without `thisArg`. */
function lodashIteratee(
  predicate: unknown,
): (value: unknown, index: number, collection: unknown) => unknown {
  if (typeof predicate === 'function') {
    return (value, index, collection) => {
      const result: unknown = Reflect.apply(predicate, undefined, [value, index, collection]);
      return result;
    };
  }
  if (predicate === null || predicate === undefined) {
    return (value) => value;
  }
  if (typeof predicate === 'object') {
    return (value) => isMatch(value, predicate);
  }
  const path = jsString(predicate);
  if (
    typeof predicate === 'string' &&
    /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\n\\]|\\.)*?\1)\]/.test(path)
  ) {
    const parts = path
      .replace(
        /\[(\d+|["']([^"']*)["'])\]/g,
        (_m, index: string, quoted: string | undefined) => '.' + (quoted ?? index),
      )
      .split('.');
    return (value) => {
      let current = value;
      for (const part of parts) {
        if (current === null || current === undefined) {
          return undefined;
        }
        current = readProp(current, part);
      }
      return current;
    };
  }
  return (value) => (value === null || value === undefined ? undefined : readProp(value, path));
}

/** lodash 3 `_.filter(collection, predicate)` */
export function lodashFilter<T>(collection: readonly T[], predicate: unknown): T[];
export function lodashFilter(collection: unknown, predicate: unknown): unknown[];
export function lodashFilter(collection: unknown, predicate: unknown): unknown[] {
  const iteratee = lodashIteratee(predicate);
  return collectionValues(collection).filter((value, index) => iteratee(value, index, collection));
}

/** lodash 3 `_.find(collection, predicate)` */
export function lodashFind(collection: unknown, predicate: unknown): unknown {
  const iteratee = lodashIteratee(predicate);
  return collectionValues(collection).find((value, index) => iteratee(value, index, collection));
}

/** lodash 3 `_.any(collection, predicate)` */
function lodashSome(collection: unknown, predicate: unknown): boolean {
  const iteratee = lodashIteratee(predicate);
  return collectionValues(collection).some((value, index) => iteratee(value, index, collection));
}

/** Upstream `runtimeData.staticTerrainData[roomName]` (raw read; missing rooms yield `undefined`). */
export function staticTerrain(roomName: unknown): unknown {
  return readProp(scope().runtimeData.staticTerrainData, roomName);
}

/** Upstream `terrain[y * 50 + x]` with raw player coordinates (native `*`/`+`, then ToPropertyKey). */
export function terrainAt(terrain: unknown, x: unknown, y: unknown): unknown {
  return readProp(terrain, jsAdd(jsMul(y, 50), x));
}

/** Upstream `terrainCode & mask`; a BigInt code throws (mixing) like upstream, otherwise a number. */
export function maskBits(terrainCode: unknown, mask: number): number {
  return toNumber(jsBitAnd(terrainCode, mask));
}

// ---------------------------------------------------------------------------------------------
// Module state (reset every tick by make())
// ---------------------------------------------------------------------------------------------

type LookRegister = Readonly<Record<string, RoomObject>>;
type LookSpatialRegister = readonly (readonly RoomObject[] | undefined)[];

class PositionsSetCache {
  readonly cache: Record<string, unknown[]> = {};
  readonly #roomName: unknown;

  constructor(roomName: unknown) {
    this.#roomName = roomName;
  }

  key(array: unknown): number {
    if (!isArray(array)) {
      return 0;
    }

    const positionsArray = array.map((i: unknown) => {
      if (i && readProp(i, 'pos')) {
        return readProp(i, 'pos');
      }
      if (isObject(i) && !isUndefined(readProp(i, 'x')) && !(i instanceof RoomPosition)) {
        return new RoomPosition(readProp(i, 'x'), readProp(i, 'y'), this.#roomName);
      }
      return i;
    });

    const found = Object.keys(this.cache).find((cacheKey) => {
      const objects = this.cache[cacheKey] ?? [];
      return (
        positionsArray.length == objects.length &&
        positionsArray.every((j) =>
          objects.some((object) => {
            const isEqualTo = isObject(j) ? readProp(j, 'isEqualTo') : undefined;
            if (!isObject(j) || !isEqualTo) {
              throw new Error('Invalid position ' + jsConcat(j) + ', check your `opts` property');
            }
            if (typeof isEqualTo !== 'function') {
              throw new TypeError('j.isEqualTo is not a function');
            }
            return Boolean(Reflect.apply(isEqualTo, j, [object]));
          }),
        )
      );
    });

    if (found === undefined) {
      const key = positionsSetCacheCounter++;
      this.cache[key] = clone(array);
      return key;
    }
    return parseInt(found);
  }
}

interface RoomPrivateStore {
  pfGrid: Record<string, Grid>;
  pfGrid2: Record<string, CostMatrix>;
  pfFinders: Record<string, AStarFinder>;
  pfEndNodes: Record<string, unknown>;
  pfDijkstraFinder: DijkstraFinder;
  pathCache: Record<string, RoomPathStep[]>;
  positionsSetCache: PositionsSetCache;
  lookTypeRegisters: Record<string, LookRegister | undefined>;
  lookTypeSpatialRegisters: Record<string, LookSpatialRegister | undefined>;
}

let positionsSetCacheCounter = 1;
let createdFlagNames: unknown[] = [];
let createdSpawnNames: string[] = [];
let privateStore: Record<string, RoomPrivateStore> = {};
let createdConstructionSites = 0;
/** Upstream `TerrainConstructor`/`TerrainConstructorSet`: captured once per sandbox from the first terrain array. */
let terrainConstructor: unknown = null;
let terrainConstructorSet: unknown = null;

function storeOf(roomName: string): RoomPrivateStore {
  const store = privateStore[roomName];
  if (!store) {
    throw new TypeError(`Cannot read properties of undefined (reading '${roomName}')`);
  }
  return store;
}

// ---------------------------------------------------------------------------------------------
// Path finding helpers
// ---------------------------------------------------------------------------------------------

const DESTRUCTIBLE_TYPES = [
  'constructedWall',
  'spawn',
  'extension',
  'link',
  'storage',
  'observer',
  'tower',
  'powerBank',
  'powerSpawn',
  'lab',
  'terminal',
];

function getPathfinder(id: string, opts: Record<string, unknown>): AStarFinder {
  if (opts.maxOps === undefined) opts.maxOps = 2000;
  if (opts.heuristicWeight === undefined) opts.heuristicWeight = 1;
  const key = `${jsTemplate(opts.maxOps)},${jsTemplate(opts.heuristicWeight)}`;
  const store = storeOf(id);
  let finder = store.pfFinders[key];
  if (!finder) {
    finder = new AStarFinder({
      maxOpsLimit: opts.maxOps,
      heuristic: chebyshev,
      weight: opts.heuristicWeight,
    });
    store.pfFinders[key] = finder;
  }
  return finder;
}

/** Upstream `rows[y][x]` with raw player coordinates (ToPropertyKey; non-index keys land outside the grid). */
function rowsGet(rows: number[][], x: unknown, y: unknown): unknown {
  return readProp(readProp(rows, y), x);
}

/** Upstream sloppy `rows[y][x] = value`; only integer keys below 50 ever reach the Grid matrix. */
function rowsSet(rows: number[][], x: unknown, y: unknown, value: unknown): void {
  writeProp(readProp(rows, y), x, value);
}

function makePathfindingGrid(
  id: string,
  opts: Record<string, unknown>,
  endNodesKey: unknown,
): Grid {
  const { runtimeData, register } = scope();
  const rows: number[][] = new Array<number[]>(50);
  let obstacleTypes: string[] = [...C.OBSTACLE_OBJECT_TYPES];

  if (opts.ignoreDestructibleStructures) {
    obstacleTypes = obstacleTypes.filter((i) => !DESTRUCTIBLE_TYPES.includes(i));
  }
  if (opts.ignoreCreeps) {
    obstacleTypes = obstacleTypes.filter((i) => i !== 'creep' && i !== 'powerCreep');
  }

  for (let y = 0; y < 50; y++) {
    const row: number[] = new Array<number>(50);
    for (let x = 0; x < 50; x++) {
      row[x] = x == 0 || y == 0 || x == 49 || y == 49 ? 11 : 2;
      const terrainCode = terrainAt(staticTerrain(id), x, y);
      if (maskBits(terrainCode, C.TERRAIN_MASK_WALL)) {
        row[x] = 0;
      }
      if (maskBits(terrainCode, C.TERRAIN_MASK_SWAMP) && row[x] == 2) {
        row[x] = 10;
      }
    }
    rows[y] = row;
  }

  const keys = register.objectsByRoomKeys[id];
  const objects = register.objectsByRoom[id];
  if (!keys || !objects) {
    throw new TypeError("Cannot read properties of undefined (reading 'forEach')");
  }
  for (const key of keys) {
    const object = objects[key];
    if (!object) {
      throw new TypeError("Cannot read properties of undefined (reading 'type')");
    }
    if (
      contains(obstacleTypes, object.type) ||
      (!opts.ignoreDestructibleStructures &&
        object.type == 'rampart' &&
        !object.isPublic &&
        object.user != runtimeData.user._id) ||
      (!opts.ignoreDestructibleStructures &&
        object.type == 'constructionSite' &&
        object.user == runtimeData.user._id &&
        contains(C.OBSTACLE_OBJECT_TYPES, object.structureType))
    ) {
      rowsSet(rows, object.x, object.y, 0);
    }
    if (object.type == 'road' && jsGt(rowsGet(rows, object.x, object.y), 0)) {
      rowsSet(rows, object.x, object.y, 1);
    }
  }

  for (const [option, blocked] of [
    ['ignore', false],
    ['avoid', true],
  ] as const) {
    const list = opts[option];
    if (!list) {
      continue;
    }
    if (!isArray(list)) {
      throw new Error(`option \`${option}\` is not an array`);
    }
    list.forEach((i: unknown, key: number) => {
      if (!i) {
        return;
      }
      const pos = readProp(i, 'pos');
      if (pos) {
        const current = rowsGet(rows, readProp(pos, 'x'), readProp(pos, 'y'));
        rowsSet(
          rows,
          readProp(pos, 'x'),
          readProp(pos, 'y'),
          blocked ? 0 : jsGt(current, 2) ? 2 : current,
        );
      }
      if (isObject(i) && !isUndefined(readProp(i, 'x')) && !(i instanceof RoomPosition)) {
        list[key] = new RoomPosition(readProp(i, 'x'), readProp(i, 'y'), id);
      }
      if (!isUndefined(readProp(i, 'x'))) {
        const current = rowsGet(rows, readProp(i, 'x'), readProp(i, 'y'));
        rowsSet(
          rows,
          readProp(i, 'x'),
          readProp(i, 'y'),
          blocked ? 0 : jsGt(current, 2) ? 2 : current,
        );
      }
    });
  }

  if (endNodesKey) {
    for (const i of collectionValues(readProp(storeOf(id).pfEndNodes, endNodesKey))) {
      if (!isUndefined(readProp(i, 'x'))) {
        rowsSet(rows, readProp(i, 'x'), readProp(i, 'y'), 999);
      } else if (!isUndefined(readProp(i, 'pos'))) {
        const pos = readProp(i, 'pos');
        rowsSet(rows, readProp(pos, 'x'), readProp(pos, 'y'), 999);
      }
    }
  }

  return new Grid(50, 50, rows);
}

function getPathfindingGrid(
  id: string,
  opts: Record<string, unknown>,
  endNodesKey?: unknown,
): Grid {
  const store = storeOf(id);
  let gridName = 'grid';

  if (opts.ignoreCreeps) {
    gridName += '_ignoreCreeps';
  }
  if (opts.ignoreDestructibleStructures) {
    gridName += '_ignoreDestructibleStructures';
  }
  if (isNumber(endNodesKey)) {
    gridName += '_endNodes' + jsConcat(endNodesKey);
  }
  if (opts.avoid) {
    gridName += '_avoid' + String(store.positionsSetCache.key(opts.avoid));
  }
  if (opts.ignore) {
    gridName += '_ignore' + String(store.positionsSetCache.key(opts.ignore));
  }

  let grid = store.pfGrid[gridName];
  if (!grid) {
    grid = makePathfindingGrid(id, opts, endNodesKey);
    store.pfGrid[gridName] = grid;
  }
  return grid.clone();
}

function makePathfindingGrid2(id: string, opts: Record<string, unknown>): CostMatrix {
  const { runtimeData, register } = scope();
  const costs = new CostMatrix();
  const controller = register.rooms[id]?.controller;
  const safeModeMine = !!(controller && controller.safeMode && controller.my);

  let obstacleTypes: string[] = [...C.OBSTACLE_OBJECT_TYPES];
  obstacleTypes.push('portal');

  if (opts.ignoreDestructibleStructures) {
    obstacleTypes = obstacleTypes.filter((i) => !DESTRUCTIBLE_TYPES.includes(i));
  }
  if (opts.ignoreCreeps || safeModeMine) {
    obstacleTypes = obstacleTypes.filter((i) => i !== 'creep' && i !== 'powerCreep');
  }

  const keys = register.objectsByRoomKeys[id];
  if (keys) {
    const objects = register.objectsByRoom[id] ?? {};
    for (const key of keys) {
      const object = objects[key];
      if (!object) {
        throw new TypeError("Cannot read properties of undefined (reading 'type')");
      }
      if (
        contains(obstacleTypes, object.type) ||
        (!opts.ignoreCreeps &&
          safeModeMine &&
          (object.type == 'creep' || object.type == 'powerCreep') &&
          object.user == runtimeData.user._id) ||
        (!opts.ignoreDestructibleStructures &&
          object.type == 'rampart' &&
          !object.isPublic &&
          object.user != runtimeData.user._id) ||
        (!opts.ignoreDestructibleStructures &&
          object.type == 'constructionSite' &&
          object.user == runtimeData.user._id &&
          contains(C.OBSTACLE_OBJECT_TYPES, object.structureType))
      ) {
        costs.set(object.x, object.y, 0xff);
      }

      if (object.type == 'swamp' && costs.get(object.x, object.y) == 0) {
        costs.set(object.x, object.y, opts.ignoreRoads ? 5 : 10);
      }

      if (
        !opts.ignoreRoads &&
        object.type == 'road' &&
        (costs.get(object.x, object.y) ?? NaN) < 0xff
      ) {
        costs.set(object.x, object.y, 1);
      }
    }
  }

  return costs;
}

function getPathfindingGrid2(id: string, opts: Record<string, unknown>): CostMatrix {
  const store = privateStore[id];
  if (!store) {
    return new CostMatrix();
  }

  let gridName = 'grid2';
  if (opts.ignoreCreeps) {
    gridName += '_ignoreCreeps';
  }
  if (opts.ignoreDestructibleStructures) {
    gridName += '_ignoreDestructibleStructures';
  }
  if (opts.ignoreRoads) {
    gridName += '_ignoreRoads';
  }

  let grid = store.pfGrid2[gridName];
  if (!grid) {
    grid = makePathfindingGrid2(id, opts);
    store.pfGrid2[gridName] = grid;
  }
  return grid;
}

/** Room cost matrix passed through the player's `costCallback` (called as `opts.costCallback`). */
function roomCostMatrix(roomName: string, opts: Record<string, unknown>): CostMatrix {
  let costMatrix = getPathfindingGrid2(roomName, opts);
  const costCallback = opts.costCallback;
  if (typeof costCallback == 'function') {
    costMatrix = costMatrix.clone();
    const resultMatrix: unknown = Reflect.apply(costCallback, opts, [roomName, costMatrix]);
    if (resultMatrix instanceof CostMatrix) {
      costMatrix = resultMatrix;
    }
  }
  return costMatrix;
}

function emptyPath(opts: unknown): string | RoomPathStep[] {
  return readProp(opts, 'serialize') ? '' : [];
}

function finishPath(
  resultPath: RoomPathStep[],
  opts: Record<string, unknown>,
): string | RoomPathStep[] {
  return opts.serialize ? serializePath(resultPath) : resultPath;
}

function findPath2(
  id: string,
  fromPos: unknown,
  toPos: unknown,
  optsArg: unknown,
): string | RoomPathStep[] {
  const { register } = scope();
  const opts = toOptions(optsArg);

  if (callMethod(fromPos, 'isEqualTo', [toPos], 'fromPos.isEqualTo')) {
    return opts.serialize ? '' : [];
  }

  if (opts.avoid) {
    register.deprecated(
      '`avoid` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.',
    );
    opts.avoid = undefined;
  }
  if (opts.ignore) {
    register.deprecated(
      '`ignore` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.',
    );
    opts.ignore = undefined;
  }
  if (
    opts.maxOps === undefined &&
    (opts.maxRooms === undefined || jsGt(opts.maxRooms, 1)) &&
    readProp(fromPos, 'roomName') != readProp(toPos, 'roomName')
  ) {
    opts.maxOps = 20000;
  }
  const searchOpts: Record<string, unknown> = {
    roomCallback: (roomName: string) => roomCostMatrix(roomName, opts),
    maxOps: opts.maxOps,
    maxRooms: opts.maxRooms,
  };
  if (!opts.ignoreRoads) {
    searchOpts.plainCost = 2;
    searchOpts.swampCost = 10;
  }
  if (opts.plainCost) {
    searchOpts.plainCost = opts.plainCost;
  }
  if (opts.swampCost) {
    searchOpts.swampCost = opts.swampCost;
  }

  const range = Math.max(1, toNumber(opts.range || 0));
  const ret = PathFinder.search(fromPos, { range, pos: toPos }, searchOpts);
  const path: unknown[] = ret.path;
  const last = ret.path[ret.path.length - 1];

  if (
    !opts.range &&
    ((last && last.isNearTo(toPos) && !last.isEqualTo(toPos)) ||
      (!ret.path.length && callMethod(fromPos, 'isNearTo', [toPos], 'fromPos.isNearTo')))
  ) {
    path.push(toPos);
  }
  let curX: unknown = readProp(fromPos, 'x');
  let curY: unknown = readProp(fromPos, 'y');

  const resultPath: RoomPathStep[] = [];

  for (const pos of path) {
    if (readProp(pos, 'roomName') != id) {
      break;
    }
    const result: RoomPathStep = {
      x: readProp(pos, 'x'),
      y: readProp(pos, 'y'),
      dx: jsSub(readProp(pos, 'x'), curX),
      dy: jsSub(readProp(pos, 'y'), curY),
      direction: pathDirection(jsSub(readProp(pos, 'x'), curX), jsSub(readProp(pos, 'y'), curY)),
    };
    curX = result.x;
    curY = result.y;
    resultPath.push(result);
  }

  return finishPath(resultPath, opts);
}

export function findClosestByPath2(
  fromPos: RoomPosition,
  objectsArg: unknown,
  opts: Record<string, unknown>,
): unknown {
  const { register } = scope();
  let objects: unknown = objectsArg;

  if (isNumber(objectsArg)) {
    const room = register.rooms[fromPos.roomName];
    if (!room) {
      throw new TypeError(`Cannot read properties of undefined (reading 'find')`);
    }
    objects = room.find(objectsArg, { filter: opts.filter });
  } else if (opts.filter) {
    objects = lodashFilter(objectsArg, opts.filter);
  }

  if (!readProp(objects, 'length')) {
    return null;
  }
  const list = collectionValues(objects);

  const objectOnSquare = list.find((obj) => fromPos.isEqualTo(obj));
  if (objectOnSquare) {
    return objectOnSquare;
  }

  const goals = list.map((i) => {
    const pos = readProp(i, 'pos');
    return { range: 1, pos: pos ? pos : i };
  });

  if (opts.avoid) {
    register.deprecated(
      '`avoid` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.',
    );
  }
  if (opts.ignore) {
    register.deprecated(
      '`ignore` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.',
    );
  }
  const searchOpts: Record<string, unknown> = {
    roomCallback: (roomName: string) =>
      register.objectsByRoom[roomName] ? roomCostMatrix(roomName, opts) : undefined,
    maxOps: opts.maxOps,
    maxRooms: 1,
  };
  if (!opts.ignoreRoads) {
    searchOpts.plainCost = 2;
    searchOpts.swampCost = 10;
  }
  const ret = PathFinder.search(fromPos, goals, searchOpts);

  let result: unknown = null;
  const lastPos = ret.path[ret.path.length - 1] ?? fromPos;

  if (!Array.isArray(objects)) {
    throw new TypeError('objects.forEach is not a function');
  }
  for (const obj of list) {
    if (lastPos.isNearTo(obj)) {
      result = obj;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// Look helpers
// ---------------------------------------------------------------------------------------------

type LookItem = Record<PropertyKey, unknown>;

/** Upstream `_lookSpatialRegister` with raw player `typeName`/coordinates. */
function lookSpatialRegister(
  id: string,
  typeName: unknown,
  x: unknown,
  y: unknown,
  outArray?: unknown,
  withCoords?: boolean,
): unknown {
  if (typeName == 'terrain') {
    let result = 'plain';
    const terrainCode = terrainAt(staticTerrain(id), x, y);
    if (maskBits(terrainCode, C.TERRAIN_MASK_SWAMP)) {
      result = 'swamp';
    }
    if (maskBits(terrainCode, C.TERRAIN_MASK_WALL)) {
      result = 'wall';
    }
    if (outArray) {
      const item: LookItem = { type: 'terrain', terrain: result };
      if (withCoords) {
        item.x = x;
        item.y = y;
      }
      callMethod(outArray, 'push', [item]);
      return undefined;
    }
    return [result];
  }

  if (jsLt(x, 0) || jsLt(y, 0) || jsGt(x, 49) || jsGt(y, 49)) {
    throw new Error('look coords are out of bounds');
  }

  const typeResult = readProp(
    readProp(storeOf(id).lookTypeSpatialRegisters, typeName),
    jsAdd(jsMul(x, 50), y),
  );
  if (typeResult) {
    if (outArray) {
      callMethod(typeResult, 'forEach', [
        (i: unknown): void => {
          const item: LookItem = { type: typeName };
          writeProp(item, typeName, i);
          if (withCoords) {
            item.x = x;
            item.y = y;
          }
          callMethod(outArray, 'push', [item]);
        },
      ]);
      return undefined;
    }
    return clone(typeResult);
  }
  return [];
}

/** Upstream `_lookAreaMixedRegister` with raw player type and bounds. */
function lookAreaMixedRegister(
  id: string,
  type: unknown,
  top: unknown,
  left: unknown,
  bottom: unknown,
  right: unknown,
  withType: boolean,
  asArray: unknown,
  result: unknown,
): void {
  const typeRegister = readProp(storeOf(id).lookTypeRegisters, type);
  const keys = typeRegister ? Object.keys(typeRegister) : typeRegister;

  if (
    type != 'terrain' &&
    jsLt(
      readProp(keys, 'length'),
      jsMul(jsAdd(jsSub(bottom, top), 1), jsAdd(jsSub(right, left), 1)),
    )
  ) {
    // by objects
    const checkInside = (i: unknown): boolean => {
      const pos = readProp(i, 'pos');
      return !!(
        (((!pos && readProp(i, 'roomName') == id) || (pos && readProp(pos, 'roomName') == id)) &&
          pos &&
          jsGe(readProp(pos, 'y'), top) &&
          jsLe(readProp(pos, 'y'), bottom) &&
          jsGe(readProp(pos, 'x'), left) &&
          jsLe(readProp(pos, 'x'), right)) ||
        (!pos &&
          jsGe(readProp(i, 'y'), top) &&
          jsLe(readProp(i, 'y'), bottom) &&
          jsGe(readProp(i, 'x'), left) &&
          jsLe(readProp(i, 'x'), right))
      );
    };
    // `keys.length` was read above, so the register exists and `keys` is its own-key list.
    for (const key of Array.isArray(keys) ? keys : []) {
      const obj = readProp(typeRegister, key);
      if (!checkInside(obj)) {
        continue;
      }
      const objX = (): unknown => readProp(obj, 'x') || readProp(readProp(obj, 'pos'), 'x');
      const objY = (): unknown => readProp(obj, 'y') || readProp(readProp(obj, 'pos'), 'y');
      if (withType) {
        const item: LookItem = { type };
        writeProp(item, type, obj);
        if (asArray) {
          const entry: LookItem = { x: objX(), y: objY(), type };
          writeProp(entry, type, obj);
          callMethod(result, 'push', [entry]);
        } else {
          callMethod(readProp(readProp(result, objY()), objX()), 'push', [item]);
        }
      } else if (asArray) {
        const entry: LookItem = { x: objX(), y: objY() };
        writeProp(entry, type, obj);
        callMethod(result, 'push', [entry]);
      } else {
        writeProp(
          readProp(result, objY()),
          objX(),
          readProp(readProp(result, objY()), objX()) || [],
        );
        callMethod(readProp(readProp(result, objY()), objX()), 'push', [obj]);
      }
    }
  } else {
    // spatial
    for (let y: unknown = top; jsLe(y, bottom); y = jsInc(y)) {
      for (let x: unknown = left; jsLe(x, right); x = jsInc(x)) {
        if (asArray) {
          lookSpatialRegister(id, type, x, y, result, true);
        } else if (readProp(readProp(result, y), x)) {
          lookSpatialRegister(id, type, x, y, readProp(readProp(result, y), x));
        } else {
          writeProp(readProp(result, y), x, lookSpatialRegister(id, type, x, y, undefined));
        }
      }
    }
  }
}

/** Look constants of the server-mod custom object prototypes (upstream `customObjectPrototypes` loops). */
function customLookConstants(): string[] {
  const constants: string[] = [];
  for (const i of scope().runtimeData.customObjectPrototypes) {
    if (i.opts.lookConstant) {
      constants.push(i.opts.lookConstant);
    }
  }
  return constants;
}

const LOOK_TYPES = [
  C.LOOK_CREEPS,
  C.LOOK_ENERGY,
  C.LOOK_RESOURCES,
  C.LOOK_SOURCES,
  C.LOOK_MINERALS,
  C.LOOK_DEPOSITS,
  C.LOOK_STRUCTURES,
  C.LOOK_FLAGS,
  C.LOOK_CONSTRUCTION_SITES,
  C.LOOK_TERRAIN,
  C.LOOK_NUKES,
  C.LOOK_TOMBSTONES,
  C.LOOK_RUINS,
  C.LOOK_POWER_CREEPS,
] as const;

// ---------------------------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------------------------

class RoomImpl {
  declare readonly name: string;
  declare energyAvailable: number;
  declare energyCapacityAvailable: number;
  declare survivalInfo: unknown;
  declare visual: RoomVisual;
  declare controller: StructureController | undefined;
  declare storage: StructureStorage | undefined;
  declare terminal: StructureTerminal | undefined;

  static serializePath(path: unknown): string {
    return serializePath(path);
  }

  static deserializePath(str: unknown): PathStep[] {
    return deserializePath(str);
  }

  toString(): string {
    return `[room ${jsTemplate(this.name)}]`;
  }

  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const i in this) {
      if (
        i.startsWith('_') ||
        ['toJSON', 'toString', 'controller', 'storage', 'terminal'].includes(i)
      ) {
        continue;
      }
      result[i] = this[i];
    }
    return result;
  }

  get memory(): unknown {
    const Memory = memoryRoot();
    if (isUndefined(Memory.rooms) || Memory.rooms === 'undefined') {
      Memory.rooms = {};
    }
    const rooms = Memory.rooms;
    if (!isObject(rooms)) {
      return undefined;
    }
    const value: unknown = readProp(rooms, this.name) || {};
    writeProp(rooms, this.name, value);
    return value;
  }

  set memory(value: unknown) {
    const Memory = memoryRoot();
    if (isUndefined(Memory.rooms) || Memory.rooms === 'undefined') {
      Memory.rooms = {};
    }
    const rooms = Memory.rooms;
    if (!isObject(rooms)) {
      throw new Error('Could not set room memory');
    }
    writeProp(rooms, this.name, value);
  }

  getEventLog(raw?: unknown): string | EventLogEntry[] {
    const { runtimeData, register } = scope();
    if (raw) {
      return runtimeData.roomEventLog[this.name] || '[]';
    }
    const { roomEventLogCache } = register;
    let cached = roomEventLogCache[this.name];
    if (!cached) {
      cached = JSON.parse(runtimeData.roomEventLog[this.name] || '[]') as EventLogEntry[];
      roomEventLogCache[this.name] = cached;
    }
    return cached;
  }

  find(type: unknown, opts?: unknown): (RoomObject | RoomPosition)[] {
    const { register } = scope();
    let result: (RoomObject | RoomPosition)[] = [];
    const options = toOptions(opts);
    const typeCache = readProp(register.findCache, type);
    const cached = typeCache && readProp(typeCache, this.name);
    if (cached) {
      // findCache entries are only ever the RoomObject/RoomPosition arrays stored by game.ts and this method.
      result = cached as (RoomObject | RoomPosition)[];
    } else {
      switch (type) {
        case C.FIND_EXIT: {
          const existing: Record<string, (RoomObject | RoomPosition)[]> | undefined =
            register.findCache[type];
          const cache = existing ?? {};
          register.findCache[type] = cache;
          const exits = this.find(C.FIND_EXIT_TOP, options)
            .concat(this.find(C.FIND_EXIT_BOTTOM, options))
            .concat(this.find(C.FIND_EXIT_RIGHT, options))
            .concat(this.find(C.FIND_EXIT_LEFT, options));
          cache[this.name] = exits;
          return [...exits];
        }
        case C.FIND_EXIT_TOP:
        case C.FIND_EXIT_RIGHT:
        case C.FIND_EXIT_BOTTOM:
        case C.FIND_EXIT_LEFT: {
          const existing: Record<string, (RoomObject | RoomPosition)[]> | undefined =
            register.findCache[type];
          const cache = existing ?? {};
          register.findCache[type] = cache;
          const positions: RoomPosition[] = [];
          for (let i = 0; i < 50; i++) {
            let x = 0;
            let y = 0;
            if (type == C.FIND_EXIT_LEFT || type == C.FIND_EXIT_RIGHT) {
              y = i;
            } else {
              x = i;
            }
            if (type == C.FIND_EXIT_RIGHT) {
              x = 49;
            }
            if (type == C.FIND_EXIT_BOTTOM) {
              y = 49;
            }
            if (maskBits(terrainAt(staticTerrain(this.name), x, y), C.TERRAIN_MASK_WALL)) {
              continue;
            }
            const pos =
              type == C.FIND_EXIT_TOP
                ? this.getPositionAt(i, 0)
                : type == C.FIND_EXIT_BOTTOM
                  ? this.getPositionAt(i, 49)
                  : type == C.FIND_EXIT_LEFT
                    ? this.getPositionAt(0, i)
                    : this.getPositionAt(49, i);
            if (pos) {
              positions.push(pos);
            }
          }
          result = positions;
          cache[this.name] = result;
          break;
        }
      }
    }

    if (options.filter) {
      return lodashFilter(result, options.filter);
    }
    return [...result];
  }

  lookAt(firstArg: unknown, secondArg?: unknown): unknown[] {
    const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    const result: LookItem[] = [];
    for (const type of LOOK_TYPES) {
      lookSpatialRegister(this.name, type, x, y, result);
    }
    for (const lookConstant of customLookConstants()) {
      lookSpatialRegister(this.name, lookConstant, x, y, result);
    }
    return result;
  }

  lookForAt(type: unknown, firstArg: unknown, secondArg?: unknown): unknown {
    const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);

    // Native `in` (ToPropertyKey, inherited keys) on the raw player value.
    if (
      type != 'terrain' &&
      !((type as PropertyKey) in storeOf(this.name).lookTypeSpatialRegisters)
    ) {
      return C.ERR_INVALID_ARGS;
    }

    return lookSpatialRegister(this.name, type, x, y);
  }

  lookAtArea(
    top: unknown,
    left: unknown,
    bottom: unknown,
    right: unknown,
    asArray?: unknown,
  ): unknown {
    const result: unknown = asArray ? [] : {};

    if (!asArray) {
      for (let y: unknown = top; jsLe(y, bottom); y = jsInc(y)) {
        writeProp(result, y, {});
        for (let x: unknown = left; jsLe(x, right); x = jsInc(x)) {
          writeProp(readProp(result, y), x, []);
        }
      }
    }

    for (const type of LOOK_TYPES) {
      lookAreaMixedRegister(this.name, type, top, left, bottom, right, true, asArray, result);
    }
    for (const lookConstant of customLookConstants()) {
      lookAreaMixedRegister(
        this.name,
        lookConstant,
        top,
        left,
        bottom,
        right,
        true,
        asArray,
        result,
      );
    }

    return result;
  }

  lookForAtArea(
    type: unknown,
    top: unknown,
    left: unknown,
    bottom: unknown,
    right: unknown,
    asArray?: unknown,
  ): unknown {
    const result: unknown = asArray ? [] : {};

    if (!asArray) {
      for (let y: unknown = top; jsLe(y, bottom); y = jsInc(y)) {
        writeProp(result, y, {});
      }
    }

    lookAreaMixedRegister(this.name, type, top, left, bottom, right, false, asArray, result);

    return result;
  }

  findPath(fromPos: unknown, toPos: unknown, opts?: unknown): string | RoomPathStep[] {
    const { register } = scope();

    if (readProp(fromPos, 'roomName') != this.name) {
      return emptyPath(opts);
    }

    if (register._useNewPathFinder) {
      return findPath2(this.name, fromPos, toPos, opts);
    }

    const fromX = readProp(fromPos, 'x');
    const fromY = readProp(fromPos, 'y');
    const store = storeOf(this.name);
    let path: unknown[][];
    let cacheKeySuffix = '';

    const options = toOptions(clone(opts || {}));

    if (options.ignoreCreeps) {
      cacheKeySuffix += '_ignoreCreeps';
    }
    if (options.ignoreDestructibleStructures) {
      cacheKeySuffix += '_ignoreDestructibleStructures';
    }
    if (options.avoid) {
      cacheKeySuffix += '_avoid' + String(store.positionsSetCache.key(options.avoid));
    }
    if (options.ignore) {
      cacheKeySuffix += '_ignore' + String(store.positionsSetCache.key(options.ignore));
    }

    if (isNumber(toPos)) {
      if (!readProp(store.pfEndNodes, toPos)) {
        return emptyPath(options);
      }

      const grid = getPathfindingGrid(this.name, options, toPos);

      path = store.pfDijkstraFinder.findPath(fromX, fromY, -999, -999, grid);
    } else {
      if (readProp(toPos, 'roomName') != this.name) {
        return emptyPath(options);
      }

      const toX = readProp(toPos, 'x');
      const toY = readProp(toPos, 'y');
      const cacheKey = `${jsTemplate(fromX)},${jsTemplate(fromY)},${jsTemplate(toX)},${jsTemplate(toY)}${cacheKeySuffix}`;

      const cachedPath = store.pathCache[cacheKey];
      if (cachedPath) {
        return options.serialize ? serializePath(cachedPath) : cloneDeep(cachedPath);
      }

      if (fromX == toX && fromY == toY) {
        return emptyPath(options);
      }
      if (
        jsLt(fromX, 0) ||
        jsLt(fromY, 0) ||
        jsLt(toX, 0) ||
        jsLt(toY, 0) ||
        jsGe(fromX, 50) ||
        jsGe(fromY, 50) ||
        jsGe(toX, 50) ||
        jsGe(toY, 50)
      ) {
        return emptyPath(options);
      }

      if (Math.abs(toNumber(jsSub(fromX, toX))) < 2 && Math.abs(toNumber(jsSub(fromY, toY))) < 2) {
        const result: RoomPathStep[] = [
          {
            x: toX,
            y: toY,
            dx: jsSub(toX, fromX),
            dy: jsSub(toY, fromY),
            direction: pathDirection(jsSub(toX, fromX), jsSub(toY, fromY)),
          },
        ];
        return finishPath(result, options);
      }

      const grid = getPathfindingGrid(this.name, options);
      const finder = getPathfinder(this.name, options);

      grid.setWalkableAt(toX, toY);
      path = finder.findPath(fromX, fromY, toX, toY, grid);
    }

    path.splice(0, 1);

    let curX: unknown = fromX;
    let curY: unknown = fromY;

    const resultPath = path.map((step): RoomPathStep => {
      const result: RoomPathStep = {
        x: step[0],
        y: step[1],
        dx: jsSub(step[0], curX),
        dy: jsSub(step[1], curY),
        direction: pathDirection(jsSub(step[0], curX), jsSub(step[1], curY)),
      };
      curX = result.x;
      curY = result.y;
      return result;
    });

    const lastStep = resultPath[resultPath.length - 1];
    if (lastStep) {
      store.pathCache[
        `${jsTemplate(fromX)},${jsTemplate(fromY)},${jsTemplate(lastStep.x)},${jsTemplate(lastStep.y)}${cacheKeySuffix}`
      ] = cloneDeep(resultPath);
    }

    return finishPath(resultPath, options);
  }

  getPositionAt(x: unknown, y: unknown): RoomPosition | null {
    if (outOfRoom(x, y)) {
      return null;
    }
    return new RoomPosition(x, y, this.name);
  }

  createFlag(
    firstArg: unknown,
    secondArg?: unknown,
    nameArg?: unknown,
    colorArg?: unknown,
    secondaryColorArg?: unknown,
  ): unknown {
    const { register, intents, globals } = scope();
    const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    let name = nameArg;
    let color = colorArg;
    let secondaryColor = secondaryColorArg;

    if (isUndefined(x) || isUndefined(y) || outOfRoom(x, y)) {
      return C.ERR_INVALID_ARGS;
    }
    if (size(globals.Game.flags) >= C.FLAGS_LIMIT) {
      return C.ERR_FULL;
    }
    if (isObject(firstArg)) {
      secondaryColor = color;
      color = name;
      name = secondArg;
    }
    if (!color) {
      color = C.COLOR_WHITE;
    }
    if (!secondaryColor) {
      secondaryColor = color;
    }
    if (!contains(C.COLORS_ALL, color)) {
      return C.ERR_INVALID_ARGS;
    }
    if (!contains(C.COLORS_ALL, secondaryColor)) {
      return C.ERR_INVALID_ARGS;
    }
    if (!name) {
      let cnt = 1;
      do {
        name = 'Flag' + String(cnt);
        cnt++;
      } while (lodashSome(register.flags, { name }) || createdFlagNames.indexOf(name) != -1);
    }
    if (lodashSome(register.flags, { name }) || createdFlagNames.indexOf(name) != -1) {
      return C.ERR_NAME_EXISTS;
    }
    if (jsGt(readProp(name, 'length'), 100)) {
      return C.ERR_INVALID_ARGS;
    }

    createdFlagNames.push(name);

    const roomName = jsConcat(this.name);
    const FlagCtor = globals.Flag;
    if (typeof FlagCtor !== 'function') {
      throw new TypeError('globals.Flag is not a constructor');
    }
    // `globals.Flag` is the Flag class exposed by flags.ts (not imported to avoid an evaluation cycle).
    const flag = Reflect.construct(FlagCtor, [name, color, secondaryColor, roomName, x, y]) as Flag;
    writeProp(globals.Game.flags, name, flag);

    intents.pushByName('room', 'createFlag', { roomName, x, y, name, color, secondaryColor });

    return name;
  }

  createConstructionSite(
    firstArg: unknown,
    secondArg?: unknown,
    structureTypeArg?: unknown,
    nameArg?: unknown,
  ): number {
    const { register, intents, runtimeData } = scope();
    const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    let structureType = structureTypeArg;
    const name = nameArg;

    if (isUndefined(x) || isUndefined(y) || outOfRoom(x, y)) {
      return C.ERR_INVALID_ARGS;
    }
    if (isString(secondArg) && isUndefined(structureType)) {
      structureType = secondArg;
    }
    if (!readProp(C.CONSTRUCTION_COST, structureType)) {
      return C.ERR_INVALID_ARGS;
    }
    if (structureType == 'spawn' && typeof name == 'string') {
      if (name.length > 100) {
        return C.ERR_INVALID_ARGS;
      }
      if (createdSpawnNames.indexOf(name) != -1) {
        return C.ERR_INVALID_ARGS;
      }
      if (
        lodashSome(register.spawns, { name }) ||
        lodashSome(register.constructionSites, { structureType: 'spawn', name })
      ) {
        return C.ERR_INVALID_ARGS;
      }
    }
    const controller = this.controller;
    if (controller && (controller.level ?? 0) > 0 && !controller.my) {
      return C.ERR_NOT_OWNER;
    }
    const roomObjects = register.objectsByRoom[this.name];
    const rawController = controller && roomObjects ? roomObjects[controller.id] : undefined;
    if (
      controller &&
      controller.reservation &&
      rawController &&
      readProp(rawController.reservation, 'user') != runtimeData.user._id
    ) {
      return C.ERR_NOT_OWNER;
    }
    const roomName = jsConcat(this.name);
    const controllerInfo = controller
      ? {
          x: controller.pos.x,
          y: controller.pos.y,
          level: controller.level,
          owner: controller.owner,
        }
      : controller;
    if (!checkControllerAvailability(structureType, roomObjects, controllerInfo)) {
      return C.ERR_RCL_NOT_ENOUGH;
    }
    if (
      !checkConstructionSite(register.objectsByRoom[roomName], structureType, x, y) ||
      !checkConstructionSite(runtimeData.staticTerrainData[roomName], structureType, x, y)
    ) {
      return C.ERR_INVALID_TARGET;
    }

    const sitesCount = Object.values(runtimeData.userObjects).filter(
      (i) => i.type === 'constructionSite',
    ).length;
    if (sitesCount + createdConstructionSites >= C.MAX_CONSTRUCTION_SITES) {
      return C.ERR_FULL;
    }

    const intent: Record<string, unknown> = { roomName, x, y, structureType };

    if (structureType == 'spawn') {
      let spawnName: string;
      if (typeof name !== 'string') {
        let cnt = 1;
        do {
          spawnName = 'Spawn' + String(cnt);
          cnt++;
        } while (
          lodashSome(register.spawns, { name: spawnName }) ||
          lodashSome(register.constructionSites, { structureType: 'spawn', name: spawnName }) ||
          createdSpawnNames.indexOf(spawnName) != -1
        );
      } else {
        spawnName = name;
      }
      createdSpawnNames.push(spawnName);
      intent.name = spawnName;
    }

    createdConstructionSites++;

    intents.pushByName('room', 'createConstructionSite', intent);

    return C.OK;
  }

  getEndNodes(typeArg: unknown, opts?: unknown): { key: number; objects: unknown } {
    let type = typeArg;
    let key: number;
    const options = toOptions(opts);
    const store = storeOf(this.name);

    if (isUndefined(type)) {
      throw new Error('Find type cannot be undefined');
    }

    if (!options.filter && isNumber(type)) {
      key = type;
    } else {
      if (isNumber(type)) {
        type = this.find(type, options);
      }

      key = store.positionsSetCache.key(type);

      store.pfEndNodes[String(key)] = store.positionsSetCache.cache[String(key)];
    }

    if (!store.pfEndNodes[String(key)]) {
      store.pfEndNodes[String(key)] = isNumber(type) ? this.find(type, options) : clone(type);
    }
    return { key, objects: store.pfEndNodes[String(key)] };
  }

  findExitTo(room: unknown): unknown {
    return scope().register.map.findExit(this.name, room);
  }

  getTerrain(): unknown {
    // Upstream `new Room.Terrain(this.name)`: `Room.Terrain` is a writable static read at call time.
    const Terrain = readProp(Room, 'Terrain');
    if (typeof Terrain !== 'function') {
      throw new TypeError('Room.Terrain is not a constructor');
    }
    const terrain: unknown = Reflect.construct(Terrain, [this.name]);
    return terrain;
  }
}

export type Room = RoomImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Room: GameConstructor<Room, [id?: unknown]> = gameConstructor(
  RoomImpl,
  function (this: Room, id?: unknown): void {
    const { register, runtimeData } = scope();
    let gameInfo: unknown;
    let gameId: unknown = id;
    const match = callMethod(id, 'match', [/survival_(.*)$/], 'id.match');
    if (match) {
      gameId = readProp(match, 1);
    }
    const games = runtimeData.games;
    if (games && toPropertyKey(gameId) in games) {
      gameInfo = readProp(games, gameId);
    }

    Object.defineProperty(this, 'name', { value: id, enumerable: true });

    this.energyAvailable = 0;
    this.energyCapacityAvailable = 0;

    this.survivalInfo = gameInfo;

    const key = toPropertyKey(id);
    const byRoom = typeof key === 'symbol' ? undefined : register.byRoom[String(key)];
    if (!byRoom) {
      throw new TypeError("Cannot read properties of undefined (reading 'creeps')");
    }

    const store: RoomPrivateStore = {
      pfGrid: {},
      pfGrid2: {},
      pfFinders: {},
      pfEndNodes: {},
      pfDijkstraFinder: new DijkstraFinder(),
      pathCache: {},
      positionsSetCache: new PositionsSetCache(id),
      lookTypeRegisters: {
        creep: byRoom.creeps,
        energy: byRoom.energy,
        resource: byRoom.energy,
        source: byRoom.sources,
        mineral: byRoom.minerals,
        deposit: byRoom.deposits,
        structure: byRoom.structures,
        flag: byRoom.flags,
        constructionSite: byRoom.constructionSites,
        tombstone: byRoom.tombstones,
        ruin: byRoom.ruins,
        nuke: byRoom.nukes,
        powerCreep: byRoom.powerCreeps,
      },
      lookTypeSpatialRegisters: {
        creep: byRoom.spatial.creeps,
        energy: byRoom.spatial.energy,
        resource: byRoom.spatial.energy,
        source: byRoom.spatial.sources,
        mineral: byRoom.spatial.minerals,
        deposit: byRoom.spatial.deposits,
        structure: byRoom.spatial.structures,
        flag: byRoom.spatial.flags,
        constructionSite: byRoom.spatial.constructionSites,
        tombstone: byRoom.spatial.tombstones,
        ruin: byRoom.spatial.ruins,
        nuke: byRoom.spatial.nukes,
        powerCreep: byRoom.spatial.powerCreeps,
      },
    };
    writeProp(privateStore, id, store);
    for (const lookConstant of customLookConstants()) {
      store.lookTypeRegisters[lookConstant] = byRoom.custom[lookConstant];
      store.lookTypeSpatialRegisters[lookConstant] = byRoom.customSpatial[lookConstant];
    }

    this.visual = new RoomVisual(id);
  },
  { name: '', length: 1, enumerableConstructor: false },
);

// Upstream `Object.defineProperty(Room.prototype, 'memory', {get, set})`: non-enumerable, non-configurable.
Object.defineProperty(Room.prototype, 'memory', { enumerable: false, configurable: false });

// ---------------------------------------------------------------------------------------------
// RoomVisual
// ---------------------------------------------------------------------------------------------

function visualRoomName(roomName: unknown): string | undefined {
  return roomName === undefined
    ? undefined
    : typeof roomName === 'string'
      ? roomName
      : jsString(roomName);
}

class RoomVisualImpl {
  declare roomName: unknown;

  circle(xArg: unknown, yArg?: unknown, styleArg?: unknown): this {
    let x = xArg;
    let y = yArg;
    let style = styleArg;
    if (typeof x == 'object') {
      style = y;
      y = readProp(x, 'y');
      x = readProp(x, 'x');
    }
    scope().globals.console.addVisual(visualRoomName(this.roomName), { t: 'c', x, y, s: style });
    return this;
  }

  line(
    x1Arg: unknown,
    y1Arg?: unknown,
    x2Arg?: unknown,
    y2Arg?: unknown,
    styleArg?: unknown,
  ): this {
    let x1 = x1Arg;
    let y1 = y1Arg;
    let x2 = x2Arg;
    let y2 = y2Arg;
    let style = styleArg;
    if (typeof x1 == 'object' && typeof y1 == 'object') {
      style = x2;
      x2 = readProp(y1, 'x');
      y2 = readProp(y1, 'y');
      y1 = readProp(x1, 'y');
      x1 = readProp(x1, 'x');
    }
    scope().globals.console.addVisual(visualRoomName(this.roomName), {
      t: 'l',
      x1,
      y1,
      x2,
      y2,
      s: style,
    });
    return this;
  }

  rect(xArg: unknown, yArg?: unknown, wArg?: unknown, hArg?: unknown, styleArg?: unknown): this {
    let x = xArg;
    let y = yArg;
    let w = wArg;
    let h = hArg;
    let style = styleArg;
    if (typeof x == 'object') {
      style = h;
      h = w;
      w = y;
      y = readProp(x, 'y');
      x = readProp(x, 'x');
    }
    scope().globals.console.addVisual(visualRoomName(this.roomName), {
      t: 'r',
      x,
      y,
      w,
      h,
      s: style,
    });
    return this;
  }

  poly(pointsArg: unknown, style?: unknown): this {
    if (isArray(pointsArg) && pointsArg.some(Boolean)) {
      const points = pointsArg.map((i: unknown) =>
        readProp(i, 'x') !== undefined ? [readProp(i, 'x'), readProp(i, 'y')] : i,
      );
      scope().globals.console.addVisual(visualRoomName(this.roomName), {
        t: 'p',
        points,
        s: style,
      });
    }
    return this;
  }

  text(text: unknown, xArg?: unknown, yArg?: unknown, styleArg?: unknown): this {
    let x = xArg;
    let y = yArg;
    let style = styleArg;
    if (typeof x == 'object') {
      style = y;
      y = readProp(x, 'y');
      x = readProp(x, 'x');
    }
    scope().globals.console.addVisual(visualRoomName(this.roomName), {
      t: 't',
      text,
      x,
      y,
      s: style,
    });
    return this;
  }

  getSize(): number {
    return scope().globals.console.getVisualSize(visualRoomName(this.roomName));
  }

  clear(): this {
    scope().globals.console.clearVisual(visualRoomName(this.roomName));
    return this;
  }

  export(): string | undefined {
    return scope().globals.console.getVisual(visualRoomName(this.roomName));
  }

  import(data: unknown): this {
    scope().globals.console.addVisual(visualRoomName(this.roomName), jsConcat(data));
    return this;
  }
}

export type RoomVisual = RoomVisualImpl;

/** Upstream `register.wrapFn(function(roomName) { this.roomName = roomName; })`. */
export const RoomVisual: GameConstructor<RoomVisual, [roomName?: unknown]> = gameConstructor(
  RoomVisualImpl,
  function (this: RoomVisual, roomName?: unknown): void {
    this.roomName = roomName;
  },
  { name: '', length: 1, enumerableConstructor: false },
);

// ---------------------------------------------------------------------------------------------
// Room.Terrain
// ---------------------------------------------------------------------------------------------

class RoomTerrainImpl {
  declare get: (x: unknown, y: unknown) => number;
  declare getRawBuffer: (destinationArray?: unknown) => unknown;
}

export type RoomTerrain = RoomTerrainImpl;

/**
 * Upstream `Room.Terrain = register.wrapFn(function(roomName){ "use strict"; … })`: a strict body, so a
 * call without a receiver throws on the first `this.get =` assignment (this module is strict too).
 */
export const RoomTerrain: GameConstructor<RoomTerrain, [roomName?: unknown]> = gameConstructor(
  RoomTerrainImpl,
  function (this: RoomTerrain, roomNameArg?: unknown): void {
    const roomName = jsConcat(roomNameArg);

    const array = readProp(scope().runtimeData.staticTerrainData, roomName);
    if (!array) {
      throw new Error(`Could not access room ${roomName}`);
    }

    this.get = (x: unknown, y: unknown): number => {
      const value = terrainAt(array, x, y);
      return maskBits(value, C.TERRAIN_MASK_WALL) || maskBits(value, C.TERRAIN_MASK_SWAMP) || 0;
    };

    this.getRawBuffer = (destinationArray?: unknown): unknown => {
      if (destinationArray) {
        const call = readProp(terrainConstructorSet, 'call');
        if (typeof call !== 'function') {
          throw new TypeError('TerrainConstructorSet.call is not a function');
        }
        Reflect.apply(call, terrainConstructorSet, [destinationArray, array]);
        return destinationArray;
      }
      if (typeof terrainConstructor !== 'function') {
        throw new TypeError('TerrainConstructor is not a constructor');
      }
      const buffer: unknown = Reflect.construct(terrainConstructor, [array]);
      return buffer;
    };
  },
  { name: '', length: 1, enumerableConstructor: false, strict: true },
);

// Upstream plain assignment `Room.Terrain = …` (writable, enumerable, configurable).
Object.defineProperty(Room, 'Terrain', {
  value: RoomTerrain,
  writable: true,
  enumerable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------------------------

/** Per-tick reset (upstream `make` + `makePos`); exposes Room, RoomVisual, RoomPosition, RoomObject once. */
export function make(): void {
  positionsSetCacheCounter = 1;
  createdFlagNames = [];
  createdSpawnNames = [];
  privateStore = {};
  createdConstructionSites = 0;

  const { globals, runtimeData } = scope();
  if (!terrainConstructor) {
    // Upstream takes the constructor of the first terrain array (`for...in`, inherited keys included).
    for (const roomName in runtimeData.staticTerrainData) {
      terrainConstructor = readProp(
        readProp(runtimeData.staticTerrainData, roomName),
        'constructor',
      );
      break;
    }
  }
  if (!terrainConstructorSet) {
    terrainConstructorSet = readProp(readProp(terrainConstructor, 'prototype'), 'set');
  }
  if (!globals.Room) {
    exposeGlobal('Room', Room);
    exposeGlobal('RoomVisual', RoomVisual);
  }
  if (!globals.RoomPosition) {
    exposeGlobal('RoomPosition', RoomPosition);
    exposeGlobal('RoomObject', RoomObject);
  }
}
