/*
 * Port of screeps/engine `processor/intents/creeps/_die.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject, Store } from '../../state.ts';
import { lookup } from '../../support.ts';

/** Kills a creep: removes it, leaves a tombstone with body/store resources (unless nuked). */
export function creepDie(
    object: RoomObject,
    dropRateArg: number | undefined,
    violentDeath: boolean,
    scope: RoomScope,
    attackType?: number,
): void {
    const { roomObjects, bulk, stats, gameTime, eventLog } = scope;
    const dropRate = dropRateArg === undefined ? C.CREEP_CORPSE_RATE : dropRateArg;
    const body = object.body ?? [];

    bulk.remove(object._id);
    delete roomObjects[object._id];

    let decayTime = body.length * C.TOMBSTONE_DECAY_PER_PART;
    if (object.tombstoneDecay) {
        decayTime = object.tombstoneDecay;
    }

    if (!attackType || attackType !== C.EVENT_ATTACK_TYPE_NUKE) {
        const tombstoneStore: Store = {};
        const tombstone: RoomObject = {
            _id: '',
            type: 'tombstone',
            room: object.room,
            x: object.x,
            y: object.y,
            user: object.user,
            deathTime: gameTime,
            decayTime: gameTime + decayTime,
            creepId: String(object._id),
            creepName: object.name as string,
            creepTicksToLive: (object.ageTime as number) - gameTime,
            creepBody: body.map((b) => b.type),
            store: tombstoneStore,
        };
        const say = object.actionLog?.say;
        if (say && say !== true && say.isPublic) {
            tombstone.creepSaying = say.message as string;
        }

        const container = Object.values(roomObjects).find(
            (i) => i.type === 'container' && i.x === object.x && i.y === object.y,
        );

        const toContainer = (resourceType: string, amount: number): number => {
            if (container && (container.hits ?? 0) > 0) {
                container.store = container.store || {};
                const targetTotal = calcResources(container);
                const toContainerAmount = Math.min(amount, (container.storeCapacity as number) - targetTotal);
                if (toContainerAmount > 0) {
                    container.store[resourceType] = (container.store[resourceType] || 0) + toContainerAmount;
                    bulk.update(container, { store: { [resourceType]: container.store[resourceType] } });
                    return amount - toContainerAmount;
                }
            }
            return amount;
        };

        if (dropRate > 0 && !object.userSummoned && !object.strongholdId) {
            const lifeTime = body.some((i) => i.type === C.CLAIM) ? C.CREEP_CLAIM_LIFE_TIME : C.CREEP_LIFE_TIME;
            const lifeRate = (dropRate * (object._ticksToLive as number)) / lifeTime;
            const bodyResources: Record<string, number> = { energy: 0 };

            for (const i of body) {
                if (i.boost) {
                    bodyResources[i.boost] = (bodyResources[i.boost] || 0) + C.LAB_BOOST_MINERAL * lifeRate;
                    bodyResources.energy = (bodyResources.energy as number) + C.LAB_BOOST_ENERGY * lifeRate;
                }
                bodyResources.energy =
                    (bodyResources.energy as number) +
                    Math.min(C.CREEP_PART_MAX_ENERGY, (lookup<number>(C.BODYPART_COST, i.type) as number) * lifeRate);
            }

            for (const resourceType of Object.keys(bodyResources)) {
                let amount = Math.floor(bodyResources[resourceType] as number);
                if (amount > 0) {
                    amount = toContainer(resourceType, amount);
                    if (amount > 0) {
                        tombstoneStore[resourceType] = (tombstoneStore[resourceType] || 0) + amount;
                    }
                }
            }

            const store = object.store ?? {};
            for (const resourceType of Object.keys(store)) {
                let amount = store[resourceType] as number;
                if (amount > 0) {
                    amount = toContainer(resourceType, amount);
                }
                if (amount > 0) {
                    tombstoneStore[resourceType] = (tombstoneStore[resourceType] || 0) + amount;
                }
            }
        }

        bulk.insert(tombstone);
    }

    eventLog.push({ event: C.EVENT_OBJECT_DESTROYED, objectId: object._id, data: { type: 'creep' } });

    if (violentDeath && object.user !== '3' && object.user !== '2') {
        stats.inc('creepsLost', object.user, body.length);
    }
}
