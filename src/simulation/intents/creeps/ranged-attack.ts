/*
 * Port of screeps/engine `processor/intents/creeps/rangedAttack.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { applyDamage } from '../damage.ts';

export function creepRangedAttack(
  object: RoomObject,
  intent: IntentArgs<'rangedAttack'>,
  scope: RoomScope,
): void {
  const { roomObjects, roomController, gameTime } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  let target = intent.id === undefined ? undefined : roomObjects[intent.id];
  if (!target || target === object) {
    return;
  }
  if (Math.abs(target.x - object.x) > 3 || Math.abs(target.y - object.y) > 3) {
    return;
  }
  if (target.type === 'creep' && target.spawning) {
    return;
  }
  if (!target.hits) {
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

  const attackPower = calcBodyEffectiveness(
    object.body ?? [],
    C.RANGED_ATTACK,
    'rangedAttack',
    C.RANGED_ATTACK_POWER,
  );

  applyDamage(object, target, attackPower, C.EVENT_ATTACK_TYPE_RANGED, scope);
}
