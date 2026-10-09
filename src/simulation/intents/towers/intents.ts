/*
 * Port of screeps/engine `processor/intents/towers/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { towerAttack } from './attack.ts';
import { towerHeal } from './heal.ts';
import { towerRepair } from './repair.ts';

export function processTowerIntents(
  object: RoomObject,
  objectIntents: ObjectIntentSet,
  scope: RoomScope,
): void {
  if (objectIntents.heal) towerHeal(object, objectIntents.heal, scope);
  else if (objectIntents.repair) towerRepair(object, objectIntents.repair, scope);
  else if (objectIntents.attack) towerAttack(object, objectIntents.attack, scope);
}
