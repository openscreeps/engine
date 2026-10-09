/*
 * Port of screeps/engine `processor/intents/spawns/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { spawnCancelSpawning } from './cancel-spawning.ts';
import { spawnCreateCreep } from './create-creep.ts';
import { spawnRecycleCreep } from './recycle-creep.ts';
import { spawnRenewCreep } from './renew-creep.ts';
import { spawnSetSpawnDirections } from './set-spawn-directions.ts';

export function processSpawnIntents(object: RoomObject, intents: ObjectIntentSet, scope: RoomScope): void {
    if (intents.createCreep) spawnCreateCreep(object, intents.createCreep, scope);

    if (intents.renewCreep) spawnRenewCreep(object, intents.renewCreep, scope);

    if (intents.recycleCreep) spawnRecycleCreep(object, intents.recycleCreep, scope);

    if (intents.setSpawnDirections) spawnSetSpawnDirections(object, intents.setSpawnDirections, scope);

    if (intents.cancelSpawning) spawnCancelSpawning(object, intents.cancelSpawning, scope);
}
