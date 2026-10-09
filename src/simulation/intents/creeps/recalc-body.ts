/*
 * Port of screeps/engine `processor/intents/creeps/_recalc-body.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness } from '../../../utils/index.ts';
import type { RoomObject } from '../../state.ts';

/** Redistributes creep hits over body parts (last part first) and recalculates carry capacity. */
export function recalcBody(object: RoomObject): void {
  const body = object.body ?? [];
  let hits = object.hits ?? 0;

  for (let i = body.length - 1; i >= 0; i--) {
    const part = body[i];
    if (!part) {
      continue;
    }
    part._oldHits = part._oldHits || part.hits;
    part.hits = hits > 100 ? 100 : hits;
    hits -= 100;
    if (hits < 0) hits = 0;
  }

  if (!object.noCapacityRecalc) {
    object.storeCapacity = calcBodyEffectiveness(body, C.CARRY, 'capacity', C.CARRY_CAPACITY, true);
  }
}
