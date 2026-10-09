/*
 * Port of screeps/engine `processor/intents/containers/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { createEnergy } from '../create-energy.ts';

export function tickContainer(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime } = scope;

    if (!object.nextDecayTime || gameTime >= object.nextDecayTime - 1) {
        object.hits = object.hits || 0;
        object.hits -= C.CONTAINER_DECAY;
        if (object.hits <= 0) {
            const store = object.store;
            if (store) {
                for (const resourceType of Object.keys(store)) {
                    const amount = store[resourceType] as number;
                    if (amount > 0) {
                        createEnergy(object.x, object.y, object.room, amount, resourceType, scope);
                    }
                }
            }

            bulk.remove(object._id);
            delete roomObjects[object._id];
        } else {
            object.nextDecayTime =
                gameTime + (roomController && (roomController.level as number) > 0 ? C.CONTAINER_DECAY_TIME_OWNED : C.CONTAINER_DECAY_TIME);
            bulk.update(object, {
                hits: object.hits,
                nextDecayTime: object.nextDecayTime,
            });
        }
    }
}
