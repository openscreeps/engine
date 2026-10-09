/*
 * Port of screeps/engine `processor/intents/spawns/recycle-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { creepDie } from '../creeps/die.ts';

export function spawnRecycleCreep(object: RoomObject, intent: IntentArgs<'recycleCreep'>, scope: RoomScope): void {
    const { roomObjects } = scope;

    if (object.type !== 'spawn') {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'creep' || target.user !== object.user || target.spawning) {
        return;
    }
    if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
        return;
    }

    creepDie(target, 1.0, false, scope);
}
