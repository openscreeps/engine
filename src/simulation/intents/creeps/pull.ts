/*
 * Port of screeps/engine `processor/intents/creeps/pull.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function creepPull(object: RoomObject, intent: IntentArgs<'pull'>, scope: RoomScope): void {
  const { roomObjects, movement } = scope;
  if (object.type !== 'creep' || object.spawning) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'creep' || target.spawning) {
    return;
  }

  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }

  movement.addPulling(object, target);
}
