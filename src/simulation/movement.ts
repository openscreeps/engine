/*
 * Movement resolution for one room processing pass (upstream `processor/intents/movement.js`).
 * Instance scoped: every processed room gets its own `Movement`, so independent worlds and rooms
 * never share state.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { calcBodyEffectiveness, checkTerrain, isAtEdge } from '../utils/index.ts';
import { addFatigue } from './intents/creeps/add-fatigue.ts';
import { createEnergy } from './intents/create-energy.ts';
import type { RoomScope } from './scope.ts';
import type { RoomObject } from './state.ts';
import { contains, lookup } from './support.ts';

interface MoveTarget {
    x: number;
    y: number;
}

function canMove(object: RoomObject): boolean {
    return (
        object.type === 'powerCreep' ||
        !!object._pulled ||
        (!object._oldFatigue && (object.body ?? []).some((i) => i.hits > 0 && i.type === C.MOVE))
    );
}

function calcResourcesWeight(creep: RoomObject): number {
    let totalCarry = 0;
    for (const key of Object.keys(creep.store ?? {})) {
        totalCarry += creep.store?.[key] ?? 0;
    }
    let weight = 0;
    const body = creep.body ?? [];
    for (let i = body.length - 1; i >= 0; i--) {
        if (!totalCarry) {
            break;
        }
        const part = body[i];
        if (!part || part.type !== C.CARRY || !part.hits) {
            continue;
        }
        let boost = 1;
        if (part.boost) {
            boost = lookup<{ capacity?: number }>(C.BOOSTS.carry, part.boost)?.capacity || 1;
        }
        totalCarry -= Math.min(totalCarry, C.CARRY_CAPACITY * boost);
        weight++;
    }
    return weight;
}

export class Movement {
    private matrix = new Map<string, RoomObject[]>();
    private resolved = new Map<string, RoomObject>();
    private readonly objects = new Map<string, MoveTarget | null>();
    private readonly affectedCnt = new Map<string, number>();

    private readonly roomObjects: Record<string, RoomObject>;
    private readonly roomTerrain: string;

    constructor(roomObjects: Record<string, RoomObject>, roomTerrain: string) {
        this.roomObjects = roomObjects;
        this.roomTerrain = roomTerrain;
    }

    addPulling(object: RoomObject, target: RoomObject): void {
        const checkRecursiveTarget = (t: RoomObject): boolean => {
            if (t._id === object._id) {
                return true;
            }
            const next = t._pull ? this.roomObjects[t._pull] : undefined;
            return !!next && checkRecursiveTarget(next);
        };
        if (!checkRecursiveTarget(target)) {
            object._pull = target._id;
            target._pulled = object._id;
        }
    }

    removePulling(object: RoomObject): void {
        if (object._pull) {
            const pulled = this.roomObjects[object._pull];
            if (pulled) {
                delete pulled._pulled;
            }
        }
        delete object._pull;
    }

    add(object: RoomObject, dx: number, dy: number): void {
        let newX = object.x + dx;
        let newY = object.y + dy;
        if (newX >= 50) newX = 49;
        if (newY >= 50) newY = 49;
        if (newX < 0) newX = 0;
        if (newY < 0) newY = 0;

        const key = `${newX},${newY}`;
        let list = this.matrix.get(key);
        if (!list) {
            list = [];
            this.matrix.set(key, list);
        }
        list.push(object);
        this.affectedCnt.set(key, (this.affectedCnt.get(key) ?? 0) + 1);
    }

    isTileBusy(x: number, y: number): boolean {
        return this.matrix.has(`${x},${y}`) || this.resolved.has(`${x},${y}`);
    }

    private checkObstacleAtXY(x: number, y: number, object: RoomObject, roomIsInSafeMode: string | false): boolean {
        let hasObstacle = false;
        let hasRoad = false;
        for (const id of Object.keys(this.roomObjects)) {
            const i = this.roomObjects[id];
            if (!i || i.x !== x || i.y !== y) {
                continue;
            }
            if (
                ((i.type === 'creep' || i.type === 'powerCreep') &&
                    !this.objects.get(i._id) &&
                    (!roomIsInSafeMode ||
                        roomIsInSafeMode !== object.user ||
                        (roomIsInSafeMode === object.user && object.user === i.user))) ||
                (i.type !== 'creep' && i.type !== 'powerCreep' && contains(C.OBSTACLE_OBJECT_TYPES, i.type)) ||
                (i.type === 'rampart' && !i.isPublic && i.user !== object.user) ||
                (i.type === 'constructionSite' &&
                    i.user === object.user &&
                    contains(C.OBSTACLE_OBJECT_TYPES, i.structureType))
            ) {
                hasObstacle = true;
                break;
            }
            if (i.type === 'road') {
                hasRoad = true;
            }
        }
        if (hasObstacle) {
            return true;
        }
        return checkTerrain(this.roomTerrain, x, y, C.TERRAIN_MASK_WALL) && !hasRoad;
    }

    check(roomIsInSafeMode: string | false): void {
        const newMatrix = new Map<string, RoomObject>();

        for (const [key, list] of this.matrix) {
            const [xs, ys] = key.split(',');
            const x = parseInt(xs ?? '', 10);
            const y = parseInt(ys ?? '', 10);
            let resultingMoveObject: RoomObject;

            if (list.length > 1) {
                const rates = list.map((object) => {
                    const moves =
                        object.type === 'powerCreep' ? 0 : calcBodyEffectiveness(object.body ?? [], C.MOVE, 'fatigue', 1);
                    let weight =
                        object.type === 'powerCreep'
                            ? 0
                            : (object.body ?? []).filter((i) => i.type !== C.MOVE && i.type !== C.CARRY).length;
                    weight += object.type === 'powerCreep' ? 0 : calcResourcesWeight(object);
                    weight = weight || 1;
                    const objectKey = `${object.x},${object.y}`;
                    let rate1 = this.affectedCnt.get(objectKey) ?? 0;
                    const atObjectTile = this.matrix.get(objectKey);
                    if (atObjectTile && atObjectTile.some((i) => i.x === x && i.y === y)) {
                        rate1 = 100;
                    }
                    return {
                        object,
                        rate1,
                        rate2: object._pulled ? 1 : 0,
                        rate3: object._pull ? 1 : 0,
                        rate4: moves / weight,
                    };
                });
                rates.sort(
                    (a, b) => b.rate1 - a.rate1 || b.rate2 - a.rate2 || b.rate3 - a.rate3 || b.rate4 - a.rate4,
                );
                resultingMoveObject = (rates[0] as (typeof rates)[number]).object;
            } else {
                resultingMoveObject = list[0] as RoomObject;
            }

            this.objects.set(resultingMoveObject._id, { x, y });
            newMatrix.set(key, resultingMoveObject);
        }

        this.matrix = new Map();
        this.resolved = newMatrix;

        const removeFromMatrix = (key: string): void => {
            const object = this.resolved.get(key);
            if (object) {
                this.objects.set(object._id, null);
            }
            this.resolved.delete(key);
            if (object) {
                const objectKey = `${object.x},${object.y}`;
                if (this.resolved.has(objectKey)) {
                    removeFromMatrix(objectKey);
                }
            }
        };

        for (const key of [...this.resolved.keys()]) {
            const object = this.resolved.get(key);
            if (!object) {
                // removed while iterating, like `delete` during `for..in` upstream
                continue;
            }
            const [xs, ys] = key.split(',');
            const x = parseInt(xs ?? '', 10);
            const y = parseInt(ys ?? '', 10);

            if (object._pulled) {
                const puller = this.roomObjects[object._pulled];
                if (puller) {
                    if (puller._pull !== object._id || key !== `${puller.x},${puller.y}`) {
                        delete puller._pull;
                        delete object._pulled;
                    }
                }
            }

            if (!canMove(object) || this.checkObstacleAtXY(x, y, object, roomIsInSafeMode)) {
                removeFromMatrix(key);
            }
        }
    }

    execute(object: RoomObject, scope: RoomScope): void {
        const { bulk, roomController, gameTime } = scope;

        const move = this.objects.get(object._id);
        if (!move) {
            return;
        }
        if (!canMove(object)) {
            return;
        }

        const cellObjects = Object.values(this.roomObjects).filter((i) => i.x === move.x && i.y === move.y);

        let fatigueRate = 2;
        if (
            cellObjects.some((i) => i.type === 'swamp') ||
            checkTerrain(this.roomTerrain, move.x, move.y, C.TERRAIN_MASK_SWAMP)
        ) {
            fatigueRate = 10;
        }

        const road = cellObjects.find((i) => i.type === 'road');
        if (road) {
            fatigueRate = 1;
            if (object.type === 'powerCreep') {
                road.nextDecayTime = (road.nextDecayTime ?? 0) - C.ROAD_WEAROUT_POWER_CREEP;
            } else {
                road.nextDecayTime = (road.nextDecayTime ?? 0) - C.ROAD_WEAROUT * (object.body ?? []).length;
            }
            bulk.update(road, { nextDecayTime: road.nextDecayTime });
        }

        if (
            !roomController ||
            roomController.user === object.user ||
            !((roomController.safeMode ?? 0) > gameTime)
        ) {
            const constructionSite = cellObjects.find((i) => i.type === 'constructionSite' && i.user !== object.user);
            if (constructionSite) {
                bulk.remove(constructionSite._id);
                if ((constructionSite.progress ?? 0) > 1) {
                    createEnergy(
                        constructionSite.x,
                        constructionSite.y,
                        constructionSite.room,
                        Math.floor((constructionSite.progress ?? 0) / 2),
                        'energy',
                        scope,
                    );
                }
            }
        }

        let fatigue = 0;
        if (object.type === 'creep') {
            fatigue = (object.body ?? []).filter((i) => i.type !== C.MOVE && i.type !== C.CARRY).length;
            fatigue += calcResourcesWeight(object);
            fatigue *= fatigueRate;
        }

        if (isAtEdge(move) && !isAtEdge(object)) {
            object._fatigue = 0;
            bulk.update(object, { x: move.x, y: move.y, fatigue: 0 });
        } else {
            bulk.update(object, { x: move.x, y: move.y });
            if (object.type === 'creep') {
                addFatigue(object, fatigue, scope);
            }
        }
    }
}
