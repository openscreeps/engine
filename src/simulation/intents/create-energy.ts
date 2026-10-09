/*
 * Port of screeps/engine `processor/intents/_create-energy.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { calcResources } from '../../utils/index.ts';
import type { RoomScope } from '../scope.ts';
import type { ResourceType, RoomObject } from '../state.ts';

/** Drops resources at a tile: fills a container there first, then stacks onto or creates a drop. */
export function createEnergy(
  x: number,
  y: number,
  room: string,
  rawAmount: number,
  resourceTypeArg: string | undefined,
  scope: RoomScope,
): void {
  const { roomObjects, bulk } = scope;
  const resourceType = (resourceTypeArg || 'energy') as ResourceType;
  let amount = Math.round(rawAmount);
  if (amount <= 0) {
    return;
  }

  const container = Object.values(roomObjects).find(
    (i) => i.type === 'container' && i.x === x && i.y === y,
  );
  if (container && (container.hits ?? 0) > 0) {
    container.store = container.store || {};
    const targetTotal = calcResources(container);
    const toContainerAmount = Math.min(amount, (container.storeCapacity ?? 0) - targetTotal);
    if (toContainerAmount > 0) {
      container.store[resourceType] = (container.store[resourceType] || 0) + toContainerAmount;
      bulk.update(container, { store: { [resourceType]: container.store[resourceType] } });
      amount -= toContainerAmount;
    }
  }

  if (amount > 0) {
    const existingDrop = Object.values(roomObjects).find(
      (i) => i.type === 'energy' && i.x === x && i.y === y && i.resourceType === resourceType,
    );
    if (existingDrop) {
      bulk.update(existingDrop, { [resourceType]: (existingDrop[resourceType] ?? NaN) + amount });
    } else {
      const obj: RoomObject = {
        _id: '',
        type: 'energy',
        x,
        y,
        room,
        [resourceType]: amount,
        resourceType,
      };
      obj._id = String(bulk.insert(obj));
      roomObjects[obj._id] = obj;
    }
  }
}
