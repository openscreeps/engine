/*
 * Port of screeps/engine `processor/intents/creeps/drop.js` and `_drop-resources-without-space.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { contains } from '../../support.ts';
import { createEnergy } from '../create-energy.ts';

export function drop(object: RoomObject, intent: IntentArgs<'drop'>, scope: RoomScope): void {
    const { bulk } = scope;
    const resourceType = intent.resourceType;
    if (resourceType === undefined || !contains(C.RESOURCES_ALL, resourceType)) {
        return;
    }
    const amount = intent.amount as number;
    if (object.spawning || !object.store || !((object.store[resourceType] as number) >= amount)) {
        return;
    }

    if (amount > 0) {
        object.store[resourceType] = (object.store[resourceType] as number) - amount;
        createEnergy(object.x, object.y, object.room, amount, resourceType, scope);
    }

    bulk.update(object, { store: { [resourceType]: object.store[resourceType] } });
}

/** Drops resources until the creep store fits its (possibly reduced) capacity. */
export function dropResourcesWithoutSpace(object: RoomObject, scope: RoomScope): void {
    for (const resourceType of C.RESOURCES_ALL) {
        const totalAmount = calcResources(object);
        if (totalAmount <= (object.storeCapacity as number)) {
            break;
        }
        const stored = object.store?.[resourceType];
        if (stored) {
            drop(
                object,
                { amount: Math.min(stored, totalAmount - (object.storeCapacity as number)), resourceType },
                scope,
            );
        }
    }
}
