/*
 * Port of screeps/engine `processor/intents/energy/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { BulkPatch } from '../../bulk.ts';
import type { RoomScope } from '../../scope.ts';
import type { ResourceType, RoomObject } from '../../state.ts';

export function tickEnergy(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk } = scope;

    if (object.type != 'energy') return;

    const resourceType = (object.resourceType || 'energy') as ResourceType;

    const current = object[resourceType] as number;
    const amount = current - Math.ceil(current / C.ENERGY_DECAY);
    object[resourceType] = amount;

    if (amount <= 0 || !amount) {
        if (Number.isNaN(amount)) {
            console.log('Energy NaN: dropped');
        }
        bulk.remove(object._id);
        delete roomObjects[object._id];
    } else {
        const patch: BulkPatch<RoomObject> = {};
        patch[resourceType] = amount;
        bulk.update(object, patch);
    }
}
