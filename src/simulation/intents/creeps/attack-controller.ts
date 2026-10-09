/*
 * Port of screeps/engine `processor/intents/creeps/attackController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { effectList } from '../../support.ts';

export function creepAttackController(
  object: RoomObject,
  intent: IntentArgs<'attackController'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime, eventLog } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  const target = intent.id === undefined ? undefined : roomObjects[intent.id];
  if (!target || target.type !== 'controller') {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
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
  if (
    effectList(target.effects).some(
      (e) => e.effect === C.EFFECT_INVULNERABILITY && e.endTime > gameTime,
    )
  ) {
    return;
  }

  const claimParts = (): number =>
    (object.body ?? []).filter((i) => i.hits > 0 && i.type === C.CLAIM).length;

  if (target.reservation) {
    const effect = Math.floor(claimParts() * C.CONTROLLER_RESERVE);
    if (!effect) {
      return;
    }
    const endTime = target.reservation.endTime - effect;
    bulk.update(target, { reservation: { endTime } });
  }
  if (target.user) {
    const effect = Math.floor(claimParts() * C.CONTROLLER_CLAIM_DOWNGRADE);
    if (!effect) {
      return;
    }
    const downgradeTime = (target.downgradeTime as number) - effect;
    bulk.update(target, { downgradeTime });
    target._upgradeBlocked = gameTime + C.CONTROLLER_ATTACK_BLOCKED_UPGRADE;
  }
  (object.actionLog as ActionLog).attack = { x: target.x, y: target.y };

  eventLog.push({ event: C.EVENT_ATTACK_CONTROLLER, objectId: object._id });
}
