/*
 * Port of screeps/engine `processor/intents/creeps/transfer.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources, capacityForResource } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ResourceType, RoomObject, Store, StoreCapacityResource } from '../../state.ts';
import { contains } from '../../support.ts';

function isResourceType(value: string | undefined): value is ResourceType {
  return value !== undefined && contains(C.RESOURCES_ALL, value);
}

export function creepTransfer(
  object: RoomObject,
  intent: IntentArgs<'transfer'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk, eventLog } = scope;

  const resourceType = intent.resourceType;
  if (!isResourceType(resourceType)) {
    return;
  }
  const intentAmount = intent.amount as number;
  if (
    object.spawning ||
    !object.store ||
    !((object.store[resourceType] as number) >= intentAmount) ||
    intentAmount < 0
  ) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || (target.type === 'creep' && target.spawning)) {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }

  const targetCapacity = capacityForResource(target, resourceType);

  if (!targetCapacity) {
    return;
  }

  let amount = intentAmount;

  const targetStore = target.store as Store;
  const storedAmount = (
    target.storeCapacityResource ? targetStore[resourceType] : calcResources(target)
  ) as number;

  if (storedAmount >= targetCapacity) {
    return;
  }
  if (storedAmount + amount > targetCapacity) {
    amount = targetCapacity - storedAmount;
  }

  if (!amount) {
    return;
  }

  targetStore[resourceType] = (targetStore[resourceType] || 0) + amount;
  bulk.update(target, { store: { [resourceType]: targetStore[resourceType] } });

  object.store[resourceType] = (object.store[resourceType] as number) - amount;
  bulk.update(object, { store: { [resourceType]: object.store[resourceType] } });

  if (
    target.type === 'lab' &&
    resourceType !== 'energy' &&
    !(target.storeCapacityResource as StoreCapacityResource)[resourceType]
  ) {
    bulk.update(target, {
      storeCapacityResource: { [resourceType]: C.LAB_MINERAL_CAPACITY },
      storeCapacity: null,
    });
  }

  eventLog.push({
    event: C.EVENT_TRANSFER,
    objectId: object._id,
    data: { targetId: target._id, resourceType, amount },
  });
}
