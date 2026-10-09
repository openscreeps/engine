/*
 * Port of screeps/engine `processor/intents/creeps/repair.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';

export function creepRepair(
  object: RoomObject,
  intent: IntentArgs<'repair'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, stats, eventLog } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning || !object.store || (object.store.energy as number) <= 0) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (
    !target ||
    !target.hitsMax ||
    !lookup<number>(C.CONSTRUCTION_COST, target.type) ||
    (target.hits as number) >= target.hitsMax
  ) {
    return;
  }
  if (Math.abs(target.x - object.x) > 3 || Math.abs(target.y - object.y) > 3) {
    return;
  }

  const body = object.body ?? [];
  const energy = object.store.energy as number;
  const repairPower =
    body.filter((i) => (i.hits > 0 || (i._oldHits as number) > 0) && i.type === C.WORK).length *
      C.REPAIR_POWER || 0;
  const repairEnergyRemaining = energy / C.REPAIR_COST;
  const repairHitsMax = target.hitsMax - (target.hits as number);
  const repairEffect = Math.min(repairPower, repairEnergyRemaining, repairHitsMax);
  const repairCost = Math.min(energy, Math.ceil(repairEffect * C.REPAIR_COST));
  let boostedParts = body.map((i) => {
    if (i.type === C.WORK && i.boost) {
      const boost = lookup<Readonly<Record<string, number>>>(C.BOOSTS[C.WORK], i.boost) as Readonly<
        Record<string, number>
      >;
      if ((boost.repair as number) > 0) {
        return ((boost.repair as number) - 1) * C.REPAIR_POWER;
      }
    }
    return 0;
  });

  boostedParts.sort((a, b) => b - a);
  boostedParts = boostedParts.slice(0, repairEffect);

  const boostedEffect = Math.min(
    Math.floor(repairEffect + boostedParts.reduce((s, v) => s + v, 0)),
    repairHitsMax,
  );

  if (!boostedEffect) {
    return;
  }

  target.hits = (target.hits as number) + boostedEffect;
  object.store.energy = energy - repairCost;

  stats.inc('energyConstruction', object.user, repairCost);

  if (target.hits > target.hitsMax) {
    target.hits = target.hitsMax;
  }

  (object.actionLog as ActionLog).repair = { x: target.x, y: target.y };

  bulk.update(target, { hits: target.hits });
  bulk.update(object, { store: { energy: object.store.energy } });

  eventLog.push({
    event: C.EVENT_REPAIR,
    objectId: object._id,
    data: {
      targetId: target._id,
      amount: boostedEffect,
      energySpent: repairCost,
    },
  });
}
