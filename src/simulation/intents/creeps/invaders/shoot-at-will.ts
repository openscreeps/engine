/*
 * Port of screeps/engine `processor/intents/creeps/invaders/shootAtWill.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../../constants.ts';
import { dist } from '../../../../utils/index.ts';
import { hasActiveBodyparts, lodashMin } from '../../../npc/fake-runtime.ts';
import type { RoomObject } from '../../../state.ts';
import type { InvaderContext } from './pretick.ts';

export function shootAtWill(creep: RoomObject, context: InvaderContext): void {
  if (!hasActiveBodyparts(creep, C.RANGED_ATTACK)) {
    return;
  }

  const { intents, hostiles } = context;

  const targets = hostiles.filter((c) => dist(creep, c) <= 3);

  if (targets.length === 0) {
    return;
  }

  const target = lodashMin(targets, (c) => c.hits) as Partial<RoomObject>;
  intents.set(creep._id, 'rangedAttack', { id: target._id });
}
