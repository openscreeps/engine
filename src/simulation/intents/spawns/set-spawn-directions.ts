/*
 * Port of screeps/engine `processor/intents/spawns/set-spawn-directions.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, SpawningInfo } from '../../state.ts';

export function spawnSetSpawnDirections(
    spawn: RoomObject,
    intent: IntentArgs<'setSpawnDirections'>,
    scope: RoomScope,
): void {
    const { bulk } = scope;
    if (spawn.type !== 'spawn' || !spawn.spawning) return;
    let directions = intent.directions;
    if (Array.isArray(directions) && directions.length > 0) {
        // convert directions to numbers, eliminate duplicates
        directions = [...new Set(directions.map((e) => Number(e)))];
        // bail if any numbers are out of bounds or non-integers
        if (!directions.some((direction) => direction < 1 || direction > 8 || direction !== (direction | 0))) {
            const spawning: SpawningInfo = { ...(spawn.spawning as SpawningInfo) };
            spawning.directions = directions;
            bulk.update(spawn, { spawning: null });
            bulk.update(spawn, { spawning });
        }
    }
}
