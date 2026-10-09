/*
 * Port of screeps/engine `processor/intents/creeps/say.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function creepSay(object: RoomObject, intent: IntentArgs<'say'>): void {
  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }
  if (typeof intent.message !== 'string') {
    return;
  }

  (object.actionLog as ActionLog).say = {
    message: intent.message.substring(0, 10),
    isPublic: intent.isPublic,
  };
}
