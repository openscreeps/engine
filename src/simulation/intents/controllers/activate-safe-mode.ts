/*
 * Port of screeps/engine `processor/intents/controllers/activateSafeMode.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function activateSafeMode(object: RoomObject, intent: IntentArgs<'activateSafeMode'>, scope: RoomScope): void {
    void intent;
    const { gameTime } = scope;

    if (!object.user || !object.level) {
        return;
    }
    if (!((object.safeModeAvailable as number) > 0)) {
        return;
    }
    if ((object.safeModeCooldown as number) >= gameTime) {
        return;
    }
    if ((object.upgradeBlocked as number) > gameTime) {
        return;
    }
    if (
        (object.downgradeTime as number) <
        gameTime + (lookup<number>(C.CONTROLLER_DOWNGRADE, object.level) as number) / 2 - C.CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD
    ) {
        return;
    }

    object._safeModeActivated = 1;
}
