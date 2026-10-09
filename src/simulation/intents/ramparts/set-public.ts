/*
 * Port of screeps/engine `processor/intents/ramparts/set-public.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

export function setRampartPublic(
  object: RoomObject,
  intent: IntentArgs<'setPublic'>,
  scope: RoomScope,
): void {
  scope.bulk.update(object, {
    isPublic: !!intent.isPublic,
  });
}
