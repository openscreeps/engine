/*
 * Port of screeps/engine `processor/intents/creeps/_clear-newbie-walls.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';

/** Removes every owned temporary (newbie) wall of the room. */
export function clearNewbieWalls(scope: RoomScope): void {
  const { roomObjects, bulk } = scope;
  for (const i of Object.values(roomObjects)) {
    if (i.type === 'constructedWall' && i.decayTime && i.user) {
      bulk.remove(i._id);
      Reflect.deleteProperty(roomObjects, i._id);
    }
  }
}
