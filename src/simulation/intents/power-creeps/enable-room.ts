/*
 * Port of screeps/engine `processor/intents/power-creeps/enableRoom.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { dist } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function enableRoom(object: RoomObject, intent: IntentArgs<'enableRoom'>, scope: RoomScope): void {
    const { roomObjects, bulk, gameTime } = scope;
    const target = roomObjects[intent.id as string];
    if (!target || target.type != 'controller') {
        return;
    }
    if (target.user != object.user && (target.safeMode as number) > gameTime) {
        return;
    }
    if (dist(object, target) > 1) {
        return;
    }
    bulk.update(target, { isPowerEnabled: true });
    (object.actionLog as ActionLog).attack = { x: target.x, y: target.y };
}
