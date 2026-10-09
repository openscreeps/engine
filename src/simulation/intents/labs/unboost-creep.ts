/*
 * Port of screeps/engine `processor/intents/labs/unboost-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcTotalReactionsTime, checkStructureAgainstController } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { BodyPart, RoomObject } from '../../state.ts';
import { createEnergy } from '../create-energy.ts';
import { recalcBody } from '../creeps/recalc-body.ts';

export function labUnboostCreep(
  object: RoomObject,
  intent: IntentArgs<'unboostCreep'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, gameTime } = scope;

  if (!!object.cooldownTime && object.cooldownTime > gameTime) {
    return;
  }

  const target = roomObjects[String(intent.id)];
  if (!target || target.type != 'creep' || target.user != object.user) {
    return;
  }
  if (!checkStructureAgainstController(object, roomObjects, roomController)) {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }
  const boostedParts: Record<string, number> = {};
  for (const p of target.body ?? []) {
    if (p.boost) {
      boostedParts[p.boost] = (boostedParts[p.boost] ?? 0) + 1;
    }
  }
  if (!Object.keys(boostedParts).length) {
    return;
  }

  (target.body as BodyPart[]).forEach((p) => {
    p.boost = null;
  });
  recalcBody(target);
  bulk.update(target, { body: target.body, storeCapacity: target.storeCapacity });

  let cooldown = 0;
  for (const r of C.RESOURCES_ALL) {
    const count = Object.prototype.hasOwnProperty.call(boostedParts, r)
      ? (boostedParts[r] as number)
      : 0;
    if (!count) {
      continue;
    }

    const energyReturn = count * C.LAB_UNBOOST_ENERGY;
    if (energyReturn > 0) {
      createEnergy(target.x, target.y, target.room, energyReturn, C.RESOURCE_ENERGY, scope);
    }

    const mineralReturn = count * C.LAB_UNBOOST_MINERAL;
    if (mineralReturn > 0) {
      createEnergy(target.x, target.y, target.room, mineralReturn, r, scope);
    }

    cooldown += (count * calcTotalReactionsTime(r) * C.LAB_UNBOOST_MINERAL) / C.LAB_REACTION_AMOUNT;
  }

  if (cooldown > 0) {
    bulk.update(object, { cooldownTime: cooldown + gameTime });
  }
}
