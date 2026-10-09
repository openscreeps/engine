/*
 * Port of screeps/engine `processor/intents/_damage.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { calcBodyEffectiveness, sendAttackingNotification } from '../../utils/index.ts';
import type { RoomScope } from '../scope.ts';
import type { ActionLog, RoomObject } from '../state.ts';
import { clearNewbieWalls } from './creeps/clear-newbie-walls.ts';
import { destroyStructure } from './structures/destroy.ts';

export function applyDamage(
  object: RoomObject,
  target: RoomObject,
  damage: number,
  attackType: number,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime, roomInfo, eventLog, env } = scope;

  if (!target._id || !target.hits) {
    return;
  }

  let attackBackPower = 0;

  if (target.type === 'creep') {
    if (
      attackType === C.EVENT_ATTACK_TYPE_MELEE &&
      !Object.values(roomObjects).some(
        (i) => i.type === 'rampart' && i.x === object.x && i.y === object.y,
      )
    ) {
      attackBackPower = calcBodyEffectiveness(
        target.body ?? [],
        C.ATTACK,
        'attack',
        C.ATTACK_POWER,
      );
    }
    target._damageToApply = (target._damageToApply || 0) + damage;
  } else if (target.type === 'powerCreep') {
    target._damageToApply = (target._damageToApply || 0) + damage;
  } else {
    if (
      attackType !== C.EVENT_ATTACK_TYPE_NUKE &&
      (target.type === 'constructedWall' || target.type === 'rampart')
    ) {
      const effect = (target.effects ?? []).find(
        (e) =>
          (e.power === C.PWR_FORTIFY || e.effect === C.EFFECT_INVULNERABILITY) &&
          e.endTime > gameTime,
      );
      if (effect) {
        return;
      }
    }
    target.hits -= damage;
  }

  if (target.type === 'powerBank') {
    attackBackPower = damage * C.POWER_BANK_HIT_BACK;
  }

  if (
    roomController &&
    roomController.user === object.user &&
    (roomController.safeMode ?? 0) > gameTime
  ) {
    attackBackPower = 0;
  }

  if (target.type === 'constructedWall' && target.decayTime) {
    clearNewbieWalls(scope);
  } else if (target.hits <= 0) {
    if (target.type !== 'creep' && target.type !== 'powerCreep') {
      destroyStructure(target, scope, attackType);
      eventLog.push({
        event: C.EVENT_OBJECT_DESTROYED,
        objectId: target._id,
        data: { type: target.type },
      });
    }
  } else if (target.type !== 'creep' && target.type !== 'powerCreep') {
    bulk.update(target, { hits: target.hits });
  }

  if (object.actionLog && object.type === 'creep') {
    if (attackType === C.EVENT_ATTACK_TYPE_MELEE || attackType === C.EVENT_ATTACK_TYPE_DISMANTLE) {
      object.actionLog.attack = { x: target.x, y: target.y };
    }
    if (attackType === C.EVENT_ATTACK_TYPE_RANGED) {
      object.actionLog.rangedAttack = { x: target.x, y: target.y };
    }
  }
  if (target.actionLog) {
    target.actionLog.attacked = { x: object.x, y: object.y };
  }

  if (object.user !== '2' && object.user !== '3') {
    if (target.notifyWhenAttacked) {
      sendAttackingNotification(target, roomController, (userId, message) => {
        env.sendNotification(userId, message);
      });
    }
    if (
      object.user &&
      target.user &&
      object.user !== target.user &&
      target.user !== '2' &&
      target.user !== '3'
    ) {
      roomInfo.lastPvpTime = gameTime;
    }
  }

  if (attackBackPower) {
    object._damageToApply = (object._damageToApply || 0) + attackBackPower;
    // unguarded like upstream: an attacker without an action log throws and aborts the room
    (object.actionLog as ActionLog).attacked = { x: target.x, y: target.y };
    eventLog.push({
      event: C.EVENT_ATTACK,
      objectId: target._id,
      data: {
        targetId: object._id,
        damage: attackBackPower,
        attackType: C.EVENT_ATTACK_TYPE_HIT_BACK,
      },
    });
  }

  eventLog.push({
    event: C.EVENT_ATTACK,
    objectId: object._id,
    data: { targetId: target._id, damage, attackType },
  });
}
