/*
 * Port of screeps/engine `processor/intents/controllers/unclaim.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, UserDoc } from '../../state.ts';

export function unclaimController(object: RoomObject, intent: IntentArgs<'unclaim'>, scope: RoomScope): void {
    void intent;
    const { bulk, bulkUsers, gameTime, roomInfo, users, env } = scope;

    if (object.type != 'controller') {
        return;
    }

    if (!object.user || !object.level) {
        return;
    }

    const user = users[object.user] as UserDoc;
    if (user.rooms && user.rooms.indexOf(object.room) != -1) {
        bulkUsers.pull(user, 'rooms', object.room);
    }

    bulk.update(object, {
        user: null,
        level: 0,
        progress: 0,
        downgradeTime: null,
        safeMode: null,
        safeModeAvailable: 0,
        safeModeCooldown: (roomInfo.novice as number) > env.now() ? null : gameTime + C.SAFE_MODE_COOLDOWN,
        isPowerEnabled: false,
    });
}
