/*
 * Port of screeps/engine `processor/intents/invader-core/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { invaderCoreAttackController } from './attack-controller.ts';
import { invaderCoreCreateCreep } from './create-creep.ts';
import { invaderCoreReserveController } from './reserve-controller.ts';
import { invaderCoreTransfer } from './transfer.ts';
import { invaderCoreUpgradeController } from './upgrade-controller.ts';

export function processInvaderCoreIntents(
  object: RoomObject,
  objectIntents: ObjectIntentSet,
  scope: RoomScope,
): void {
  if (objectIntents.transfer) invaderCoreTransfer(object, objectIntents.transfer, scope);

  if (objectIntents.createCreep) invaderCoreCreateCreep(object, objectIntents.createCreep, scope);

  if (objectIntents.reserveController)
    invaderCoreReserveController(object, objectIntents.reserveController, scope);

  if (objectIntents.attackController)
    invaderCoreAttackController(object, objectIntents.attackController, scope);

  if (objectIntents.upgradeController)
    invaderCoreUpgradeController(object, objectIntents.upgradeController, scope);
}
