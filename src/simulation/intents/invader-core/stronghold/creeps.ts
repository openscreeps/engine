/*
 * Port of screeps/engine `processor/intents/invader-core/stronghold/creeps.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { dist } from '../../../../utils/index.ts';
import { findClosestByPath, flee, walkTo } from '../../../npc/fake-runtime.ts';
import type { RoomObject } from '../../../state.ts';
import { createSafeMatrixCallback } from './defence.ts';
import type { StrongholdContext } from './stronghold.ts';

export interface CreepSetup {
    body: string[];
    boosts: (string | undefined)[];
}

interface BodySegment {
    part: string;
    count: number;
    boost?: string;
}

export type CreepBehavior = (creep: RoomObject, context: StrongholdContext) => unknown;

function makeBody(description: readonly BodySegment[]): CreepSetup {
    const result: CreepSetup = { body: [], boosts: [] };
    for (const segment of description) {
        for (let n = 0; n < segment.count; n++) {
            result.body.push(segment.part);
            result.boosts.push(segment.boost);
        }
    }
    return result;
}

export const behaviors: Readonly<Record<string, CreepBehavior>> = {
    coordinated: function coordinatedDefender(_creep, context) {
        const { spots, scope, intents, roomObjects, core, defenders } = context;
        const safeMatrixCallback = createSafeMatrixCallback(context);
        const creeps = defenders.slice();
        const assigned = spots ?? {};
        for (const spot in assigned) {
            const creep = roomObjects[assigned[spot] as string];
            for (let i = creeps.length - 1; i >= 0; i--) {
                if (creeps[i] === creep) {
                    creeps.splice(i, 1);
                }
            }
            if (!creep) {
                continue;
            }
            if (String(50 * creep.x + creep.y) === spot) {
                continue;
            }
            const spotNumber = Number(spot);
            walkTo(
                creep,
                { x: Math.floor(spotNumber / 50), y: spotNumber % 50, room: creep.room },
                { range: 0, costCallback: safeMatrixCallback },
                context,
            );
        }
        if (core.spawning) {
            for (const creep of creeps) {
                if (dist(creep, core) === 1) {
                    const direction = flee(creep, [core], 2, { costCallback: safeMatrixCallback }, scope);
                    if (direction) {
                        intents.set(creep._id, 'move', { direction });
                        return true;
                    }
                }
            }
        }
        return undefined;
    },
    'simple-melee': function simpleMelee(creep, context) {
        const { hostiles, intents, scope } = context;

        if (hostiles.length === 0) {
            return;
        }

        const safeMatrixCallback = createSafeMatrixCallback(context);

        const target = findClosestByPath(creep, hostiles, { costCallback: safeMatrixCallback }, scope);

        if (!target) {
            return;
        }

        if (dist(creep, target) <= 1) {
            intents.set(creep._id, 'attack', { id: target._id, x: target.x, y: target.y });
        } else {
            walkTo(creep, target, { costCallback: safeMatrixCallback }, context);
        }
    },
    fortifier: function fortifier(creep, context) {
        const { ramparts, intents } = context;

        if (!creep.store?.energy || ramparts.length === 0) {
            return;
        }

        const repairRamparts = ramparts.filter((r) => r.hitsTarget && (r.hits as number) < r.hitsTarget);
        const target = repairRamparts[0];
        if (!target) {
            return;
        }

        if (dist(creep, target) <= 3) {
            intents.set(creep._id, 'repair', { id: target._id, x: target.x, y: target.y });
            return;
        }

        const safeMatrixCallback = createSafeMatrixCallback(context);

        walkTo(creep, target, { range: 3, costCallback: safeMatrixCallback }, context);
        const targetInRange = repairRamparts.find((r) => dist(creep, r) <= 3);
        if (targetInRange) {
            intents.set(creep._id, 'repair', { id: targetInRange._id, x: targetInRange.x, y: targetInRange.y });
        }
    },
};

export const bodies: Readonly<Record<string, CreepSetup>> = {
    fortifier: makeBody([
        { part: C.WORK, count: 15, boost: 'XLH2O' },
        { part: C.CARRY, count: 15 },
        { part: C.MOVE, count: 15 },
    ]),
    weakDefender: makeBody([
        { part: C.ATTACK, count: 15 },
        { part: C.MOVE, count: 15 },
    ]),
    fullDefender: makeBody([
        { part: C.ATTACK, count: 25 },
        { part: C.MOVE, count: 25 },
    ]),
    boostedDefender: makeBody([
        { part: C.ATTACK, count: 25, boost: 'UH2O' },
        { part: C.MOVE, count: 25 },
    ]),
    boostedRanger: makeBody([
        { part: C.RANGED_ATTACK, count: 25, boost: 'KHO2' },
        { part: C.MOVE, count: 25 },
    ]),
    fullBoostedMelee: makeBody([
        { part: C.ATTACK, count: 44, boost: 'XUH2O' },
        { part: C.MOVE, count: 6, boost: 'XZHO2' },
    ]),
    fullBoostedRanger: makeBody([
        { part: C.RANGED_ATTACK, count: 44, boost: 'XKHO2' },
        { part: C.MOVE, count: 6, boost: 'XZHO2' },
    ]),
};
