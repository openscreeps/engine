/*
 * Port of screeps/engine `processor/intents/spawns/cancel-spawning.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, SpawningInfo } from '../../state.ts';

export function spawnCancelSpawning(spawn: RoomObject, _intent: IntentArgs<'cancelSpawning'>, scope: RoomScope): void {
    const { roomObjects, bulk } = scope;
    if (spawn.type !== 'spawn' || !spawn.spawning) return;
    const name = (spawn.spawning as SpawningInfo).name;
    const spawningCreep = Object.values(roomObjects).find(
        (i) => i.type === 'creep' && i.name === name && i.x === spawn.x && i.y === spawn.y,
    ) as RoomObject;
    bulk.remove(spawningCreep._id);
    delete roomObjects[spawningCreep._id];
    bulk.update(spawn, { spawning: null });
}
