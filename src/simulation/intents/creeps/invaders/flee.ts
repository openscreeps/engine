/*
 * Port of screeps/engine `processor/intents/creeps/invaders/flee.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { dist } from '../../../../utils/index.ts';
import { flee as fleeFrom } from '../../../npc/fake-runtime.ts';
import type { RoomObject } from '../../../state.ts';
import type { InvaderContext } from './pretick.ts';

/** Steps away from hostiles closer than `range`; true when a move intent was issued. */
export function flee(creep: RoomObject, range: number, context: InvaderContext): boolean {
  const { scope, intents, hostiles } = context;

  const nearCreeps = hostiles.filter((c) => dist(creep, c) < range);
  if (nearCreeps.length > 0) {
    const direction = fleeFrom(creep, nearCreeps, range, {}, scope);
    if (direction) {
      intents.set(creep._id, 'move', { direction });
      return true;
    }
  }

  return false;
}
