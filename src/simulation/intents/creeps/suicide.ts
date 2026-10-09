/*
 * Port of screeps/engine `processor/intents/creeps/suicide.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { creepDie } from './die.ts';

export function creepSuicide(
  object: RoomObject,
  _intent: IntentArgs<'suicide'>,
  scope: RoomScope,
): void {
  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  creepDie(object, object.user === '2' ? 0 : undefined, false, scope);
}
