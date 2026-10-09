/*
 * Port of screeps/engine `processor/intents/spawns/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { comparatorDistance } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject, SpawningInfo, Store } from '../../state.ts';
import { lookup, effectList } from '../../support.ts';
import { bornCreep } from './born-creep.ts';

export function tickSpawn(object: RoomObject, scope: RoomScope): void {
  const { roomObjects, bulk, roomController, energyAvailable, gameTime } = scope;

  if (object.type !== 'spawn') return;

  if (object.spawning) {
    const spawning = object.spawning as SpawningInfo;
    const effect = effectList(object.effects).find((e) => e.power === C.PWR_DISRUPT_SPAWN);
    if (effect && effect.endTime > gameTime) {
      bulk.update(object, { spawning: { spawnTime: 1 + spawning.spawnTime } });
    } else {
      if (gameTime >= spawning.spawnTime - 1) {
        const spawningCreep = Object.values(roomObjects).find(
          (i) =>
            i.type === 'creep' && i.name === spawning.name && i.x === object.x && i.y === object.y,
        );

        const bornOk = bornCreep(object, spawningCreep, scope);

        if (bornOk) {
          bulk.update(object, { spawning: null });
        } else {
          bulk.update(object, { spawning: { spawnTime: 1 + gameTime } });
        }
      }
    }
  }

  if (
    !roomController ||
    (roomController.level as number) < 1 ||
    roomController.user !== object.user
  ) {
    return;
  }
  let spawns = Object.values(roomObjects).filter((i) => i.type === 'spawn');
  const allowed = lookup<number>(C.CONTROLLER_STRUCTURES.spawn, roomController.level) as number;
  if (spawns.length > allowed) {
    spawns.sort(comparatorDistance(roomController));
    spawns = spawns.slice(0, allowed);
    if (!spawns.includes(object)) {
      return;
    }
  }

  const store = object.store as Store;
  if (
    !object.tutorial &&
    energyAvailable < C.SPAWN_ENERGY_CAPACITY &&
    (store.energy as number) < C.SPAWN_ENERGY_CAPACITY
  ) {
    store.energy = (store.energy as number) + 1;
    bulk.update(object, { store: { energy: store.energy } });
  }
}
