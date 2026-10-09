/*
 * Port of screeps/engine `processor/intents/tombstones/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { createEnergy } from '../create-energy.ts';

export function tickTombstone(object: RoomObject, scope: RoomScope): void {
  const { roomObjects, bulk, gameTime } = scope;

  if (!object.decayTime || gameTime >= (object.decayTime as number) - 1) {
    const store = object.store;
    if (store) {
      for (const resourceType of Object.keys(store)) {
        createEnergy(
          object.x,
          object.y,
          object.room,
          store[resourceType] as number,
          resourceType,
          scope,
        );
      }
    }

    bulk.remove(object._id);
    Reflect.deleteProperty(roomObjects, object._id);
  }
}
