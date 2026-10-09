/*
 * Port of screeps/engine `processor/intents/power-creeps/{intents,move,drop,pickup,transfer,withdraw}.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { drop } from '../creeps/drop.ts';
import { creepMove } from '../creeps/move.ts';
import { creepPickup } from '../creeps/pickup.ts';
import { creepTransfer } from '../creeps/transfer.ts';
import { creepWithdraw } from '../creeps/withdraw.ts';
import { enableRoom } from './enable-room.ts';
import { renew } from './renew.ts';
import { say } from './say.ts';
import { usePower } from './use-power.ts';

export function processPowerCreepIntents(
  object: RoomObject,
  intents: ObjectIntentSet,
  scope: RoomScope,
): void {
  if (intents.move) creepMove(object, intents.move, scope);
  if (intents.usePower) usePower(object, intents.usePower, scope);
  if (intents.withdraw) creepWithdraw(object, intents.withdraw, scope);
  if (intents.transfer) creepTransfer(object, intents.transfer, scope);
  if (intents.say) say(object, intents.say);
  if (intents.drop) drop(object, intents.drop, scope);
  if (intents.pickup) creepPickup(object, intents.pickup, scope);
  if (intents.enableRoom) enableRoom(object, intents.enableRoom, scope);
  if (intents.renew) renew(object, intents.renew, scope);
}
