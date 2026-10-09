/*
 * Port of screeps/engine `processor/intents/spawns/_charge-energy.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { comparatorDistance } from '../../../utils/index.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

/** `_.sum` iteratee semantics: non-numeric values count as 0. */
function energyOf(object: RoomObject): number {
  return Number(object.store?.energy) || 0;
}

function oldEnergyHandling(spawn: RoomObject, initialCost: number, scope: RoomScope): boolean {
  const { roomObjects, bulk } = scope;
  let cost = initialCost;
  const spawns = Object.values(roomObjects).filter(
    (i) => i.type === 'spawn' && i.user === spawn.user && !i.off,
  );
  const extensions = Object.values(roomObjects).filter(
    (i) => i.type === 'extension' && i.user === spawn.user && !i.off,
  );
  let availableEnergy = 0;
  for (const i of extensions) availableEnergy += energyOf(i);
  for (const i of spawns) availableEnergy += energyOf(i);

  if (availableEnergy < cost) {
    return false;
  }

  spawns.sort(comparatorDistance(spawn));
  for (const i of spawns) {
    const store = i.store as Record<string, number>;
    const neededEnergy = Math.min(cost, store.energy as number);
    store.energy = (store.energy as number) - neededEnergy;
    cost -= neededEnergy;
    bulk.update(i, { store: { energy: store.energy } });
  }

  if (cost <= 0) {
    return true;
  }

  extensions.sort(comparatorDistance(spawn));
  for (const extension of extensions) {
    if (cost <= 0) {
      continue;
    }
    const store = extension.store as Record<string, number>;
    const neededEnergy = Math.min(cost, store.energy as number);
    store.energy = (store.energy as number) - neededEnergy;
    cost -= neededEnergy;
    bulk.update(extension, { store: { energy: store.energy } });
  }

  return true;
}

function newEnergyHandling(
  spawn: RoomObject,
  initialCost: number,
  energyStructureIds: readonly string[],
  scope: RoomScope,
): boolean {
  const { roomObjects, bulk } = scope;
  let cost = initialCost;
  const ids = [
    ...new Set(
      energyStructureIds.filter((id) => {
        const energyStructure = roomObjects[id];
        return (
          !!energyStructure &&
          !energyStructure.off &&
          energyStructure.user === spawn.user &&
          (energyStructure.type === 'spawn' || energyStructure.type === 'extension')
        );
      }),
    ),
  ];

  let availableEnergy = 0;
  for (const id of ids) availableEnergy += energyOf(roomObjects[id] as RoomObject);
  if (availableEnergy < cost) {
    return false;
  }

  for (const id of ids) {
    const energyStructure = roomObjects[id] as RoomObject;
    const store = energyStructure.store as Record<string, number>;
    const energyChange = Math.min(cost, store.energy as number);
    store.energy = (store.energy as number) - energyChange;
    bulk.update(energyStructure, { store: { energy: store.energy } });
    cost -= energyChange;
    if (cost <= 0) {
      break;
    }
  }

  return true;
}

/** Withdraws spawning energy, either from the given structures in order or the legacy nearest-first order. */
export function chargeEnergy(
  spawn: RoomObject,
  cost: number,
  energyStructures: readonly string[] | undefined,
  scope: RoomScope,
): boolean {
  if (energyStructures === undefined) {
    return oldEnergyHandling(spawn, cost, scope);
  }
  return newEnergyHandling(spawn, cost, energyStructures, scope);
}
