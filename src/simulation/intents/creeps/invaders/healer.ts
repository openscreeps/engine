/*
 * Port of screeps/engine `processor/intents/creeps/invaders/healer.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { dist, getDirection } from '../../../../utils/index.ts';
import { findClosestByPath, hasActiveBodyparts, moveTo } from '../../../npc/fake-runtime.ts';
import type { RoomObject } from '../../../state.ts';
import { flee } from './flee.ts';
import type { InvaderContext } from './pretick.ts';

export function healer(creep: RoomObject, context: InvaderContext): void {
    const { scope, intents, invaders } = context;

    const healTargets = invaders.filter((c) => dist(c, creep) <= 3);
    if (healTargets.length > 0) {
        const healTarget = healTargets.sort(
            (a, b) => (b.hitsMax as number) - (b.hits as number) - ((a.hitsMax as number) - (a.hits as number)),
        )[0] as RoomObject;
        if (dist(creep, healTarget) <= 1) {
            intents.set(creep._id, 'heal', { id: healTarget._id, x: healTarget.x, y: healTarget.y });
        } else {
            intents.set(creep._id, 'rangedHeal', { id: healTarget._id });
        }
    }

    if ((creep.hits as number) < (creep.hitsMax as number) / 2) {
        if (!flee(creep, 4, context)) {
            const fleeTarget = findClosestByPath(
                creep,
                invaders.filter((c) => c !== creep && hasActiveBodyparts(c, C.HEAL)),
                null,
                scope,
            );

            if (fleeTarget) {
                const direction = moveTo(creep, fleeTarget, { range: 1 }, scope);
                if (direction) {
                    intents.set(creep._id, 'move', { direction });
                }
            }
        }

        return;
    }

    let target = findClosestByPath(
        creep,
        invaders.filter((c) => (c.hits as number) < (c.hitsMax as number)),
        null,
        scope,
    );
    if (!target) {
        if (flee(creep, 4, context)) {
            return;
        }
        target = findClosestByPath(
            creep,
            invaders.filter((c) => c !== creep && !hasActiveBodyparts(c, C.HEAL)),
            null,
            scope,
        );
    }

    if (!target) {
        intents.set(creep._id, 'suicide', {});
        return;
    }
    let direction: number | undefined = 0;
    if (dist(creep, target) <= 1) {
        direction = getDirection(target.x - creep.x, target.y - creep.y);
    } else {
        direction = moveTo(creep, target, { range: 1 }, scope);
    }
    if (direction) {
        intents.set(creep._id, 'move', { direction });
    }
}
