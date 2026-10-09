/*
 * Port of screeps/engine `processor/intents/power-spawns/process-power.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { checkStructureAgainstController } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { powerEffect } from '../../support.ts';

export function processPower(object: RoomObject, intent: IntentArgs<'processPower'>, scope: RoomScope): void {
    void intent;
    const { roomObjects, bulk, bulkUsers, roomController, stats, gameTime } = scope;

    if (object.type != 'powerSpawn' || !object.store) return;
    const store = object.store;

    if (!checkStructureAgainstController(object, roomObjects, roomController)) {
        return;
    }

    let amount = 1;
    const effect = object.effects?.find((e) => e.power === C.PWR_OPERATE_POWER);
    if (effect && effect.endTime >= gameTime) {
        amount = Math.min(store.power as number, amount + powerEffect(C.PWR_OPERATE_POWER, effect.level));
    }

    if ((store.power as number) < amount || (store.energy as number) < amount * C.POWER_SPAWN_ENERGY_RATIO) {
        return;
    }

    store.power = (store.power as number) - amount;
    store.energy = (store.energy as number) - amount * C.POWER_SPAWN_ENERGY_RATIO;

    stats.inc('powerProcessed', object.user, amount);

    bulk.update(object, {
        store: {
            energy: store.energy,
            power: store.power,
        },
    });

    bulkUsers.inc(object.user, 'power', amount);
}
