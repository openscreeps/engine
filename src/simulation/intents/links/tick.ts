/*
 * Port of screeps/engine `processor/intents/links/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { isEqual } from '../../support.ts';

export function tickLink(object: RoomObject, scope: RoomScope): void {
    const { bulk } = scope;

    if (object.type != 'link') return;

    if ((object.cooldown as number) > 0) {
        object.cooldown = (object.cooldown as number) - 1;

        if (object.cooldown < 0) object.cooldown = 0;

        bulk.update(object, {
            cooldown: object.cooldown,
            actionLog: object.actionLog,
        });
    } else if (!isEqual(object._actionLog, object.actionLog)) {
        bulk.update(object, {
            actionLog: object.actionLog,
        });
    }
}
