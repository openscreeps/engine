/*
 * Port of screeps/engine `processor/intents/invader-core/transfer.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject, Store, StoreCapacityResource } from '../../state.ts';

export function invaderCoreTransfer(
  object: RoomObject,
  intent: IntentArgs<'transfer'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, eventLog } = scope;
  if (object.type !== 'invaderCore') {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target) {
    return;
  }

  if (!['tower', 'creep'].includes(target.type)) {
    return;
  }
  const store = target.store as Store;
  const targetTotal = target.type === 'creep' ? calcResources(target) : (store.energy as number);
  const targetCapacity = (target.storeCapacity ||
    (target.storeCapacityResource as StoreCapacityResource).energy) as number;
  if (targetTotal === targetCapacity) {
    return;
  }

  let amount = intent.amount as number;
  if (targetTotal + amount > targetCapacity) {
    amount = targetCapacity - targetTotal;
  }

  store.energy = (store.energy as number) + amount;

  const actionLog = object.actionLog as ActionLog;
  actionLog.transferEnergy = { x: target.x, y: target.y };

  bulk.update(object, { actionLog });
  bulk.update(target, { store: { energy: store.energy } });

  eventLog.push({
    event: C.EVENT_TRANSFER,
    objectId: object._id,
    data: { targetId: target._id, resourceType: C.RESOURCE_ENERGY, amount },
  });
}
