/*
 * Port of screeps/engine `processor/intents/constructedWalls/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function tickConstructedWall(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime, env } = scope;

    if (object.type != 'constructedWall') return;

    if (roomController && !object.newbieWall) {
        const hitsMax = lookup<number>(C.CONTROLLER_STRUCTURES.constructedWall, roomController.level) ? C.WALL_HITS_MAX : 0;
        if (hitsMax != object.hitsMax) {
            bulk.update(object, { hitsMax });
        }
    }

    if ((object.ticksToLive as number) > 0) {
        bulk.update(object, {
            decayTime: gameTime + (object.ticksToLive as number),
            ticksToLive: null,
        });
    }

    const decayTime = object.decayTime;
    if (!decayTime) {
        return;
    }

    if (typeof decayTime !== 'object') {
        if (gameTime >= decayTime - 1 || (roomController && !roomController.user)) {
            bulk.remove(object._id);
            delete roomObjects[object._id];
        }

        if (object.user && gameTime == decayTime - 5000) {
            env.sendNotification(
                object.user,
                "Attention! Your room protection will be removed soon.\nLearn how to defend your room against intruders from <a href='http://support.screeps.com/hc/en-us/articles/203339002-Defending-your-room'>this article</a>.",
            );
        }
    } else if (env.now() > decayTime.timestamp) {
        bulk.remove(object._id);
        delete roomObjects[object._id];
    }
}
