/*
 * Port of screeps/engine `processor/intents/creeps/pickup.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { calcResources } from '../../../utils/index.ts';
import type { BulkPatch } from '../../bulk.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ResourceType, RoomObject } from '../../state.ts';

export function creepPickup(
  object: RoomObject,
  intent: IntentArgs<'pickup'>,
  scope: RoomScope,
): void {
  const { roomObjects, bulk } = scope;

  object.store = object.store || {};
  const carry = calcResources(object);

  if (object.spawning || carry >= (object.storeCapacity as number)) {
    return;
  }

  const target = roomObjects[intent.id as string];
  if (!target || target.type !== 'energy') {
    return;
  }
  if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
    return;
  }

  const resourceType = (target.resourceType || 'energy') as ResourceType;

  const amount = Math.min((object.storeCapacity as number) - carry, target[resourceType] as number);

  target[resourceType] = (target[resourceType] as number) - amount;
  object.store[resourceType] = (object.store[resourceType] || 0) + amount;

  if (!target[resourceType]) {
    bulk.remove(target._id);
    Reflect.deleteProperty(roomObjects, target._id);
  } else {
    const patch: BulkPatch<RoomObject> = {};
    patch[resourceType] = target[resourceType];
    bulk.update(target, patch);
  }

  bulk.update(object, { store: { [resourceType]: object.store[resourceType] } });
}
