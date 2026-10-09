/*
 * Port of screeps/engine `processor/global-intents/power/_diePowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { GlobalScope } from '../../scope.ts';
import type { PowerCreepPowerInfo, RoomObject, Store } from '../../state.ts';

/**
 * Upstream also looks for a container under the creep in `scope.roomObjects`, but the global
 * processor scope never provides `roomObjects`, so every resource always goes to the tombstone.
 */
export function diePowerCreep(object: RoomObject, scope: GlobalScope): void {
  const { bulkObjects, bulkUsersPowerCreeps, gameTime } = scope;

  const powers: Record<string, PowerCreepPowerInfo> = {};
  for (const key of Object.keys(object.powers ?? {})) {
    powers[key] = {
      level: (object.powers as Record<string, PowerCreepPowerInfo>)[key]?.level as number,
    };
  }
  const store: Store = {};
  const tombstone: Omit<RoomObject, '_id'> = {
    type: 'tombstone',
    room: object.room,
    x: object.x,
    y: object.y,
    user: object.user,
    deathTime: gameTime,
    decayTime: gameTime + C.TOMBSTONE_DECAY_POWER_CREEP,
    store,
    powerCreepId: object._id,
    powerCreepName: object.name as string,
    powerCreepTicksToLive: (object.ageTime as number) - gameTime,
    powerCreepClassName: object.className as string,
    powerCreepLevel: object.level as number,
    powerCreepPowers: powers,
  };
  const say = object.actionLog?.say;
  if (say && say !== true && say.isPublic) {
    tombstone.powerCreepSaying = say.message as string;
  }

  if (object.store) {
    for (const resourceType of Object.keys(object.store)) {
      const amount = object.store[resourceType] as number;
      if (amount <= 0) {
        continue;
      }
      if (amount > 0) {
        store[resourceType] = (store[resourceType] || 0) + amount;
      }
    }
  }

  bulkObjects.insert(tombstone);

  bulkObjects.remove(object._id);

  bulkUsersPowerCreeps.update(object._id, {
    shard: null,
    spawnCooldownTime: scope.env.now() + C.POWER_CREEP_SPAWN_COOLDOWN,
  });
}
