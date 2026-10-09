/*
 * Port of screeps/engine `processor/intents/ramparts/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function tickRampart(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime } = scope;

    if (object.type != 'rampart') return;

    const effect = object.effects?.find((e) => e.power === C.PWR_SHIELD);
    if (effect) {
        if (effect.endTime <= gameTime) {
            bulk.remove(object._id);
            delete roomObjects[object._id];
        }
        return;
    }

    if (roomController && object.user != '2') {
        const hitsMax = object.user == roomController.user ? lookup<number>(C.RAMPART_HITS_MAX, roomController.level) || 0 : 0;
        if (hitsMax != object.hitsMax) {
            bulk.update(object, { hitsMax });
        }
    }

    if (!object.nextDecayTime || gameTime >= object.nextDecayTime - 1) {
        object.hits = object.hits || 0;
        object.hits -= C.RAMPART_DECAY_AMOUNT;
        if (object.hits <= 0) {
            bulk.remove(object._id);
            delete roomObjects[object._id];
        } else {
            object.nextDecayTime = gameTime + C.RAMPART_DECAY_TIME;
            bulk.update(object, {
                hits: object.hits,
                nextDecayTime: object.nextDecayTime,
            });
        }
    }
}
