/*
 * Port of screeps/engine `processor/intents/room/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomIntentSet, RoomScope } from '../../scope.ts';
import { createConstructionSite } from './create-construction-site.ts';
import { createFlag } from './create-flag.ts';
import { roomDestroyStructure } from './destroy-structure.ts';
import { genEnergy } from './gen-energy.ts';
import { removeConstructionSite } from './remove-construction-site.ts';
import { removeFlag } from './remove-flag.ts';

export function processRoomIntents(userId: string, intents: RoomIntentSet, scope: RoomScope): void {
  const { flags, bulkFlags } = scope;

  flags.forEach((i) => {
    // Flags created earlier this pass have no `data`: upstream throws a TypeError here too.
    i._parsed = (i.data as string).split('|').map((j) => j.split('~'));
  });

  if (intents.removeFlag) {
    intents.removeFlag.forEach((i) => {
      removeFlag(userId, i, scope);
    });
  }
  if (intents.createFlag) {
    intents.createFlag.forEach((i) => {
      createFlag(userId, i, scope);
    });
  }
  if (intents.createConstructionSite) {
    intents.createConstructionSite.forEach((i) => {
      createConstructionSite(userId, i, scope);
    });
  }
  if (intents.removeConstructionSite) {
    intents.removeConstructionSite.forEach((i) => {
      removeConstructionSite(userId, i, scope);
    });
  }
  if (intents.destroyStructure) {
    intents.destroyStructure.forEach((i) => {
      roomDestroyStructure(userId, i, scope);
    });
  }

  if (intents.genEnergy) {
    genEnergy(userId, intents.genEnergy, scope);
  }

  flags.forEach((i) => {
    if (i._modified) {
      const data = (i._parsed ?? []).map((j) => j.join('~')).join('|');

      if (i._id) {
        bulkFlags.update(i._id, { data });
      } else {
        bulkFlags.insert({ data, user: i.user, room: i.room });
      }
    }
  });
}
