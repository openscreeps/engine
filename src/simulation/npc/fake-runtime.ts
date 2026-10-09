/*
 * Port of screeps/engine `processor/common/fake-runtime.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { dist, getDirection, getOffsetsByDirection, roomNameToXY } from '../../utils/index.ts';
import { CostMatrix } from '../../utils/pathfinder.ts';
import type { IntentName } from '../../utils/system.ts';
import type { IntentArgs, ObjectIntentSet, RoomScope } from '../scope.ts';
import type { MemoryMove, RoomObject } from '../state.ts';
import { contains } from '../support.ts';

export { CostMatrix };

/** Terrain strings by room name, visible to `RoomPosition.lookFor` (module-level `terrains` upstream). */
export type TerrainMap = Readonly<Record<string, string>>;

/** Anything carrying a room position like a room object document. */
export interface Positioned {
    x: number;
    y: number;
    room: string;
}

/** The pathing source: a room object (its `user` decides rampart passability). */
export interface PathSource extends Positioned {
    user?: string | null | undefined;
}

const terrainStrings = ['plain', 'wall', 'swamp', 'wall'] as const;

export class RoomPosition {
    x: number;
    y: number;
    roomName: string;
    private readonly terrains: TerrainMap;

    constructor(x: number, y: number, roomName: string, terrains: TerrainMap = {}) {
        x = +x;
        y = +y;
        if (Number.isNaN(x) || Number.isNaN(y) || typeof roomName !== 'string') {
            throw new Error('invalid arguments in RoomPosition constructor');
        }
        this.x = x;
        this.y = y;
        this.roomName = roomName;
        this.terrains = terrains;
    }

    isEqualTo(p: RoomPosition): boolean {
        return p.x === this.x && p.y === this.y && p.roomName === this.roomName;
    }

    getRangeTo(p: RoomPosition): number {
        return p.roomName === this.roomName ? dist(p, this) : Infinity;
    }

    getDirectionTo(p: RoomPosition): number | undefined {
        if (p.roomName === this.roomName) {
            return getDirection(p.x - this.x, p.y - this.y);
        }
        const [thisRoomX, thisRoomY] = roomNameToXY(this.roomName);
        const [thatRoomX, thatRoomY] = roomNameToXY(p.roomName);
        return getDirection(
            thatRoomX * 50 + p.x - thisRoomX * 50 - this.x,
            thatRoomY * 50 + p.y - thisRoomY * 50 - this.y,
        );
    }

    lookFor(type: string): string[] | string | null {
        if (type !== C.LOOK_TERRAIN) {
            return null;
        }
        const terrain = this.terrains[this.roomName];
        if (!terrain) {
            // disallow movement via unknown terrain
            return 'wall';
        }
        const code = terrain[50 * this.y + this.x];
        return [terrainStrings[Number(code) as 0 | 1 | 2 | 3]];
    }

    sPackLocal(): string {
        return packLocal(this.x, this.y);
    }

    static sUnpackLocal(packed: string, roomName: string): RoomPosition {
        let uint32 = packed.codePointAt(0) as number;
        if (uint32 < 32) {
            throw new Error(`Invalid uint value ${String(uint32)}`);
        }
        uint32 -= 32;
        const y = uint32 & 0x3f;
        uint32 >>>= 6;
        const x = uint32 & 0x3f;
        return new RoomPosition(x, y, roomName);
    }
}

function packLocal(x: number, y: number): string {
    let uint32 = 0;
    uint32 <<= 6;
    uint32 |= x;
    uint32 <<= 6;
    uint32 |= y;
    return String.fromCharCode(32 + uint32);
}

/** Collects NPC intents per object id (the upstream `intents` helper object). */
export class IntentList {
    list: Record<string, ObjectIntentSet> = {};

    set<N extends IntentName>(id: string, name: N, data: IntentArgs<N>): void {
        const entry: ObjectIntentSet = this.list[id] ?? {};
        this.list[id] = entry;
        entry[name] = data as ObjectIntentSet[N];
    }
}

export interface PathGoal {
    pos: RoomPosition;
    range: number;
}

export type CostCallback = (roomName: string, costMatrix: CostMatrix) => unknown;

export interface FindPathOpts {
    ignoreDestructibleStructures?: boolean;
    ignoreCreeps?: boolean;
    ignoreRoads?: boolean;
    costCallback?: CostCallback | undefined;
    range?: number;
    reusePath?: number;
    maxRooms?: number;
    maxOps?: number;
    heuristicWeight?: number;
    flee?: boolean;
    plainCost?: number;
    swampCost?: number;
}

export interface FindPathResult {
    path: RoomPosition[];
    ops: number;
    cost: number;
    incomplete: boolean;
}

/** Context passed to `walkTo`. */
export interface WalkContext {
    scope: RoomScope;
    intents: IntentList;
}

const destructibleTypes = [
    'constructedWall',
    'rampart',
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

function defaultCostMatrix(
    roomId: string,
    opts: FindPathOpts,
    creep: PathSource,
    roomObjects: Record<string, RoomObject>,
): CostMatrix | false {
    if (creep.room !== roomId) {
        // disallow movement via unknown terrain
        return false;
    }

    const costs = new CostMatrix();

    let obstacleTypes: string[] = [...C.OBSTACLE_OBJECT_TYPES];
    obstacleTypes.push(C.STRUCTURE_PORTAL);

    if (opts.ignoreDestructibleStructures) {
        obstacleTypes = obstacleTypes.filter((t) => !destructibleTypes.includes(t));
    }
    if (opts.ignoreCreeps) {
        obstacleTypes = obstacleTypes.filter((t) => t !== 'creep');
    }

    for (const key of Object.keys(roomObjects)) {
        const object = roomObjects[key] as RoomObject;
        if (
            obstacleTypes.includes(object.type) ||
            (!opts.ignoreDestructibleStructures &&
                object.type === 'rampart' &&
                !object.isPublic &&
                (object.user ?? null) !== (creep.user ?? null)) ||
            (!opts.ignoreDestructibleStructures &&
                object.type === 'constructionSite' &&
                (object.user ?? null) === (creep.user ?? null) &&
                contains(C.OBSTACLE_OBJECT_TYPES, object.structureType))
        ) {
            costs.set(object.x, object.y, Infinity);
        }

        if (object.type === 'swamp' && costs.get(object.x, object.y) === 0) {
            costs.set(object.x, object.y, opts.ignoreRoads ? 5 : 10);
        }

        if (!opts.ignoreRoads && object.type === 'road' && (costs.get(object.x, object.y) as number) < Infinity) {
            costs.set(object.x, object.y, 1);
        }
    }

    return costs;
}

export function findPath(
    source: PathSource,
    target: RoomPosition | PathGoal | PathGoal[],
    opts: FindPathOpts,
    scope: RoomScope,
): FindPathResult {
    const { roomTerrain, roomObjects } = scope;
    const terrains: TerrainMap = { [source.room]: roomTerrain };

    const roomCallback = (roomName: string): CostMatrix | false => {
        let costMatrix = defaultCostMatrix(roomName, opts, source, roomObjects);
        if (typeof opts.costCallback === 'function') {
            if (costMatrix === false) {
                throw new TypeError('costMatrix.clone is not a function');
            }
            costMatrix = costMatrix.clone();
            const resultMatrix = opts.costCallback(roomName, costMatrix);
            if (resultMatrix instanceof CostMatrix) {
                costMatrix = resultMatrix;
            }
        }
        return costMatrix;
    };
    const searchOpts = { ...opts, maxRooms: 1, roomCallback };
    if (!searchOpts.ignoreRoads) {
        searchOpts.plainCost = 2;
        searchOpts.swampCost = 10;
    }

    const fromPos = new RoomPosition(source.x, source.y, source.room, terrains);

    const ret: FindPathResult = scope.env.pathFinder.search(
        fromPos,
        target,
        searchOpts,
        (x: number, y: number, roomName: string) => new RoomPosition(x, y, roomName, terrains),
    );

    const last = ret.path[ret.path.length - 1];
    if (
        target instanceof RoomPosition &&
        !opts.range &&
        ((last && last.getRangeTo(target) === 1) || (!last && fromPos.getRangeTo(target) === 1))
    ) {
        ret.path.push(target);
    }

    return ret;
}

export function flee(
    creep: PathSource,
    hostiles: readonly Positioned[],
    range: number,
    _opts: FindPathOpts,
    scope: RoomScope,
): number | undefined {
    const danger = hostiles.map((c) => ({ pos: new RoomPosition(c.x, c.y, c.room), range }));

    const result = findPath(creep, danger, { flee: true }, scope);
    const fleePosition = result.path[0];
    if (!fleePosition) {
        return 0;
    }
    return getDirection(fleePosition.x - creep.x, fleePosition.y - creep.y);
}

export function moveTo(
    creep: RoomObject,
    target: Positioned,
    optsArg: FindPathOpts | null | undefined,
    scope: RoomScope,
): number | undefined {
    const { bulk, gameTime } = scope;

    const opts = optsArg ?? {};
    if (opts.reusePath === undefined) {
        opts.reusePath = 5;
    }
    if (opts.range === undefined) {
        opts.range = 0;
    }

    if (dist(creep, target) <= opts.range) {
        return 0;
    }

    const targetPosition = new RoomPosition(target.x, target.y, target.room);
    const move = creep.memory_move;
    if (
        !move ||
        !move.dest ||
        !move.time ||
        move.dest !== targetPosition.sPackLocal() ||
        gameTime > move.time + opts.reusePath
    ) {
        const result = findPath(
            creep,
            { range: opts.range, pos: new RoomPosition(target.x, target.y, target.room) },
            opts,
            scope,
        );
        const memoryMove: MemoryMove = {
            dest: targetPosition.sPackLocal(),
            path: result.path.reduce((path, position) => `${path}${position.sPackLocal()}`, ''),
            time: gameTime,
        };
        bulk.update(creep, { memory_move: memoryMove });
    }

    const direction = nextDirectionByPath(creep, (creep.memory_move as MemoryMove).path as string);
    if (direction) {
        bulk.update(creep, { memory_move: { lastMove: gameTime } });
    }
    return direction;
}

export function walkTo(
    creep: RoomObject,
    target: Positioned,
    opts: FindPathOpts | null | undefined,
    context: WalkContext,
): number | undefined {
    const { scope, intents } = context;
    const { gameTime, bulk, roomObjects } = scope;

    const direction = moveTo(creep, target, opts, scope);
    if (!direction) {
        return direction;
    }

    const offsets = getOffsetsByDirection(direction) as readonly [number, number];
    const aheadX = creep.x + offsets[0];
    const aheadY = creep.y + offsets[1];
    const creepAhead = Object.values(roomObjects).find(
        (o) => o.type === 'creep' && o.user === creep.user && o.x === aheadX && o.y === aheadY,
    );
    if (
        creepAhead &&
        (!creepAhead.memory_move ||
            (creepAhead.memory_move.lastMove && creepAhead.memory_move.lastMove + 1 < gameTime))
    ) {
        intents.set(creepAhead._id, 'move', { direction: getDirection(creep.x - creepAhead.x, creep.y - creepAhead.y) });
        bulk.update(creepAhead, { memory_move: { dest: null, time: null, path: null, lastMove: gameTime } });
    }
    intents.set(creep._id, 'move', { direction });
    return undefined;
}

export function findClosestByPath<T extends Positioned>(
    fromPos: PathSource,
    objects: readonly T[],
    optsArg: FindPathOpts | null | undefined,
    scope: RoomScope,
): T | null {
    if (objects.length === 0) {
        return null;
    }

    const opts = optsArg ?? {};
    if (opts.range === undefined) {
        opts.range = 0;
    }

    const objectHere = objects.find((obj) => dist(fromPos, obj) === 0);
    if (objectHere) {
        return objectHere;
    }

    const goals = objects.map((i) => ({ range: 1, pos: new RoomPosition(i.x, i.y, i.room) }));

    const ret = findPath(fromPos, goals, opts, scope);

    let result: T | null = null;
    let lastPos: { x: number; y: number } = fromPos;

    const last = ret.path[ret.path.length - 1];
    if (last) {
        lastPos = last;
    }

    objects.forEach((obj) => {
        if (dist(lastPos, obj) <= 1) {
            result = obj;
        }
    });

    return result;
}

function nextDirectionByPath(creep: RoomObject, path: string): number | undefined {
    const currentPositionIndex = path.indexOf(packLocal(creep.x, creep.y));
    if (currentPositionIndex === path.length - 1) {
        return 0;
    }

    let nextPosition: RoomPosition | undefined = undefined;
    if (currentPositionIndex < 0) {
        const firstPosition = RoomPosition.sUnpackLocal(path[0] as string, creep.room);
        if (dist(creep, firstPosition) <= 1) {
            nextPosition = firstPosition;
        }
    } else {
        nextPosition = RoomPosition.sUnpackLocal(path[1 + currentPositionIndex] as string, creep.room);
    }

    if (!nextPosition) {
        return 0;
    }

    return getDirection(nextPosition.x - creep.x, nextPosition.y - creep.y);
}

export function hasActiveBodyparts(creep: RoomObject, part: string): boolean {
    return !!creep.body && creep.body.some((p) => p.hits > 0 && p.type === part);
}

/**
 * lodash 3 `_.min`/`_.max` with an iteratee: returns the boundary value (`Infinity`/`-Infinity`)
 * for empty collections or when nothing compares, exactly like upstream.
 */
function extremum<T>(
    list: readonly T[],
    iteratee: (value: T) => number | undefined,
    comparator: (a: number, b: number) => boolean,
    exValue: number,
): T | number {
    let computed = exValue;
    let result: T | number = exValue;
    for (const value of list) {
        const current = +(iteratee(value) as number);
        if (comparator(current, computed)) {
            computed = current;
            result = value;
        }
    }
    if (!(list.length && result === exValue)) {
        return result;
    }
    computed = exValue;
    result = exValue;
    for (const value of list) {
        const current = +(iteratee(value) as number);
        if (comparator(current, computed) || (current === exValue && current === result)) {
            computed = current;
            result = value;
        }
    }
    return result;
}

export function lodashMin<T>(list: readonly T[], iteratee: (value: T) => number | undefined): T | number {
    return extremum(list, iteratee, (a, b) => a < b, Infinity);
}

export function lodashMax<T>(list: readonly T[], iteratee: (value: T) => number | undefined): T | number {
    return extremum(list, iteratee, (a, b) => a > b, -Infinity);
}
