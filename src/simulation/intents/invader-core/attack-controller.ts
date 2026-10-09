/*
 * Port of screeps/engine `processor/intents/invader-core/attackController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function invaderCoreAttackController(
  object: RoomObject,
  intent: IntentArgs<'attackController'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime, eventLog, roomInfo } = scope;

  if (object.type !== 'invaderCore') {
    return;
  }
  if (object.spawning) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'controller') {
    return;
  }
  if (!target.user && !target.reservation) {
    return;
  }
  if (
    (roomController &&
      roomController.user !== object.user &&
      (roomController.safeMode as number) > gameTime) ||
    ((roomController as RoomObject).upgradeBlocked as number) > gameTime
  ) {
    return;
  }
  if (target.reservation) {
    const effect = Math.floor(C.INVADER_CORE_CONTROLLER_POWER * C.CONTROLLER_RESERVE);
    const endTime = target.reservation.endTime - effect;
    bulk.update(target, { reservation: { endTime } });
  }
  if (target.user) {
    const effect = Math.floor(C.INVADER_CORE_CONTROLLER_POWER * C.CONTROLLER_CLAIM_DOWNGRADE);
    const downgradeTime = (target.downgradeTime as number) - effect;
    bulk.update(target, { downgradeTime });
    target._upgradeBlocked = gameTime + C.CONTROLLER_ATTACK_BLOCKED_UPGRADE;
  }
  (object.actionLog as ActionLog).reserveController = { x: target.x, y: target.y };

  roomInfo.active = true;

  eventLog.push({ event: C.EVENT_ATTACK_CONTROLLER, objectId: object._id });
}
