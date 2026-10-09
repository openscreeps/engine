/*
 * Port of screeps/engine `processor/global-intents/power/spawnPowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { RoomObject, UserDoc } from '../../state.ts';

export function spawnPowerCreep(
  intent: IntentArgs<'spawnPowerCreep'>,
  user: UserDoc | undefined,
  scope: GlobalScope,
): void {
  const {
    roomObjectsByType,
    userPowerCreeps,
    bulkObjects,
    bulkUsersPowerCreeps,
    shardName,
    gameTime,
  } = scope;
  const u = user as UserDoc;

  const powerSpawn = (roomObjectsByType.powerSpawn ?? []).find((i) => i._id == intent.id);
  if (!powerSpawn || powerSpawn.user != u._id || powerSpawn._justSpawned) return;

  const powerCreep = userPowerCreeps.find((i) => i.user == u._id && i.name == intent.name);
  if (
    !powerCreep ||
    powerCreep.spawnCooldownTime === null ||
    powerCreep.spawnCooldownTime > scope.env.now()
  ) {
    return;
  }

  if (
    (roomObjectsByType.powerCreep ?? []).some(
      (i) => i.room === powerSpawn.room && i.x === powerSpawn.x && i.y === powerSpawn.y,
    )
  ) {
    return;
  }

  bulkUsersPowerCreeps.update(powerCreep, {
    shard: shardName,
    spawnCooldownTime: null,
    deleteTime: null,
  });

  const doc: RoomObject = {
    ...powerCreep,
    type: 'powerCreep',
    room: powerSpawn.room,
    x: powerSpawn.x,
    y: powerSpawn.y,
    hits: powerCreep.hitsMax,
    ageTime: gameTime + C.POWER_CREEP_LIFE_TIME,
    actionLog: { spawned: true },
    notifyWhenAttacked: true,
  };
  bulkObjects.insert(doc, powerCreep._id);

  powerSpawn._justSpawned = true;
}
