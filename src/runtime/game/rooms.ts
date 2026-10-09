/*
 * Room, RoomVisual and Room.Terrain (screeps/engine `src/game/rooms.js`), including the room path
 * finding helpers backed by the shared PathFinder or the legacy grid path finder.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { clone, cloneDeep, contains, isArray, isNumber, isObject, isString, isUndefined, size } from './compat.ts';
import { exposeGlobal, finalizeClass } from './define.ts';
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
    serializePath,
} from '../../utils/index.ts';
import type { PathStep } from '../../utils/index.ts';

/** One step of a path returned by `Room.findPath` (direction is `undefined` for a zero step). */
export interface RoomPathStep {
    x: number;
    y: number;
    dx: number;
    dy: number;
    direction: number | undefined;
}

// ---------------------------------------------------------------------------------------------
// Untrusted-value helpers (JS property access and lodash 3 callback semantics)
// ---------------------------------------------------------------------------------------------

/** `obj[key]` with JS semantics: throws on `null`/`undefined`, autoboxes primitives. */
export function readProp(obj: unknown, key: string): unknown {
    if (obj === null || obj === undefined) {
        throw new TypeError(`Cannot read properties of ${String(obj)} (reading '${key}')`);
    }
    // Property access on an arbitrary player value; primitives are autoboxed by the engine.
    return (obj as Record<string, unknown>)[key];
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

/** Values of a lodash collection: array-likes by index, other objects by own enumerable keys. */
function collectionValues(collection: unknown): unknown[] {
    if (collection === null || collection === undefined) {
        return [];
    }
    if (Array.isArray(collection)) {
        return collection;
    }
    if (typeof collection === 'string') {
        return collection.split('');
    }
    if (typeof collection !== 'object' && typeof collection !== 'function') {
        return [];
    }
    const length = readProp(collection, 'length');
    if (typeof collection !== 'function' && typeof length === 'number' && length >= 0 && length % 1 == 0 && length <= Number.MAX_SAFE_INTEGER) {
        const values: unknown[] = [];
        for (let i = 0; i < length; i++) {
            values.push(readProp(collection, String(i)));
        }
        return values;
    }
    return Object.keys(collection).map((key) => readProp(collection, key));
}

function tagOf(value: unknown): string {
    return Object.prototype.toString.call(value);
}

/** lodash 3 `baseIsEqual(source, value, undefined, isLoose = true)` used by `_.matches`. */
function looseEqual(source: unknown, value: unknown): boolean {
    if (source === value) {
        return true;
    }
    if (source === null || value === null || source === undefined || value === undefined || (!isObject(source) && !isObject(value))) {
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
        return String(source) == String(value);
    }
    if (Array.isArray(source) && Array.isArray(value)) {
        if (source.length != value.length && !(value.length > source.length)) {
            return false;
        }
        return source.every((item: unknown) => value.some((other: unknown) => item === other || looseEqual(item, other)));
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
    const target: object = typeof object === 'object' || typeof object === 'function' ? object : (Object(object) as object);
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
function lodashIteratee(predicate: unknown): (value: unknown, index: number, collection: unknown) => unknown {
    if (typeof predicate === 'function') {
        return (value, index, collection) => Reflect.apply(predicate, undefined, [value, index, collection]);
    }
    if (predicate === null || predicate === undefined) {
        return (value) => value;
    }
    if (typeof predicate === 'object') {
        return (value) => isMatch(value, predicate);
    }
    const path = String(predicate);
    if (typeof predicate === 'string' && /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\n\\]|\\.)*?\1)\]/.test(path)) {
        const parts = path.replace(/\[(\d+|["']([^"']*)["'])\]/g, (_m, index: string, quoted: string | undefined) => '.' + (quoted ?? index)).split('.');
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

/** Terrain bytes of a room; missing rooms fail like upstream's unguarded index. */
export function roomTerrainData(roomName: string): Uint8Array {
    const data = scope().runtimeData.staticTerrainData[roomName];
    if (!data) {
        throw new TypeError(`Cannot read properties of undefined (reading '${roomName}')`);
    }
    return data;
}

/** Upstream `terrain[y * 50 + x]` with raw player coordinates (`+` concatenates strings). */
function terrainCodeAt(data: Uint8Array, x: unknown, y: unknown): number {
    const base = Number(y) * 50;
    const index = typeof x === 'string' ? String(base) + x : base + Number(x);
    const value: unknown = Reflect.get(data, index);
    return typeof value === 'number' ? value : 0;
}

// ---------------------------------------------------------------------------------------------
// Module state (reset every tick by make())
// ---------------------------------------------------------------------------------------------

type LookRegister = Readonly<Record<string, RoomObject>>;
type LookSpatialRegister = readonly (readonly RoomObject[] | undefined)[];

class PositionsSetCache {
    readonly cache: Record<string, unknown[]> = {};
    readonly #roomName: string;

    constructor(roomName: string) {
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
                            throw new Error('Invalid position ' + String(j) + ', check your `opts` property');
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
    lookTypeRegisters: Record<string, LookRegister>;
    lookTypeSpatialRegisters: Record<string, LookSpatialRegister>;
}

let positionsSetCacheCounter = 1;
let createdFlagNames: unknown[] = [];
let createdSpawnNames: string[] = [];
let privateStore: Record<string, RoomPrivateStore> = {};
let createdConstructionSites = 0;

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

const DESTRUCTIBLE_TYPES = ['constructedWall', 'spawn', 'extension', 'link', 'storage', 'observer', 'tower', 'powerBank', 'powerSpawn', 'lab', 'terminal'];

function getPathfinder(id: string, opts: Record<string, unknown>): AStarFinder {
    if (opts.maxOps === undefined) opts.maxOps = 2000;
    if (opts.heuristicWeight === undefined) opts.heuristicWeight = 1;
    const key = `${String(opts.maxOps)},${String(opts.heuristicWeight)}`;
    const store = storeOf(id);
    let finder = store.pfFinders[key];
    if (!finder) {
        finder = new AStarFinder({
            maxOpsLimit: Number(opts.maxOps),
            heuristic: chebyshev,
            weight: Number(opts.heuristicWeight),
        });
        store.pfFinders[key] = finder;
    }
    return finder;
}

/** Upstream `rows[y][x]` read with raw coordinates. */
function rowsGet(rows: number[][], x: unknown, y: unknown): number | undefined {
    const row = rows[Number(y)];
    if (!row) {
        throw new TypeError(`Cannot read properties of undefined (reading '${String(x)}')`);
    }
    return row[Number(x)];
}

function rowsSet(rows: number[][], x: unknown, y: unknown, value: number | undefined): void {
    const row = rows[Number(y)];
    if (!row) {
        throw new TypeError(`Cannot set properties of undefined (setting '${String(x)}')`);
    }
    const ix = Number(x);
    if (Number.isInteger(ix) && ix >= 0 && ix < 50 && value !== undefined) {
        row[ix] = value;
    }
}

function makePathfindingGrid(id: string, opts: Record<string, unknown>, endNodesKey: unknown): Grid {
    const { runtimeData, register } = scope();
    const rows: number[][] = new Array<number[]>(50);
    let obstacleTypes: string[] = [...C.OBSTACLE_OBJECT_TYPES];

    if (opts.ignoreDestructibleStructures) {
        obstacleTypes = obstacleTypes.filter((i) => !DESTRUCTIBLE_TYPES.includes(i));
    }
    if (opts.ignoreCreeps) {
        obstacleTypes = obstacleTypes.filter((i) => i !== 'creep' && i !== 'powerCreep');
    }

    const terrain = roomTerrainData(id);
    for (let y = 0; y < 50; y++) {
        const row: number[] = new Array<number>(50);
        for (let x = 0; x < 50; x++) {
            row[x] = x == 0 || y == 0 || x == 49 || y == 49 ? 11 : 2;
            const terrainCode = terrain[y * 50 + x] ?? 0;
            if (terrainCode & C.TERRAIN_MASK_WALL) {
                row[x] = 0;
            }
            if (terrainCode & C.TERRAIN_MASK_SWAMP && row[x] == 2) {
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
            (!opts.ignoreDestructibleStructures && object.type == 'rampart' && !object.isPublic && object.user != runtimeData.user._id) ||
            (!opts.ignoreDestructibleStructures &&
                object.type == 'constructionSite' &&
                object.user == runtimeData.user._id &&
                contains(C.OBSTACLE_OBJECT_TYPES, object.structureType))
        ) {
            rowsSet(rows, object.x, object.y, 0);
        }
        if (object.type == 'road' && (rowsGet(rows, object.x, object.y) ?? 0) > 0) {
            rowsSet(rows, object.x, object.y, 1);
        }
    }

    for (const [option, blocked] of [['ignore', false], ['avoid', true]] as const) {
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
                rowsSet(rows, readProp(pos, 'x'), readProp(pos, 'y'), blocked ? 0 : current !== undefined && current > 2 ? 2 : current);
            }
            if (isObject(i) && !isUndefined(readProp(i, 'x')) && !(i instanceof RoomPosition)) {
                list[key] = new RoomPosition(readProp(i, 'x'), readProp(i, 'y'), id);
            }
            if (!isUndefined(readProp(i, 'x'))) {
                const current = rowsGet(rows, readProp(i, 'x'), readProp(i, 'y'));
                rowsSet(rows, readProp(i, 'x'), readProp(i, 'y'), blocked ? 0 : current !== undefined && current > 2 ? 2 : current);
            }
        });
    }

    if (endNodesKey) {
        for (const i of collectionValues(storeOf(id).pfEndNodes[String(endNodesKey)])) {
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

function getPathfindingGrid(id: string, opts: Record<string, unknown>, endNodesKey?: unknown): Grid {
    const store = storeOf(id);
    let gridName = 'grid';

    if (opts.ignoreCreeps) {
        gridName += '_ignoreCreeps';
    }
    if (opts.ignoreDestructibleStructures) {
        gridName += '_ignoreDestructibleStructures';
    }
    if (isNumber(endNodesKey)) {
        gridName += '_endNodes' + String(endNodesKey);
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
                (!opts.ignoreCreeps && safeModeMine && (object.type == 'creep' || object.type == 'powerCreep') && object.user == runtimeData.user._id) ||
                (!opts.ignoreDestructibleStructures && object.type == 'rampart' && !object.isPublic && object.user != runtimeData.user._id) ||
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

            if (!opts.ignoreRoads && object.type == 'road' && (costs.get(object.x, object.y) ?? NaN) < 0xff) {
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

function finishPath(resultPath: RoomPathStep[], opts: Record<string, unknown>): string | RoomPathStep[] {
    return opts.serialize ? serializePath(resultPath) : resultPath;
}

function findPath2(id: string, fromPos: RoomPosition, toPos: unknown, optsArg: unknown): string | RoomPathStep[] {
    const { register } = scope();
    const opts = toOptions(optsArg);

    if (fromPos.isEqualTo(toPos)) {
        return opts.serialize ? '' : [];
    }

    if (opts.avoid) {
        register.deprecated('`avoid` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.');
        opts.avoid = undefined;
    }
    if (opts.ignore) {
        register.deprecated('`ignore` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.');
        opts.ignore = undefined;
    }
    if (
        opts.maxOps === undefined &&
        (opts.maxRooms === undefined || Number(opts.maxRooms) > 1) &&
        fromPos.roomName != readProp(toPos, 'roomName')
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

    const ret = PathFinder.search(fromPos, { range: Math.max(1, Number(opts.range || 0)), pos: toPos }, searchOpts);
    const path: unknown[] = ret.path;
    const last = ret.path[ret.path.length - 1];

    if (
        !opts.range &&
        ((last && last.isNearTo(toPos) && !last.isEqualTo(toPos)) || (!ret.path.length && fromPos.isNearTo(toPos)))
    ) {
        path.push(toPos);
    }
    let curX = fromPos.x;
    let curY = fromPos.y;

    const resultPath: RoomPathStep[] = [];

    for (const pos of path) {
        if (readProp(pos, 'roomName') != id) {
            break;
        }
        const x = Number(readProp(pos, 'x'));
        const y = Number(readProp(pos, 'y'));
        const result: RoomPathStep = { x, y, dx: x - curX, dy: y - curY, direction: getDirection(x - curX, y - curY) };
        curX = result.x;
        curY = result.y;
        resultPath.push(result);
    }

    return finishPath(resultPath, opts);
}

export function findClosestByPath2(fromPos: RoomPosition, objectsArg: unknown, opts: Record<string, unknown>): unknown {
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
        register.deprecated('`avoid` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.');
    }
    if (opts.ignore) {
        register.deprecated('`ignore` option cannot be used when `PathFinder.use()` is enabled. Use `costCallback` instead.');
    }
    const searchOpts: Record<string, unknown> = {
        roomCallback: (roomName: string) => (register.objectsByRoom[roomName] ? roomCostMatrix(roomName, opts) : undefined),
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

type LookItem = Record<string, unknown>;
type LookGrid = Record<string, Record<string, unknown[] | undefined>>;

function lookSpatialRegister(
    id: string,
    typeName: string,
    x: unknown,
    y: unknown,
    outArray?: LookItem[] | unknown[],
    withCoords?: boolean,
): unknown[] | undefined {
    if (typeName == 'terrain') {
        let result = 'plain';
        const terrainCode = terrainCodeAt(roomTerrainData(id), x, y);
        if (terrainCode & C.TERRAIN_MASK_SWAMP) {
            result = 'swamp';
        }
        if (terrainCode & C.TERRAIN_MASK_WALL) {
            result = 'wall';
        }
        if (outArray) {
            const item: LookItem = { type: 'terrain', terrain: result };
            if (withCoords) {
                item.x = x;
                item.y = y;
            }
            outArray.push(item);
            return undefined;
        }
        return [result];
    }

    const nx = Number(x);
    const ny = Number(y);
    if (nx < 0 || ny < 0 || nx > 49 || ny > 49) {
        throw new Error('look coords are out of bounds');
    }

    const spatial = storeOf(id).lookTypeSpatialRegisters[typeName];
    if (!spatial) {
        throw new TypeError(`Cannot read properties of undefined (reading '${String(nx * 50 + ny)}')`);
    }
    const typeResult = spatial[nx * 50 + ny];
    if (typeResult) {
        if (outArray) {
            for (const i of typeResult) {
                const item: LookItem = { type: typeName };
                item[typeName] = i;
                if (withCoords) {
                    item.x = x;
                    item.y = y;
                }
                outArray.push(item);
            }
            return undefined;
        }
        return [...typeResult];
    }
    return [];
}

function lookAreaMixedRegister(
    id: string,
    type: string,
    top: number,
    left: number,
    bottom: number,
    right: number,
    withType: boolean,
    result: unknown[] | LookGrid,
): void {
    const typeRegister = storeOf(id).lookTypeRegisters[type];
    const keys = typeRegister && Object.keys(typeRegister);

    if (type != 'terrain' && !keys) {
        throw new TypeError("Cannot read properties of undefined (reading 'length')");
    }

    if (type != 'terrain' && typeRegister && keys && keys.length < (bottom - top + 1) * (right - left + 1)) {
        // by objects
        const checkInside = (i: unknown): boolean => {
            const pos = readProp(i, 'pos');
            if (pos) {
                const px = Number(readProp(pos, 'x'));
                const py = Number(readProp(pos, 'y'));
                return readProp(pos, 'roomName') == id && py >= top && py <= bottom && px >= left && px <= right;
            }
            const ix = Number(readProp(i, 'x'));
            const iy = Number(readProp(i, 'y'));
            return iy >= top && iy <= bottom && ix >= left && ix <= right;
        };
        for (const key of keys) {
            const obj = typeRegister[key];
            if (!checkInside(obj)) {
                continue;
            }
            const objX = readProp(obj, 'x') || readProp(readProp(obj, 'pos'), 'x');
            const objY = readProp(obj, 'y') || readProp(readProp(obj, 'pos'), 'y');
            if (Array.isArray(result)) {
                const entry: LookItem = { x: objX, y: objY };
                if (withType) {
                    entry.type = type;
                }
                entry[type] = obj;
                result.push(entry);
                continue;
            }
            const row = result[String(objY)];
            if (!row) {
                throw new TypeError(`Cannot read properties of undefined (reading '${String(objX)}')`);
            }
            if (withType) {
                const item: LookItem = { type };
                item[type] = obj;
                const cell = row[String(objX)];
                if (!cell) {
                    throw new TypeError("Cannot read properties of undefined (reading 'push')");
                }
                cell.push(item);
            } else {
                const cell = row[String(objX)] || [];
                row[String(objX)] = cell;
                cell.push(obj);
            }
        }
    } else {
        // spatial
        for (let y = top; y <= bottom; y++) {
            for (let x = left; x <= right; x++) {
                if (Array.isArray(result)) {
                    lookSpatialRegister(id, type, x, y, result, true);
                } else {
                    const row = result[String(y)];
                    if (!row) {
                        throw new TypeError(`Cannot read properties of undefined (reading '${String(x)}')`);
                    }
                    const cell = row[String(x)];
                    if (cell) {
                        lookSpatialRegister(id, type, x, y, cell);
                    } else {
                        row[String(x)] = lookSpatialRegister(id, type, x, y, undefined);
                    }
                }
            }
        }
    }
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

/** Upstream `x < 0 || x > 49` style check on a raw coordinate (`undefined` included by callers). */
function outOfRoom(x: unknown, y: unknown): boolean {
    const nx = Number(x);
    const ny = Number(y);
    return nx < 0 || nx > 49 || ny < 0 || ny > 49;
}

// ---------------------------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------------------------

export class Room {
    declare readonly name: string;
    declare energyAvailable: number;
    declare energyCapacityAvailable: number;
    declare survivalInfo: unknown;
    declare visual: RoomVisual;
    declare controller: StructureController | undefined;
    declare storage: StructureStorage | undefined;
    declare terminal: StructureTerminal | undefined;
    declare memory: unknown;

    static Terrain: typeof RoomTerrain;

    constructor(id: string) {
        const { register } = scope();
        Object.defineProperty(this, 'name', { value: id, enumerable: true });

        this.energyAvailable = 0;
        this.energyCapacityAvailable = 0;

        // `runtimeData.games` (survival mode) is never provided by the driver, so this stays undefined.
        this.survivalInfo = undefined;

        const byRoom = register.byRoom[id];
        if (!byRoom) {
            throw new TypeError("Cannot read properties of undefined (reading 'creeps')");
        }

        privateStore[id] = {
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

        this.visual = new RoomVisual(id);
    }

    static serializePath(path: unknown): string {
        // serializePath validates the array shape itself (throws 'path is not an array').
        return serializePath(path as readonly RoomPathStep[]);
    }

    static deserializePath(str: unknown): PathStep[] {
        return deserializePath(str);
    }

    toString(): string {
        return `[room ${this.name}]`;
    }

    toJSON(): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const i in this) {
            if (i.startsWith('_') || ['toJSON', 'toString', 'controller', 'storage', 'terminal'].includes(i)) {
                continue;
            }
            result[i] = this[i];
        }
        return result;
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
        const typeKey = typeof type === 'symbol' ? undefined : Number.isNaN(Number(type)) ? undefined : Number(type);
        const cached = typeKey !== undefined && String(typeKey) === String(type) ? register.findCache[typeKey]?.[this.name] : undefined;
        if (cached) {
            result = cached;
        } else {
            switch (type) {
                case C.FIND_EXIT: {
                    const cache = (register.findCache[type] ??= {});
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
                    const cache = (register.findCache[type] ??= {});
                    const terrain = roomTerrainData(this.name);
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
                        if ((terrain[y * 50 + x] ?? 0) & C.TERRAIN_MASK_WALL) {
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
        return result;
    }

    lookForAt(type: unknown, firstArg: unknown, secondArg?: unknown): unknown {
        const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);
        const typeName = typeof type === 'symbol' ? undefined : String(type);

        if (type != 'terrain' && (typeName === undefined || !(typeName in storeOf(this.name).lookTypeSpatialRegisters))) {
            return C.ERR_INVALID_ARGS;
        }

        return lookSpatialRegister(this.name, typeName ?? 'terrain', x, y);
    }

    lookAtArea(top: unknown, left: unknown, bottom: unknown, right: unknown, asArray?: unknown): unknown {
        const [t, l, b, r] = [Number(top), Number(left), Number(bottom), Number(right)];
        const result: unknown[] | LookGrid = asArray ? [] : {};

        if (!Array.isArray(result)) {
            for (let y = t; y <= b; y++) {
                const row: Record<string, unknown[]> = {};
                for (let x = l; x <= r; x++) {
                    row[String(x)] = [];
                }
                result[String(y)] = row;
            }
        }

        for (const type of LOOK_TYPES) {
            lookAreaMixedRegister(this.name, type, t, l, b, r, true, result);
        }

        return result;
    }

    lookForAtArea(type: unknown, top: unknown, left: unknown, bottom: unknown, right: unknown, asArray?: unknown): unknown {
        const [t, l, b, r] = [Number(top), Number(left), Number(bottom), Number(right)];
        const result: unknown[] | LookGrid = asArray ? [] : {};

        if (!Array.isArray(result)) {
            for (let y = t; y <= b; y++) {
                result[String(y)] = {};
            }
        }

        lookAreaMixedRegister(this.name, typeof type === 'symbol' ? '' : String(type), t, l, b, r, false, result);

        return result;
    }

    findPath(fromPos: unknown, toPos: unknown, opts?: unknown): string | RoomPathStep[] {
        const { register } = scope();

        if (readProp(fromPos, 'roomName') != this.name) {
            return emptyPath(opts);
        }
        if (!(fromPos instanceof RoomPosition)) {
            throw new TypeError('fromPos.isEqualTo is not a function');
        }

        if (register._useNewPathFinder) {
            return findPath2(this.name, fromPos, toPos, opts);
        }

        const fromX = fromPos.x;
        const fromY = fromPos.y;
        const store = storeOf(this.name);
        let path: [number, number][];
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
            if (!store.pfEndNodes[String(toPos)]) {
                return emptyPath(options);
            }

            const grid = getPathfindingGrid(this.name, options, toPos);

            path = store.pfDijkstraFinder.findPath(fromX, fromY, -999, -999, grid);
        } else {
            if (readProp(toPos, 'roomName') != this.name) {
                return emptyPath(options);
            }

            const toX = Number(readProp(toPos, 'x'));
            const toY = Number(readProp(toPos, 'y'));
            const cacheKey = `${String(fromX)},${String(fromY)},${String(toX)},${String(toY)}${cacheKeySuffix}`;

            const cachedPath = store.pathCache[cacheKey];
            if (cachedPath) {
                return options.serialize ? serializePath(cachedPath) : cloneDeep(cachedPath);
            }

            if (fromX == toX && fromY == toY) {
                return emptyPath(options);
            }
            if (fromX < 0 || fromY < 0 || toX < 0 || toY < 0 || fromX >= 50 || fromY >= 50 || toX >= 50 || toY >= 50) {
                return emptyPath(options);
            }

            if (Math.abs(fromX - toX) < 2 && Math.abs(fromY - toY) < 2) {
                const result: RoomPathStep[] = [
                    {
                        x: toX,
                        y: toY,
                        dx: toX - fromX,
                        dy: toY - fromY,
                        direction: getDirection(toX - fromX, toY - fromY),
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

        let curX = fromX;
        let curY = fromY;

        const resultPath = path.map(([x, y]): RoomPathStep => {
            const result: RoomPathStep = { x, y, dx: x - curX, dy: y - curY, direction: getDirection(x - curX, y - curY) };
            curX = result.x;
            curY = result.y;
            return result;
        });

        const lastStep = resultPath[resultPath.length - 1];
        if (lastStep) {
            store.pathCache[`${String(fromX)},${String(fromY)},${String(lastStep.x)},${String(lastStep.y)}${cacheKeySuffix}`] = cloneDeep(resultPath);
        }

        return finishPath(resultPath, options);
    }

    getPositionAt(x: unknown, y: unknown): RoomPosition | null {
        if (outOfRoom(x, y)) {
            return null;
        }
        return new RoomPosition(x, y, this.name);
    }

    createFlag(firstArg: unknown, secondArg?: unknown, nameArg?: unknown, colorArg?: unknown, secondaryColorArg?: unknown): unknown {
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
            } while (lodashSome(register.flags, { name }) || createdFlagNames.includes(name));
        }
        if (lodashSome(register.flags, { name }) || createdFlagNames.includes(name)) {
            return C.ERR_NAME_EXISTS;
        }
        if (Number(readProp(name, 'length')) > 100) {
            return C.ERR_INVALID_ARGS;
        }

        createdFlagNames.push(name);

        const roomName = '' + this.name;
        const FlagCtor = globals.Flag;
        if (typeof FlagCtor !== 'function') {
            throw new TypeError('globals.Flag is not a constructor');
        }
        // `globals.Flag` is the Flag class exposed by flags.ts (not imported to avoid an evaluation cycle).
        const flag = Reflect.construct(FlagCtor, [name, color, secondaryColor, roomName, x, y]) as Flag;
        globals.Game.flags[String(name)] = flag;

        intents.pushByName('room', 'createFlag', { roomName, x, y, name, color, secondaryColor });

        return name;
    }

    createConstructionSite(firstArg: unknown, secondArg?: unknown, structureTypeArg?: unknown, nameArg?: unknown): number {
        const { register, intents, runtimeData } = scope();
        const [x, y] = fetchXYArguments(firstArg, secondArg, RoomPosition);
        let structureType = structureTypeArg;
        let name = nameArg;

        if (isUndefined(x) || isUndefined(y) || outOfRoom(x, y)) {
            return C.ERR_INVALID_ARGS;
        }
        if (isString(secondArg) && isUndefined(structureType)) {
            structureType = secondArg;
        }
        if (typeof structureType === 'symbol' || !Reflect.get(C.CONSTRUCTION_COST, String(structureType))) {
            return C.ERR_INVALID_ARGS;
        }
        const type = String(structureType);
        if (type == 'spawn' && typeof name == 'string') {
            if (name.length > 100) {
                return C.ERR_INVALID_ARGS;
            }
            if (createdSpawnNames.includes(name)) {
                return C.ERR_INVALID_ARGS;
            }
            if (lodashSome(register.spawns, { name }) || lodashSome(register.constructionSites, { structureType: 'spawn', name })) {
                return C.ERR_INVALID_ARGS;
            }
        }
        const controller = this.controller;
        if (controller && controller.level > 0 && !controller.my) {
            return C.ERR_NOT_OWNER;
        }
        const roomObjects = register.objectsByRoom[this.name];
        const rawController = controller && roomObjects ? roomObjects[controller.id] : undefined;
        if (controller && controller.reservation && rawController && readProp(rawController.reservation, 'user') != runtimeData.user._id) {
            return C.ERR_NOT_OWNER;
        }
        const roomName = '' + this.name;
        const controllerInfo = controller
            ? { x: controller.pos.x, y: controller.pos.y, level: controller.level, owner: controller.owner }
            : controller;
        if (!checkControllerAvailability(type, roomObjects ?? {}, controllerInfo)) {
            return C.ERR_RCL_NOT_ENOUGH;
        }
        const nx = Number(x);
        const ny = Number(y);
        if (
            !checkConstructionSite(register.objectsByRoom[roomName] ?? {}, type, nx, ny) ||
            !checkConstructionSite(roomTerrainData(roomName), type, nx, ny)
        ) {
            return C.ERR_INVALID_TARGET;
        }

        const sitesCount = Object.values(runtimeData.userObjects).filter((i) => i.type === 'constructionSite').length;
        if (sitesCount + createdConstructionSites >= C.MAX_CONSTRUCTION_SITES) {
            return C.ERR_FULL;
        }

        const intent: Record<string, unknown> = { roomName, x, y, structureType: type };

        if (type == 'spawn') {
            let spawnName: string;
            if (typeof name !== 'string') {
                let cnt = 1;
                do {
                    spawnName = 'Spawn' + String(cnt);
                    cnt++;
                } while (
                    lodashSome(register.spawns, { name: spawnName }) ||
                    lodashSome(register.constructionSites, { structureType: 'spawn', name: spawnName }) ||
                    createdSpawnNames.includes(spawnName)
                );
                name = spawnName;
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
            key = Number(type);
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

    findExitTo(room: unknown): number {
        return scope().register.map.findExit(this.name, room);
    }

    getTerrain(): RoomTerrain {
        return new RoomTerrain(this.name);
    }
}

finalizeClass(Room, { enumerableConstructor: false });

Object.defineProperty(Room.prototype, 'memory', {
    get(this: Room): unknown {
        const Memory = memoryRoot();
        if (isUndefined(Memory.rooms) || Memory.rooms === 'undefined') {
            Memory.rooms = {};
        }
        const rooms = Memory.rooms;
        if (!isObject(rooms)) {
            return undefined;
        }
        const value: unknown = readProp(rooms, this.name) || {};
        Reflect.set(rooms, this.name, value);
        return value;
    },
    set(this: Room, value: unknown): void {
        const Memory = memoryRoot();
        if (isUndefined(Memory.rooms) || Memory.rooms === 'undefined') {
            Memory.rooms = {};
        }
        const rooms = Memory.rooms;
        if (!isObject(rooms)) {
            throw new Error('Could not set room memory');
        }
        Reflect.set(rooms, this.name, value);
    },
});

// ---------------------------------------------------------------------------------------------
// RoomVisual
// ---------------------------------------------------------------------------------------------

function visualRoomName(roomName: unknown): string | undefined {
    return roomName === undefined ? undefined : typeof roomName === 'string' ? roomName : String(roomName);
}

export class RoomVisual {
    declare roomName: unknown;

    constructor(roomName?: unknown) {
        this.roomName = roomName;
    }

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

    line(x1Arg: unknown, y1Arg?: unknown, x2Arg?: unknown, y2Arg?: unknown, styleArg?: unknown): this {
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
        scope().globals.console.addVisual(visualRoomName(this.roomName), { t: 'l', x1, y1, x2, y2, s: style });
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
        scope().globals.console.addVisual(visualRoomName(this.roomName), { t: 'r', x, y, w, h, s: style });
        return this;
    }

    poly(pointsArg: unknown, style?: unknown): this {
        if (isArray(pointsArg) && pointsArg.some(Boolean)) {
            const points = pointsArg.map((i: unknown) => (readProp(i, 'x') !== undefined ? [readProp(i, 'x'), readProp(i, 'y')] : i));
            scope().globals.console.addVisual(visualRoomName(this.roomName), { t: 'p', points, s: style });
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
        scope().globals.console.addVisual(visualRoomName(this.roomName), { t: 't', text, x, y, s: style });
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
        if (typeof data === 'symbol') {
            throw new TypeError('Cannot convert a Symbol value to a string');
        }
        scope().globals.console.addVisual(visualRoomName(this.roomName), String(data));
        return this;
    }
}

finalizeClass(RoomVisual, { enumerableConstructor: false });

// ---------------------------------------------------------------------------------------------
// Room.Terrain
// ---------------------------------------------------------------------------------------------

export class RoomTerrain {
    declare get: (x: unknown, y: unknown) => number;
    declare getRawBuffer: (destinationArray?: unknown) => unknown;

    constructor(roomNameArg: unknown) {
        if (typeof roomNameArg === 'symbol') {
            throw new TypeError('Cannot convert a Symbol value to a string');
        }
        const roomName = String(roomNameArg);

        const array = scope().runtimeData.staticTerrainData[roomName];
        if (!array) {
            throw new Error(`Could not access room ${roomName}`);
        }

        this.get = (x: unknown, y: unknown): number => {
            const value = terrainCodeAt(array, x, y);
            return value & C.TERRAIN_MASK_WALL || value & C.TERRAIN_MASK_SWAMP || 0;
        };

        this.getRawBuffer = (destinationArray?: unknown): unknown => {
            if (destinationArray) {
                // `TypedArray.prototype.set` performs the receiver check (TypeError for non typed arrays).
                Uint8Array.prototype.set.call(destinationArray as Uint8Array, array);
                return destinationArray;
            }
            return new Uint8Array(array);
        };
    }
}

Room.Terrain = RoomTerrain;

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

    const { globals } = scope();
    if (!globals.Room) {
        exposeGlobal('Room', Room);
        exposeGlobal('RoomVisual', RoomVisual);
    }
    if (!globals.RoomPosition) {
        exposeGlobal('RoomPosition', RoomPosition);
        exposeGlobal('RoomObject', RoomObject);
    }
}
