/*
 * Port of screeps/engine `processor/intents/nukes/pretick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomIntentsDoc, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

/** Cancels every spawn intent of the room one tick before a nuke lands. */
export function nukePretick(object: RoomObject, intents: RoomIntentsDoc, scope: RoomScope): void {
  const { gameTime } = scope;
  if (object.landTime == 1 + gameTime) {
    for (const userId of Object.keys(intents.users)) {
      const objects = (intents.users[userId] as (typeof intents.users)[string]).objects;
      if (!objects) {
        continue;
      }
      for (const objectId of Object.keys(objects)) {
        const i = objects[objectId];
        // Upstream sets `null`; only truthiness is checked downstream.
        if (i && !!i.createCreep) {
          i.createCreep = undefined;
        }
      }
    }
  }
}
