/*
 * Port of screeps/engine `processor/intents/labs/boost-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, BodyPart, RoomObject, Store } from '../../state.ts';
import { lookup } from '../../support.ts';
import { recalcBody } from '../creeps/recalc-body.ts';

function labMineralType(store: Store | undefined): string | undefined {
  if (!store) return undefined;
  return Object.keys(store).find((k) => k != C.RESOURCE_ENERGY && store[k]);
}

export function labBoostCreep(
  object: RoomObject,
  intent: IntentArgs<'boostCreep'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk } = scope;
  if (!object.store) {
    return;
  }
  const store = object.store;

  const mineralType = labMineralType(store);
  if (!mineralType) {
    return;
  }
  if (
    (store[mineralType] as number) < C.LAB_BOOST_MINERAL ||
    (store.energy as number) < C.LAB_BOOST_ENERGY
  ) {
    return;
  }

  const target = roomObjects[String(intent.id)];
  if (!target || target.type != 'creep' || target.spawning) {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }

  let nonBoostedParts = (target.body ?? []).filter((i) => {
    const boosts = lookup<Readonly<Record<string, unknown>>>(C.BOOSTS, i.type);
    return !i.boost && !!boosts && !!lookup(boosts, mineralType);
  });

  if (!nonBoostedParts.length) {
    return;
  }

  if ((nonBoostedParts[0] as BodyPart).type != C.TOUGH) {
    nonBoostedParts.reverse();
  }

  if (intent.bodyPartsCount) {
    nonBoostedParts = nonBoostedParts.slice(0, intent.bodyPartsCount);
  }

  while (
    (store[mineralType] as number) >= C.LAB_BOOST_MINERAL &&
    (store.energy as number) >= C.LAB_BOOST_ENERGY &&
    nonBoostedParts.length
  ) {
    (nonBoostedParts[0] as BodyPart).boost = mineralType;
    store[mineralType] = (store[mineralType] as number) - C.LAB_BOOST_MINERAL;
    store.energy = (store.energy as number) - C.LAB_BOOST_ENERGY;
    nonBoostedParts.splice(0, 1);
  }

  if (store[mineralType]) {
    bulk.update(object, { store: { [mineralType]: store[mineralType], energy: store.energy } });
  } else {
    bulk.update(object, {
      store: { [mineralType]: store[mineralType], energy: store.energy },
      storeCapacityResource: { [mineralType]: null },
      storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
    });
  }

  recalcBody(target);

  bulk.update(target, { body: target.body, storeCapacity: target.storeCapacity });
  (target.actionLog as ActionLog).healed = { x: object.x, y: object.y };
}
