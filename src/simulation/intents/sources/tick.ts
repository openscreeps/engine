/*
 * Port of screeps/engine `processor/intents/sources/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { powerEffect, powerInfo, type PowerInfoEntry } from '../../support.ts';

export function tickSource(object: RoomObject, scope: RoomScope): void {
    const { bulk, roomController, gameTime } = scope;

    if (object.type != 'source') return;

    if ((object.energy as number) < (object.energyCapacity as number)) {
        if (!object.nextRegenerationTime) {
            object.nextRegenerationTime = gameTime + C.ENERGY_REGEN_TIME;
            bulk.update(object, { nextRegenerationTime: object.nextRegenerationTime });
        }

        let effect = object.effects?.find((e) => e.power === C.PWR_DISRUPT_SOURCE);
        if (effect && effect.endTime > gameTime) {
            bulk.update(object, {
                nextRegenerationTime: (object.nextRegenerationTime as number) + 1,
            });
        }

        if (gameTime >= (object.nextRegenerationTime as number) - 1) {
            bulk.update(object, {
                nextRegenerationTime: null,
                energy: object.energyCapacity,
            });
        }

        effect = object.effects?.find((e) => e.power === C.PWR_REGEN_SOURCE);
        if (effect && effect.endTime > gameTime) {
            const info = powerInfo(C.PWR_REGEN_SOURCE) as PowerInfoEntry;
            if ((effect.endTime - gameTime - 1) % (info.period as number) === 0) {
                bulk.update(object, {
                    energy: Math.min(
                        object.energyCapacity as number,
                        (object.energy as number) + powerEffect(C.PWR_REGEN_SOURCE, effect.level),
                    ),
                });
            }
        }
    }

    if (roomController) {
        if (!roomController.user && !roomController.reservation && object.energyCapacity != C.SOURCE_ENERGY_NEUTRAL_CAPACITY) {
            bulk.update(object, {
                energyCapacity: C.SOURCE_ENERGY_NEUTRAL_CAPACITY,
                energy: Math.min(object.energy as number, C.SOURCE_ENERGY_NEUTRAL_CAPACITY),
            });
        }
        if ((roomController.user || roomController.reservation) && object.energyCapacity != C.SOURCE_ENERGY_CAPACITY) {
            bulk.update(object, { energyCapacity: C.SOURCE_ENERGY_CAPACITY });
        }
    } else if (object.energyCapacity != C.SOURCE_ENERGY_KEEPER_CAPACITY) {
        bulk.update(object, { energyCapacity: C.SOURCE_ENERGY_KEEPER_CAPACITY });
    }
}
