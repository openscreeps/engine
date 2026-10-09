/*
 * Port of screeps/engine `processor/intents/creeps/harvest.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import {
  calcBodyEffectiveness,
  calcResources,
  checkStructureAgainstController,
} from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject, Store } from '../../state.ts';
import { drop } from './drop.ts';

export function creepHarvest(
  object: RoomObject,
  intent: IntentArgs<'harvest'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, roomController, stats, eventLog, gameTime } = scope;

  if (object.type !== 'creep') {
    return;
  }
  if (object.spawning) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target) {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }
  const body = object.body ?? [];

  if (target.type === 'source') {
    if (!target.energy) {
      return;
    }

    if (
      roomController &&
      ((roomController.user && roomController.user !== object.user) ||
        (roomController.reservation && roomController.reservation.user !== object.user))
    ) {
      return;
    }

    const harvestAmount = calcBodyEffectiveness(body, C.WORK, 'harvest', C.HARVEST_POWER);

    if (harvestAmount) {
      const amount = Math.min(target.energy, harvestAmount);

      target.energy -= amount;
      object.store = object.store || {};
      object.store.energy = (object.store.energy || 0) + amount;

      const invaderHarvested = (target.invaderHarvested || 0) + amount;

      bulk.update(object, { store: { energy: object.store.energy } });
      bulk.update(target, { energy: target.energy, invaderHarvested });

      const sum = calcResources(object);

      if (sum > (object.storeCapacity as number)) {
        drop(
          object,
          {
            amount: Math.min(object.store.energy, sum - (object.storeCapacity as number)),
            resourceType: 'energy',
          },
          scope,
        );
      }

      (object.actionLog as ActionLog).harvest = { x: target.x, y: target.y };

      stats.inc('energyHarvested', object.user, amount);

      eventLog.push({
        event: C.EVENT_HARVEST,
        objectId: object._id,
        data: { targetId: target._id, amount },
      });
    }
  }

  if (target.type === 'mineral') {
    if (!target.mineralAmount) {
      return;
    }

    const extractor = Object.values(roomObjects).find(
      (i) => i.type === C.STRUCTURE_EXTRACTOR && i.x === target.x && i.y === target.y,
    );

    if (!extractor) {
      return;
    }
    if (extractor.user && extractor.user !== object.user) {
      return;
    }
    if (!checkStructureAgainstController(extractor, roomObjects, roomController)) {
      return;
    }
    if (extractor.cooldown) {
      return;
    }

    const harvestAmount = calcBodyEffectiveness(body, C.WORK, 'harvest', C.HARVEST_MINERAL_POWER);

    if (harvestAmount) {
      const amount = Math.min(target.mineralAmount, harvestAmount);
      const mineralType = target.mineralType as string;
      object.store = object.store || {};
      bulk.update(target, { mineralAmount: target.mineralAmount - amount });
      bulk.update(object, { store: { [mineralType]: (object.store[mineralType] || 0) + amount } });

      const sum = calcResources(object);

      if (sum > (object.storeCapacity as number)) {
        drop(
          object,
          {
            amount: Math.min(
              object.store[mineralType] as number,
              sum - (object.storeCapacity as number),
            ),
            resourceType: mineralType,
          },
          scope,
        );
      }

      (object.actionLog as ActionLog).harvest = { x: target.x, y: target.y };

      extractor._cooldown = C.EXTRACTOR_COOLDOWN;

      eventLog.push({
        event: C.EVENT_HARVEST,
        objectId: object._id,
        data: { targetId: target._id, amount: harvestAmount },
      });
    }
  }

  if (target.type === 'deposit') {
    if (target.cooldownTime && target.cooldownTime > gameTime) {
      return;
    }

    const depositType = target.depositType as string;
    const amount = calcBodyEffectiveness(body, C.WORK, 'harvest', C.HARVEST_DEPOSIT_POWER);
    bulk.update(object, {
      store: { [depositType]: ((object.store as Store)[depositType] || 0) + amount },
    });

    const sum = calcResources(object);

    if (sum > (object.storeCapacity as number)) {
      drop(
        object,
        {
          amount: Math.min(
            (object.store as Store)[depositType] as number,
            sum - (object.storeCapacity as number),
          ),
          resourceType: depositType,
        },
        scope,
      );
    }

    (object.actionLog as ActionLog).harvest = { x: target.x, y: target.y };

    bulk.inc(target, 'harvested', amount);
    const cooldown = Math.ceil(
      C.DEPOSIT_EXHAUST_MULTIPLY * Math.pow(target.harvested as number, C.DEPOSIT_EXHAUST_POW),
    );
    if (cooldown > 1) {
      target._cooldown = cooldown;
    }
    bulk.update(target, { decayTime: C.DEPOSIT_DECAY_TIME + gameTime });
  }
}
