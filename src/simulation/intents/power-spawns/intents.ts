/*
 * Port of screeps/engine `processor/intents/power-spawns/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { processPower } from './process-power.ts';

export function processPowerSpawnIntents(object: RoomObject, objectIntents: ObjectIntentSet, scope: RoomScope): void {
    if (objectIntents.processPower) processPower(object, objectIntents.processPower, scope);
}
