/*
 * Port of screeps/engine `processor/intents/creeps/dismantle.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness, calcResources } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup, effectList } from '../../support.ts';
import { applyDamage } from '../damage.ts';
import { drop } from './drop.ts';

export function creepDismantle(
  object: RoomObject,
  intent: IntentArgs<'dismantle'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  let target = roomObjects[intent.id as string];
  if (!target || !lookup<number>(C.CONSTRUCTION_COST, target.type)) {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }
  if (
    roomController &&
    roomController.user !== object.user &&
    (roomController.safeMode as number) > gameTime
  ) {
    return;
  }
  const { x, y } = target;
  const rampart = Object.values(roomObjects).find(
    (i) => i.type === 'rampart' && i.x === x && i.y === y,
  );
  if (rampart) {
    target = rampart;
  }

  const power = calcBodyEffectiveness(object.body ?? [], C.WORK, 'dismantle', C.DISMANTLE_POWER);
  const amount = Math.min(power, target.hits as number);
  let energyGain = Math.floor(amount * C.DISMANTLE_COST);

  const effect = effectList(target.effects).find(
    (e) =>
      e.endTime >= gameTime &&
      (e.power === C.PWR_SHIELD ||
        e.power === C.PWR_FORTIFY ||
        e.effect === C.EFFECT_INVULNERABILITY),
  );
  if (effect) {
    energyGain = 0;
  }

  if (amount) {
    object.store = object.store || {};
    object.store.energy = (object.store.energy as number) + energyGain;
    bulk.update(object, { store: { energy: object.store.energy } });

    const usedSpace = calcResources(object);
    if (usedSpace > (object.storeCapacity as number)) {
      drop(
        object,
        { amount: usedSpace - (object.storeCapacity as number), resourceType: 'energy' },
        scope,
      );
    }

    applyDamage(object, target, amount, C.EVENT_ATTACK_TYPE_DISMANTLE, scope);
  }
}
