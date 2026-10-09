/*
 * Port of screeps/engine `processor/intents/portals/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function tickPortal(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, gameTime, env } = scope;

    if (object.unstableDate && env.now() > object.unstableDate) {
        bulk.update(object, {
            decayTime: gameTime + C.PORTAL_DECAY,
            unstableDate: null,
        });
    }

    if (object.decayTime && gameTime > (object.decayTime as number)) {
        bulk.remove(object._id);
        delete roomObjects[object._id];

        const wall = Object.values(roomObjects).find((i) => i.type == 'constructedWall' && i.x == object.x + 1 && i.y == object.y + 1);
        if (wall) {
            bulk.remove(wall._id);
            delete roomObjects[wall._id];
        }
    }
}
