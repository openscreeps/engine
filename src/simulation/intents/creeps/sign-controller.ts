/*
 * Port of screeps/engine `processor/intents/creeps/signController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function creepSignController(
  object: RoomObject,
  intent: IntentArgs<'signController'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, gameTime, env } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'controller') {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }

  bulk.update(target, {
    sign: intent.sign
      ? {
          user: object.user as string,
          text: intent.sign,
          time: gameTime,
          datetime: env.now(),
        }
      : null,
  });
}
