/*
 * Port of screeps/engine `processor/intents/towers/repair.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';
import { towerActionAmount } from './attack.ts';

export function towerRepair(object: RoomObject, intent: IntentArgs<'repair'>, scope: RoomScope): void {
    const { roomObjects, bulk, stats, eventLog, gameTime } = scope;

    if (object.type != 'tower' || !object.store) {
        return;
    }
    const store = object.store;

    const target = roomObjects[String(intent.id)];
    if (!target || !lookup<number>(C.CONSTRUCTION_COST, target.type) || (target.hits as number) >= (target.hitsMax as number)) {
        return;
    }
    if ((store.energy as number) < C.TOWER_ENERGY_COST) {
        return;
    }

    const amount = towerActionAmount(object, target, C.TOWER_POWER_REPAIR, gameTime);

    if (!amount) {
        return;
    }

    target.hits = (target.hits as number) + amount;
    if (target.hits > (target.hitsMax as number)) {
        target.hits = target.hitsMax as number;
    }
    bulk.update(target, { hits: target.hits });

    store.energy = (store.energy as number) - C.TOWER_ENERGY_COST;
    (object.actionLog as ActionLog).repair = { x: target.x, y: target.y };
    bulk.update(object, { store: { energy: store.energy } });

    stats.inc('energyConstruction', object.user, C.TOWER_ENERGY_COST);

    eventLog.push({
        event: C.EVENT_REPAIR,
        objectId: object._id,
        data: {
            targetId: target._id,
            amount,
            energySpent: C.TOWER_ENERGY_COST,
        },
    });
}
