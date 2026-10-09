/*
 * Port of screeps/engine `processor/intents/links/transfer.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkStructureAgainstController } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject, Store, StoreCapacityResource } from '../../state.ts';

export function linkTransfer(object: RoomObject, intent: IntentArgs<'transfer'>, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, eventLog } = scope;

    if (object.type != 'link') {
        return;
    }

    const intentAmount = intent.amount as number;
    if (!object.store || (object.store.energy as number) < intentAmount || intentAmount < 0) {
        return;
    }
    const store = object.store;

    const target = roomObjects[String(intent.id)];
    if (!target) {
        return;
    }

    if (target.type != 'link') {
        return;
    }
    let amount = intentAmount;

    if ((object.cooldown as number) > 0) {
        return;
    }
    if (!checkStructureAgainstController(object, roomObjects, roomController)) {
        return;
    }
    const targetStore = target.store as Store;
    const targetTotal = targetStore.energy as number;

    if (!target.storeCapacityResource || !target.storeCapacityResource.energy || targetTotal == target.storeCapacityResource.energy) {
        return;
    }
    const capacity = (target.storeCapacityResource as StoreCapacityResource).energy as number;

    if (targetTotal + amount > capacity) {
        amount = capacity - targetTotal;
    }
    targetStore.energy = (targetStore.energy as number) + amount;

    store.energy = (store.energy as number) - amount;

    targetStore.energy -= Math.ceil(amount * C.LINK_LOSS_RATIO);
    object.cooldown = (object.cooldown as number) + C.LINK_COOLDOWN * Math.max(Math.abs(target.x - object.x), Math.abs(target.y - object.y));
    (object.actionLog as ActionLog).transferEnergy = { x: target.x, y: target.y };
    bulk.update(target, { store: { energy: targetStore.energy } });

    bulk.update(object, { store: { energy: store.energy }, cooldown: object.cooldown, actionLog: object.actionLog });

    eventLog.push({ event: C.EVENT_TRANSFER, objectId: object._id, data: { targetId: target._id, resourceType: C.RESOURCE_ENERGY, amount } });
}
