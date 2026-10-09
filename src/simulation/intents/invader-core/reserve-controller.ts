/*
 * Port of screeps/engine `processor/intents/invader-core/reserveController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function invaderCoreReserveController(
    object: RoomObject,
    intent: IntentArgs<'reserveController'>,
    scope: RoomScope,
): void {
    const { roomObjects, bulk, gameTime, eventLog } = scope;

    if (object.type !== 'invaderCore') {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'controller') {
        return;
    }

    if (target.user || (target.reservation && target.reservation.user !== object.user)) {
        return;
    }

    if (!target.reservation) {
        target.reservation = {
            user: object.user as string,
            endTime: gameTime + 1,
        };
    }

    const effect = C.INVADER_CORE_CONTROLLER_POWER * C.CONTROLLER_RESERVE;
    if (target.reservation.endTime + effect > gameTime + C.CONTROLLER_RESERVE_MAX) {
        return;
    }

    (object.actionLog as ActionLog).reserveController = { x: target.x, y: target.y };

    target.reservation.endTime += effect;
    bulk.update(target, { reservation: target.reservation });

    eventLog.push({ event: C.EVENT_RESERVE_CONTROLLER, objectId: object._id, data: { amount: effect } });
}
