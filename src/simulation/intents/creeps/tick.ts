/*
 * Port of screeps/engine `processor/intents/creeps/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import {
    calcBodyEffectiveness,
    getRoomNameFromXY,
    isAtEdge,
    roomNameToXY,
} from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { BodyPart, RoomObject } from '../../state.ts';
import { isEqual, lookup } from '../../support.ts';
import { bornCreep } from '../spawns/born-creep.ts';
import { addFatigue } from './add-fatigue.ts';
import { creepDie } from './die.ts';
import { dropResourcesWithoutSpace } from './drop.ts';
import { recalcBody } from './recalc-body.ts';

type BoostTable = Readonly<Record<string, Readonly<Record<string, number>>>>;

function applyBodyDamage(object: RoomObject, damageArg: number): void {
    let damage = damageArg;
    let damageReduce = 0;
    let damageEffective = damage;
    const body: BodyPart[] = object.body ?? [];

    if (body.some((i) => !!i.boost)) {
        for (const bodyPart of body) {
            if (damageEffective <= 0) {
                break;
            }
            let damageRatio = 1;
            if (bodyPart.boost) {
                const boost = lookup<Readonly<Record<string, number>>>(
                    lookup<BoostTable>(C.BOOSTS, bodyPart.type) as BoostTable,
                    bodyPart.boost,
                );
                if (boost && boost.damage) {
                    damageRatio = boost.damage;
                }
            }
            const bodyPartHitsEffective = bodyPart.hits / damageRatio;
            damageReduce += Math.min(bodyPartHitsEffective, damageEffective) * (1 - damageRatio);
            damageEffective -= Math.min(bodyPartHitsEffective, damageEffective);
        }
    }

    damage -= Math.round(damageReduce);

    object.hits = (object.hits as number) - damage;
}

export function tickCreep(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime, eventLog, movement } = scope;

    if (object.type !== 'creep') return;

    if (object.spawning) {
        const spawn = Object.values(roomObjects).find(
            (o) => o.x === object.x && o.y === object.y && (o.type === 'spawn' || o.type === 'invaderCore'),
        );
        if (!spawn) {
            bulk.remove(object._id);
            delete roomObjects[object._id];
        } else {
            const spawning = spawn.spawning;
            if (!spawning || (typeof spawning === 'object' ? spawning.name : undefined) !== object.name) {
                bornCreep(spawn, object, scope);
            }
        }
    } else {
        movement.execute(object, scope);

        if (isAtEdge(object) && object.user !== '2' && object.user !== '3') {
            const [roomX, roomY] = roomNameToXY(object.room);
            let x = object.x;
            let y = object.y;
            let room = object.room;

            if (object.x === 0) {
                x = 49;
                room = getRoomNameFromXY(roomX - 1, roomY);
            } else if (object.y === 0) {
                y = 49;
                room = getRoomNameFromXY(roomX, roomY - 1);
            } else if (object.x === 49) {
                x = 0;
                room = getRoomNameFromXY(roomX + 1, roomY);
            } else if (object.y === 49) {
                y = 0;
                room = getRoomNameFromXY(roomX, roomY + 1);
            }

            bulk.update(object, { interRoom: { room, x, y } });

            eventLog.push({ event: C.EVENT_EXIT, objectId: object._id, data: { room, x, y } });
        }

        if (object.ageTime) {
            // since NPC creeps may appear right on portals without `ageTime` defined at the first tick
            const portal = Object.values(roomObjects).find(
                (i) => i.type === 'portal' && i.x === object.x && i.y === object.y,
            );
            if (portal) {
                bulk.update(object, { interRoom: portal.destination });
            }
        }

        if (!object.tutorial) {
            if (!object.ageTime) {
                object.ageTime =
                    gameTime +
                    ((object.body ?? []).some((i) => i.type === C.CLAIM) ? C.CREEP_CLAIM_LIFE_TIME : C.CREEP_LIFE_TIME);
                bulk.update(object, { ageTime: object.ageTime });
            }

            if (gameTime >= object.ageTime - 1) {
                creepDie(object, undefined, false, scope);
            }
        }

        if (!isEqual(object.actionLog, object._actionLog)) {
            bulk.update(object, { actionLog: object.actionLog });
        }
    }

    const moves = calcBodyEffectiveness(object.body ?? [], C.MOVE, 'fatigue', 1);
    if (moves > 0) {
        addFatigue(object, -2 * moves, scope);
    }

    if (Number.isNaN(object.hits) || (object.hits as number) <= 0) {
        creepDie(object, undefined, true, scope);
    }

    if (
        object.userSummoned &&
        Object.values(roomObjects).some(
            (i) => i.type === 'creep' && i.user !== '2' && i.user !== (roomController as RoomObject).user,
        )
    ) {
        creepDie(object, undefined, false, scope);
    }

    const oldHits = object.hits;

    if (object._damageToApply) {
        applyBodyDamage(object, object._damageToApply);
        delete object._damageToApply;
    }

    if (object._healToApply) {
        object.hits = (object.hits as number) + object._healToApply;
        delete object._healToApply;
    }

    if ((object.hits as number) > (object.hitsMax as number)) {
        object.hits = object.hitsMax as number;
    }

    if ((object.hits as number) <= 0) {
        creepDie(object, undefined, true, scope);
    } else if (object.hits !== oldHits) {
        recalcBody(object);

        if ((object.hits as number) < (oldHits as number)) {
            dropResourcesWithoutSpace(object, scope);
        }

        bulk.update(object, {
            hits: object.hits,
            body: object.body,
            storeCapacity: object.storeCapacity,
        });
    }
}
