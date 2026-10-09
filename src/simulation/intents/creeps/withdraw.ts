/*
 * Port of screeps/engine `processor/intents/creeps/withdraw.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, Store } from '../../state.ts';
import { contains } from '../../support.ts';

export function creepWithdraw(object: RoomObject, intent: IntentArgs<'withdraw'>, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime, eventLog } = scope;

    const resourceType = intent.resourceType;
    if (resourceType === undefined || !contains(C.RESOURCES_ALL, resourceType)) {
        return;
    }

    const emptySpace = (object.storeCapacity as number) - calcResources(object);
    let amount = Math.min(intent.amount as number, emptySpace);

    if (object.spawning || !object.storeCapacity || amount < 0) {
        return;
    }
    if (roomController && roomController.user !== object.user && (roomController.safeMode as number) > gameTime) {
        return;
    }
    const target = roomObjects[intent.id as string];
    if (!target) {
        return;
    }
    if (
        object.user !== target.user &&
        Object.values(roomObjects).some(
            (i) =>
                i.type === C.STRUCTURE_RAMPART &&
                i.user !== object.user &&
                !i.isPublic &&
                i.x === target.x &&
                i.y === target.y,
        )
    ) {
        return;
    }
    if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
        return;
    }

    if (target.type === 'nuker' || target.type === 'powerBank') {
        return;
    }

    if (target.type === 'terminal') {
        const effect = (target.effects ?? []).find((e) => e.power === C.PWR_DISRUPT_TERMINAL);
        if (effect && effect.endTime > gameTime) {
            return;
        }
    }

    const targetStore = target.store as Store;
    if (amount > (targetStore[resourceType] as number)) {
        amount = targetStore[resourceType] as number;
    }

    const objectStore = object.store as Store;
    objectStore[resourceType] = (objectStore[resourceType] || 0) + amount;
    bulk.update(object, { store: { [resourceType]: objectStore[resourceType] } });

    targetStore[resourceType] = (targetStore[resourceType] as number) - amount;
    bulk.update(target, { store: { [resourceType]: targetStore[resourceType] } });
    if (target.type === 'lab' && resourceType !== 'energy' && !targetStore[resourceType]) {
        bulk.update(target, {
            storeCapacityResource: { [resourceType]: null },
            storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
        });
    }

    eventLog.push({
        event: C.EVENT_TRANSFER,
        objectId: target._id,
        data: { targetId: object._id, resourceType, amount },
    });
}
