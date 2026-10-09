/*
 * Port of screeps/engine `processor/intents/creeps/generateSafeMode.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function creepGenerateSafeMode(object: RoomObject, intent: IntentArgs<'generateSafeMode'>, scope: RoomScope): void {
    const { roomObjects, bulk } = scope;

    if (object.spawning) {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'controller') {
        return;
    }
    if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
        return;
    }
    if (!object.store || !((object.store[C.RESOURCE_GHODIUM] as number) >= C.SAFE_MODE_COST)) {
        return;
    }

    bulk.update(target, { safeModeAvailable: (target.safeModeAvailable || 0) + 1 });
    bulk.update(object, {
        store: { [C.RESOURCE_GHODIUM]: (object.store[C.RESOURCE_GHODIUM] as number) - C.SAFE_MODE_COST },
    });
}
