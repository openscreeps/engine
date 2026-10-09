/*
 * Port of screeps/engine `processor/intents/creeps/rangedHeal.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function creepRangedHeal(object: RoomObject, intent: IntentArgs<'rangedHeal'>, scope: RoomScope): void {
    const { roomObjects, roomController, gameTime, eventLog } = scope;

    if (object.type !== 'creep') {
        return;
    }
    if (object.spawning) {
        return;
    }

    const target = intent.id === undefined ? undefined : roomObjects[intent.id];
    if (!target || (target.type !== 'creep' && target.type !== 'powerCreep') || target.spawning) {
        return;
    }
    if (Math.abs(target.x - object.x) > 3 || Math.abs(target.y - object.y) > 3) {
        return;
    }
    if (roomController && roomController.user !== object.user && (roomController.safeMode as number) > gameTime) {
        return;
    }

    const healPower = calcBodyEffectiveness(object.body ?? [], C.HEAL, 'rangedHeal', C.RANGED_HEAL_POWER);

    target._healToApply = (target._healToApply || 0) + healPower;

    (object.actionLog as ActionLog).rangedHeal = { x: target.x, y: target.y };
    (target.actionLog as ActionLog).healed = { x: object.x, y: object.y };

    eventLog.push({
        event: C.EVENT_HEAL,
        objectId: object._id,
        data: { targetId: target._id, amount: healPower, healType: C.EVENT_HEAL_TYPE_RANGED },
    });
}
