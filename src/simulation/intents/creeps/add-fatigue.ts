/*
 * Port of screeps/engine `processor/intents/creeps/_add-fatigue.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

/** Adds fatigue to a creep; negative amounts rest own fatigue first, the rest goes to the pulled chain. */
export function addFatigue(creep: RoomObject, delta: number, scope: RoomScope): void {
  const { roomObjects, bulk } = scope;
  let object = creep;
  let dFatigue = delta;

  if (object._fatigue === undefined) {
    object._fatigue = object.fatigue as number;
  }

  if (object._fatigue > 0 && dFatigue < 0) {
    const resting = Math.min(object._fatigue, -dFatigue);
    object._fatigue -= resting;
    dFatigue += resting;

    const fatigue = Math.max(0, object._fatigue);
    if (object.fatigue !== fatigue) {
      bulk.update(object, { fatigue });
    }

    if (dFatigue === 0) {
      return;
    }
  }

  for (;;) {
    const pulled = object._pulled ? roomObjects[object._pulled] : undefined;
    if (!pulled) {
      break;
    }
    object = pulled;
  }

  if (object._fatigue === undefined) {
    object._fatigue = object.fatigue as number;
  }
  object._fatigue += dFatigue;

  const fatigue = Math.max(0, object._fatigue);
  if (object.fatigue !== fatigue) {
    bulk.update(object, { fatigue });
  }
}
