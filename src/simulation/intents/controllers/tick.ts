/*
 * Port of screeps/engine `processor/intents/controllers/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject, UserDoc } from '../../state.ts';
import { lookup } from '../../support.ts';

export function tickController(object: RoomObject, scope: RoomScope): void {
    const { bulk, bulkUsers, gameTime, roomInfo, users, env } = scope;

    if (object.type != 'controller') return;

    if (object.reservation && (gameTime >= object.reservation.endTime - 1 || object.user)) {
        bulk.update(object, { reservation: null });
    }

    if (!object.user || object.user == '2') {
        return;
    }

    const user = users[object.user] as UserDoc;
    if (!user.rooms || user.rooms.indexOf(object.room) == -1) {
        bulkUsers.addToSet(user, 'rooms', object.room);
    }

    if (object._upgradeBlocked) {
        bulk.update(object, { upgradeBlocked: object._upgradeBlocked });
        delete object._upgradeBlocked;
    }

    if (object._safeModeActivated && !((object.upgradeBlocked as number) > gameTime)) {
        bulk.update(object, {
            safeModeAvailable: (object.safeModeAvailable as number) - 1,
            safeMode: gameTime + C.SAFE_MODE_DURATION,
            safeModeCooldown: (roomInfo.novice as number) > env.now() ? null : gameTime + C.SAFE_MODE_COOLDOWN,
        });
    }

    if (!object.downgradeTime || object.tutorial) {
        bulk.update(object, { downgradeTime: gameTime + (lookup<number>(C.CONTROLLER_DOWNGRADE, object.level) as number) + 1 });
        return;
    }

    if (object._upgraded && !((object.upgradeBlocked as number) > gameTime)) {
        bulk.update(object, {
            downgradeTime: Math.min(
                object.downgradeTime + C.CONTROLLER_DOWNGRADE_RESTORE + 1,
                gameTime + (lookup<number>(C.CONTROLLER_DOWNGRADE, object.level) as number) + 1,
            ),
        });
        return;
    }

    if (gameTime == object.downgradeTime - 3000) {
        env.sendNotification(
            object.user,
            `Attention! Your Controller in room ${object.room} will be downgraded to level ${String((object.level as number) - 1)} in 3000 ticks (~2 hours)! Upgrade it to prevent losing of this room. <a href='http://support.screeps.com/hc/en-us/articles/203086021-Territory-control'>Learn more</a>`,
        );
    }

    while (gameTime >= (object.downgradeTime as number) - 1 && (object.level as number) > 0) {
        object.level = (object.level as number) - 1;
        env.sendNotification(
            object.user as string,
            `Your Controller in room ${object.room} has been downgraded to level ${String(object.level)} due to absence of upgrading activity!`,
        );
        if (object.level == 0) {
            const owner = users[object.user as string] as UserDoc;
            if (owner.rooms && owner.rooms.indexOf(object.room) != -1) {
                bulkUsers.pull(owner, 'rooms', object.room);
            }

            object.progress = 0;
            object.user = null;
            object.downgradeTime = null;
            object.upgradeBlocked = null;
            object.safeMode = null;
            object.safeModeAvailable = 0;
            object.safeModeCooldown = (roomInfo.novice as number) > env.now() ? null : gameTime + C.SAFE_MODE_COOLDOWN;
            object.isPowerEnabled = false;
        } else {
            object.downgradeTime = (object.downgradeTime as number) + (lookup<number>(C.CONTROLLER_DOWNGRADE, object.level) as number) / 2 + 1;
            object.progress = (object.progress as number) + Math.round((lookup<number>(C.CONTROLLER_LEVELS, object.level) as number) * 0.9);
            object.safeModeAvailable = 0;
            object.safeModeCooldown = (roomInfo.novice as number) > env.now() ? null : gameTime + C.SAFE_MODE_COOLDOWN;
        }

        bulk.update(object, {
            downgradeTime: object.downgradeTime,
            level: object.level,
            progress: object.progress,
            user: object.user,
            upgradeBlocked: object.upgradeBlocked,
            safeMode: object.safeMode,
            safeModeCooldown: object.safeModeCooldown,
            safeModeAvailable: object.safeModeAvailable,
            isPowerEnabled: object.isPowerEnabled,
        });
    }
}
