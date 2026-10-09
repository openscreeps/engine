/*
 * Port of screeps/engine `processor/intents/creeps/reserveController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function creepReserveController(object: RoomObject, intent: IntentArgs<'reserveController'>, scope: RoomScope): void {
    const { roomObjects, bulk, gameTime, eventLog, users } = scope;

    if (object.type !== 'creep') {
        return;
    }
    if (object.spawning) {
        return;
    }

    const user = users[object.user as string];
    if (user && user.shardAccess === false) {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'controller') {
        return;
    }
    if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
        return;
    }
    if (target.user || (target.reservation && target.reservation.user !== object.user)) {
        return;
    }

    const effect = (object.body ?? []).filter((i) => i.hits > 0 && i.type === C.CLAIM).length * C.CONTROLLER_RESERVE;
    if (!effect) {
        return;
    }

    if (!target.reservation) {
        target.reservation = {
            user: object.user as string,
            endTime: gameTime + 1,
        };
    }

    if (target.reservation.endTime + effect > gameTime + C.CONTROLLER_RESERVE_MAX) {
        return;
    }

    (object.actionLog as ActionLog).reserveController = { x: target.x, y: target.y };

    target.reservation.endTime += effect;
    bulk.update(target, { reservation: target.reservation });

    eventLog.push({ event: C.EVENT_RESERVE_CONTROLLER, objectId: object._id, data: { amount: effect } });
}
