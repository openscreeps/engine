/*
 * Port of screeps/engine `processor/intents/towers/heal.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { towerActionAmount } from './attack.ts';

export function towerHeal(object: RoomObject, intent: IntentArgs<'heal'>, scope: RoomScope): void {
    const { roomObjects, bulk, eventLog, gameTime } = scope;

    if (object.type != 'tower' || !object.store) {
        return;
    }
    const store = object.store;

    const target = roomObjects[String(intent.id)];
    if (!target || (target.type != 'creep' && target.type !== 'powerCreep')) {
        return;
    }
    if (target.spawning) {
        return;
    }
    if ((store.energy as number) < C.TOWER_ENERGY_COST) {
        return;
    }

    const amount = towerActionAmount(object, target, C.TOWER_POWER_HEAL, gameTime);

    if (!amount) {
        return;
    }

    target._healToApply = (target._healToApply || 0) + amount;

    store.energy = (store.energy as number) - C.TOWER_ENERGY_COST;
    bulk.update(object, { store: { energy: store.energy } });

    (object.actionLog as ActionLog).heal = { x: target.x, y: target.y };
    (target.actionLog as ActionLog).healed = { x: object.x, y: object.y };

    eventLog.push({ event: C.EVENT_HEAL, objectId: object._id, data: { targetId: target._id, amount, healType: C.EVENT_HEAL_TYPE_RANGED } });
}
