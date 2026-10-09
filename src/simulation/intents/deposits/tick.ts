/*
 * Port of screeps/engine `processor/intents/deposits/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function tickDeposit(object: RoomObject, scope: RoomScope): void {
  const { roomObjects, bulk, gameTime } = scope;
  if (object._cooldown) {
    bulk.update(object, {
      cooldownTime: gameTime + object._cooldown,
    });
  }

  if (object.decayTime && gameTime > (object.decayTime as number)) {
    bulk.remove(object._id);
    Reflect.deleteProperty(roomObjects, object._id);
  }
}
