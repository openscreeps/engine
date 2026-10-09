/*
 * Port of screeps/engine `processor/intents/creeps/build.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkTerrain } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { contains, lookup } from '../../support.ts';

/** Upstream kept a module-global counter; it only has to be unique within one room processing pass. */
const createdStructureCounters = new WeakMap<RoomScope, number>();

type NewStructure = Omit<RoomObject, '_id'> & { _id?: string };

export function creepBuild(object: RoomObject, intent: IntentArgs<'build'>, scope: RoomScope): void {
    const { roomObjects, roomTerrain, bulk, roomController, stats, gameTime, eventLog, env } = scope;

    if (object.type !== 'creep') {
        return;
    }
    if (object.spawning || !object.store || (object.store.energy as number) <= 0) {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'constructionSite' || !lookup<number>(C.CONSTRUCTION_COST, target.structureType)) {
        return;
    }
    if (Math.abs(target.x - object.x) > 3 || Math.abs(target.y - object.y) > 3) {
        return;
    }

    const objectsInTile: RoomObject[] = [];
    const creepsInTile: RoomObject[] = [];
    const myCreepsInTile: RoomObject[] = [];
    let structure: RoomObject | null = null;
    for (const obj of Object.values(roomObjects)) {
        if (obj.x === target.x && obj.y === target.y) {
            if (obj.type === target.structureType) {
                structure = obj;
                continue;
            }
            if (obj.type === 'creep') {
                creepsInTile.push(obj);
                if (obj.user === object.user) {
                    myCreepsInTile.push(obj);
                }
            } else {
                objectsInTile.push(obj);
            }
        }
    }

    if (structure) {
        return;
    }

    if (contains(C.OBSTACLE_OBJECT_TYPES, target.structureType)) {
        if (objectsInTile.some((i) => contains(C.OBSTACLE_OBJECT_TYPES, i.type))) {
            return;
        }

        const mySafeMode =
            roomController && roomController.user === object.user && (roomController.safeMode as number) > gameTime;
        const blockingCreeps = mySafeMode ? myCreepsInTile : creepsInTile;
        if (blockingCreeps.length > 0) {
            return;
        }
    }

    if (
        target.structureType !== 'extractor' &&
        target.structureType !== 'road' &&
        checkTerrain(roomTerrain, target.x, target.y, C.TERRAIN_MASK_WALL)
    ) {
        return;
    }

    const body = object.body ?? [];
    const buildPower =
        body.filter((i) => (i.hits > 0 || (i._oldHits as number) > 0) && i.type === C.WORK).length * C.BUILD_POWER || 0;
    const buildRemaining = (target.progressTotal as number) - (target.progress as number);
    const buildEffect = Math.min(buildPower, buildRemaining, object.store.energy as number);
    let boostedParts = body.map((i) => {
        if (i.type === C.WORK && i.boost) {
            const boost = lookup<Readonly<Record<string, number>>>(C.BOOSTS[C.WORK], i.boost) as Readonly<
                Record<string, number>
            >;
            if ((boost.build as number) > 0) {
                return ((boost.build as number) - 1) * C.BUILD_POWER;
            }
        }
        return 0;
    });

    boostedParts.sort((a, b) => b - a);
    boostedParts = boostedParts.slice(0, buildEffect);

    const boostedEffect = Math.min(
        Math.floor(buildEffect + boostedParts.reduce((s, v) => s + v, 0)),
        buildRemaining,
    );

    target.progress = (target.progress as number) + boostedEffect;
    object.store.energy = (object.store.energy as number) - buildEffect;

    stats.inc('energyConstruction', object.user, buildEffect);

    (object.actionLog as ActionLog).build = { x: target.x, y: target.y };
    bulk.update(object, { store: { energy: object.store.energy } });

    const incomplete = target.progress < (target.progressTotal as number);
    eventLog.push({
        event: C.EVENT_BUILD,
        objectId: object._id,
        data: {
            targetId: target._id,
            amount: boostedEffect,
            structureType: target.structureType as string,
            x: target.x,
            y: target.y,
            incomplete,
        },
    });

    if (incomplete) {
        bulk.update(target, {
            progress: target.progress,
        });
    } else {
        bulk.remove(target._id);

        const newObject: NewStructure = {
            type: target.structureType as string,
            x: target.x,
            y: target.y,
            room: target.room,
            notifyWhenAttacked: true,
        };
        const user = target.user as string;

        if (target.structureType === 'spawn') {
            Object.assign(newObject, {
                name: target.name,
                user,
                store: { energy: 0 },
                storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY },
                hits: C.SPAWN_HITS,
                hitsMax: C.SPAWN_HITS,
            });
        }

        if (target.structureType === 'extension') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacityResource: { energy: 0 },
                hits: C.EXTENSION_HITS,
                hitsMax: C.EXTENSION_HITS,
            });
        }

        if (target.structureType === 'link') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacityResource: { energy: C.LINK_CAPACITY },
                cooldown: 0,
                hits: C.LINK_HITS,
                hitsMax: C.LINK_HITS_MAX,
            });
        }

        if (target.structureType === 'storage') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacity: C.STORAGE_CAPACITY,
                hits: C.STORAGE_HITS,
                hitsMax: C.STORAGE_HITS,
            });
        }

        const hitsMax =
            !!roomController && roomController.user === object.user
                ? lookup<number>(C.RAMPART_HITS_MAX, roomController.level) || 0
                : 0;
        if (target.structureType === 'rampart') {
            Object.assign(newObject, {
                user,
                hits: C.RAMPART_HITS,
                hitsMax,
                nextDecayTime: gameTime + C.RAMPART_DECAY_TIME,
            });
        }

        if (target.structureType === 'road') {
            let hits: number = C.ROAD_HITS;
            const values = Object.values(roomObjects);

            if (
                values.some((i) => i.x === target.x && i.y === target.y && i.type === 'swamp') ||
                checkTerrain(roomTerrain, target.x, target.y, C.TERRAIN_MASK_SWAMP)
            ) {
                hits *= C.CONSTRUCTION_COST_ROAD_SWAMP_RATIO;
            }
            if (
                values.some((i) => i.x === target.x && i.y === target.y && i.type === 'wall') ||
                checkTerrain(roomTerrain, target.x, target.y, C.TERRAIN_MASK_WALL)
            ) {
                hits *= C.CONSTRUCTION_COST_ROAD_WALL_RATIO;
            }
            Object.assign(newObject, {
                hits,
                hitsMax: hits,
                nextDecayTime: gameTime + C.ROAD_DECAY_TIME,
            });
        }

        if (target.structureType === 'constructedWall') {
            Object.assign(newObject, {
                hits: C.WALL_HITS,
                hitsMax: C.WALL_HITS_MAX,
            });
        }

        if (target.structureType === 'tower') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacityResource: { energy: C.TOWER_CAPACITY },
                hits: C.TOWER_HITS,
                hitsMax: C.TOWER_HITS,
            });
        }

        if (target.structureType === 'observer') {
            Object.assign(newObject, {
                user,
                hits: C.OBSERVER_HITS,
                hitsMax: C.OBSERVER_HITS,
            });
        }

        if (target.structureType === 'extractor') {
            Object.assign(newObject, {
                user,
                hits: C.EXTRACTOR_HITS,
                hitsMax: C.EXTRACTOR_HITS,
            });
        }

        if (target.structureType === 'lab') {
            Object.assign(newObject, {
                user,
                hits: C.LAB_HITS,
                hitsMax: C.LAB_HITS,
                mineralAmount: 0,
                cooldown: 0,
                store: { energy: 0 },
                storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
                storeCapacityResource: { energy: C.LAB_ENERGY_CAPACITY },
            });
        }

        if (target.structureType === 'powerSpawn') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacityResource: {
                    energy: C.POWER_SPAWN_ENERGY_CAPACITY,
                    power: C.POWER_SPAWN_POWER_CAPACITY,
                },
                hits: C.POWER_SPAWN_HITS,
                hitsMax: C.POWER_SPAWN_HITS,
            });
        }

        if (target.structureType === 'terminal') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacity: C.TERMINAL_CAPACITY,
                hits: C.TERMINAL_HITS,
                hitsMax: C.TERMINAL_HITS,
            });
        }

        if (target.structureType === 'container') {
            Object.assign(newObject, {
                store: { energy: 0 },
                storeCapacity: C.CONTAINER_CAPACITY,
                hits: C.CONTAINER_HITS,
                hitsMax: C.CONTAINER_HITS,
                nextDecayTime: gameTime + C.CONTAINER_DECAY_TIME,
            });
        }

        if (target.structureType === 'nuker') {
            const ptr = env.config.ptr;
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacityResource: {
                    energy: ptr ? 1 : C.NUKER_ENERGY_CAPACITY,
                    G: ptr ? 1 : C.NUKER_GHODIUM_CAPACITY,
                },
                hits: C.NUKER_HITS,
                hitsMax: C.NUKER_HITS,
                cooldownTime: gameTime + (ptr ? 100 : C.NUKER_COOLDOWN),
            });
        }

        if (target.structureType === 'factory') {
            Object.assign(newObject, {
                user,
                store: { energy: 0 },
                storeCapacity: C.FACTORY_CAPACITY,
                hits: C.FACTORY_HITS,
                hitsMax: C.FACTORY_HITS,
                cooldown: 0,
            });
        }

        bulk.insert(newObject);

        const counter = createdStructureCounters.get(scope) ?? 0;
        roomObjects['createdStructure' + String(counter)] = newObject as RoomObject;
        createdStructureCounters.set(scope, counter + 1);

        delete roomObjects[intent.id as string];
    }
}
