/*
 * Port of screeps/engine `processor/intents/towers/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { isEqual } from '../../support.ts';

export function tickTower(object: RoomObject, scope: RoomScope): void {
    const { bulk } = scope;

    if (object.type != 'tower') return;

    if (!isEqual(object._actionLog, object.actionLog)) {
        bulk.update(object, {
            actionLog: object.actionLog,
        });
    }
}
