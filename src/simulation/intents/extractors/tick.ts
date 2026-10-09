/*
 * Port of screeps/engine `processor/intents/extractors/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function tickExtractor(object: RoomObject, scope: RoomScope): void {
    const { bulk } = scope;

    if ((object.cooldown as number) > 0) {
        object.cooldown = (object.cooldown as number) - 1;

        if (object.cooldown < 0) object.cooldown = 0;

        bulk.update(object, {
            cooldown: object.cooldown,
        });
    }

    if (object._cooldown) {
        bulk.update(object, {
            cooldown: object._cooldown,
        });
    }
}
