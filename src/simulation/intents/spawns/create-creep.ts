/*
 * Port of screeps/engine `processor/intents/spawns/create-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcCreepCost, checkStructureAgainstController } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { BodyPart, RoomObject } from '../../state.ts';
import { contains } from '../../support.ts';
import { chargeEnergy } from './charge-energy.ts';

export function spawnCreateCreep(
  spawn: RoomObject,
  intent: IntentArgs<'createCreep'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, stats, gameTime } = scope;

  if (spawn.spawning) {
    return;
  }
  if (spawn.type !== 'spawn') return;

  if (!checkStructureAgainstController(spawn, roomObjects, roomController)) {
    return;
  }

  // user-supplied payload: may hold non-number entries at runtime
  const rawDirections: unknown = intent.directions;
  let directions: number[] | undefined;
  if (rawDirections !== undefined) {
    if (!Array.isArray(rawDirections)) {
      return;
    }
    // convert directions to numbers, eliminate duplicates
    directions = [...new Set(rawDirections.map((e) => Number(e)))];
    if (directions.length > 0) {
      // bail if any numbers are out of bounds or non-integers
      if (
        !directions.every(
          (direction) => direction >= 1 && direction <= 8 && direction === (direction | 0),
        )
      ) {
        return;
      }
    }
  }

  const intentBody = (intent.body as NonNullable<typeof intent.body>).slice(0, C.MAX_CREEP_SIZE);
  intent.body = intentBody;

  const cost = calcCreepCost(intentBody);
  const result = chargeEnergy(spawn, cost, intent.energyStructures, scope);

  if (!result) {
    return;
  }

  stats.inc('energyCreeps', spawn.user, cost);

  stats.inc('creepsProduced', spawn.user, intentBody.length);

  let needTime = C.CREEP_SPAWN_TIME * intentBody.length;

  const effect = (spawn.effects ?? []).find((e) => e.power === C.PWR_OPERATE_SPAWN);
  if (effect && effect.endTime > gameTime) {
    needTime = Math.ceil(
      needTime * (C.POWER_INFO[C.PWR_OPERATE_SPAWN].effect[(effect.level as number) - 1] as number),
    );
  }

  bulk.update(spawn, {
    spawning: {
      name: intent.name as string,
      needTime,
      spawnTime: gameTime + needTime,
      directions,
    },
  });

  const body: BodyPart[] = [];
  let storeCapacity = 0;

  intentBody.forEach((i) => {
    if (contains(C.BODYPARTS_ALL, i)) {
      body.push({
        type: i,
        hits: 100,
      });
    }

    if (i === C.CARRY) storeCapacity += C.CARRY_CAPACITY;
  });

  const creep: Omit<RoomObject, '_id'> = {
    name: intent.name as string,
    x: spawn.x,
    y: spawn.y,
    body,
    store: { energy: 0 },
    storeCapacity,
    type: 'creep',
    room: spawn.room,
    user: spawn.user,
    hits: body.length * 100,
    hitsMax: body.length * 100,
    spawning: true,
    fatigue: 0,
    notifyWhenAttacked: true,
  };

  if (spawn.tutorial) {
    creep.tutorial = true;
  }

  bulk.insert(creep);
}
