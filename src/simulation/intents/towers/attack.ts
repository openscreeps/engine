/*
 * Port of screeps/engine `processor/intents/towers/attack.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { sendAttackingNotification } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { powerEffect } from '../../support.ts';
import { applyDamage } from '../damage.ts';

/** Tower action power with range falloff and operate/disrupt effects, as upstream. */
export function towerActionAmount(
  object: RoomObject,
  target: RoomObject,
  basePower: number,
  gameTime: number,
): number {
  let range = Math.max(Math.abs(target.x - object.x), Math.abs(target.y - object.y));
  let amount = basePower;
  if (range > C.TOWER_OPTIMAL_RANGE) {
    if (range > C.TOWER_FALLOFF_RANGE) {
      range = C.TOWER_FALLOFF_RANGE;
    }
    amount -=
      (amount * C.TOWER_FALLOFF * (range - C.TOWER_OPTIMAL_RANGE)) /
      (C.TOWER_FALLOFF_RANGE - C.TOWER_OPTIMAL_RANGE);
  }
  [C.PWR_OPERATE_TOWER, C.PWR_DISRUPT_TOWER].forEach((power) => {
    const effect = object.effects?.find((e) => e.power === power);
    if (effect && effect.endTime > gameTime) {
      amount *= powerEffect(power, effect.level);
    }
  });
  return Math.floor(amount);
}

export function towerAttack(
  object: RoomObject,
  intent: IntentArgs<'attack'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime, env } = scope;

  if (object.type != 'tower' || !object.store) {
    return;
  }
  const store = object.store;

  let target = roomObjects[String(intent.id)];
  if (!target || target == object) {
    return;
  }
  if (target.type == 'creep' && target.spawning) {
    return;
  }
  if (!target.hits) {
    return;
  }
  if ((store.energy as number) < C.TOWER_ENERGY_COST) {
    return;
  }
  const targetX = target.x;
  const targetY = target.y;
  const rampart = Object.values(roomObjects).find(
    (i) => i.type === 'rampart' && i.x === targetX && i.y === targetY,
  );
  if (rampart) {
    target = rampart;
  }

  const amount = towerActionAmount(object, target, C.TOWER_POWER_ATTACK, gameTime);

  if (!amount) {
    return;
  }

  applyDamage(object, target, amount, C.EVENT_ATTACK_TYPE_RANGED, scope);

  store.energy = (store.energy as number) - C.TOWER_ENERGY_COST;
  bulk.update(object, { store: { energy: store.energy } });

  (object.actionLog as ActionLog).attack = { x: target.x, y: target.y };
  if (target.actionLog) {
    target.actionLog.attacked = { x: object.x, y: object.y };
  }

  if (target.notifyWhenAttacked) {
    sendAttackingNotification(target, roomController, (userId, message) => {
      env.sendNotification(userId, message);
    });
  }
}
