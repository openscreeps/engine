/*
 * Port of screeps/engine `processor/intents/creeps/move.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { dist, getOffsetsByDirection } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { contains } from '../../support.ts';

export function creepMove(object: RoomObject, intent: IntentArgs<'move'>, scope: RoomScope): void {
    const { roomObjects, movement } = scope;

    if (object.spawning) {
        return;
    }

    object._oldFatigue = object.fatigue;

    let d: readonly [number, number] | undefined | null = null;
    if (intent.direction) {
        d = getOffsetsByDirection(intent.direction);
    }
    if (intent.id) {
        const creep = roomObjects[intent.id];
        if (creep && creep.type === 'creep' && dist(object, creep) === 1) {
            d = [creep.x - object.x, creep.y - object.y];
        }
    }

    if (!d) {
        return;
    }

    const [dx, dy] = d;

    if (object.x + dx < 0 || object.x + dx > 49 || object.y + dy < 0 || object.y + dy > 49) {
        return;
    }

    const targetObjects = Object.values(roomObjects).filter((i) => i.x === object.x + dx && i.y === object.y + dy);

    if (
        !targetObjects.some(
            (target) =>
                (contains(C.OBSTACLE_OBJECT_TYPES, target.type) && target.type !== 'creep' && target.type !== 'powerCreep') ||
                (target.type === 'rampart' && !target.isPublic && object.user !== target.user) ||
                (object.type === 'powerCreep' && target.type === 'portal' && target.destination?.shard),
        )
    ) {
        movement.add(object, dx, dy);
    }
}
