/*
 * Port of screeps/engine `processor/intents/minerals/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { BulkPatch } from '../../bulk.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup, powerEffect, powerInfo, type PowerInfoEntry } from '../../support.ts';

export function tickMineral(object: RoomObject, scope: RoomScope): void {
    const { bulk, gameTime, env } = scope;

    if (!object.mineralAmount) {
        if (!object.nextRegenerationTime) {
            object.nextRegenerationTime = gameTime + C.MINERAL_REGEN_TIME;
            bulk.update(object, { nextRegenerationTime: object.nextRegenerationTime });
        }
        if (gameTime >= object.nextRegenerationTime - 1) {
            const update: BulkPatch<RoomObject> = {
                nextRegenerationTime: null,
                mineralAmount: lookup<number>(C.MINERAL_DENSITY, object.density),
            };
            if (object.density == C.DENSITY_LOW || object.density == C.DENSITY_ULTRA || env.random() < C.MINERAL_DENSITY_CHANGE) {
                const oldDensity = object.density;
                let newDensity: number | undefined;
                do {
                    const random = env.random();
                    for (const density of Object.keys(C.MINERAL_DENSITY_PROBABILITY)) {
                        if (random <= (lookup<number>(C.MINERAL_DENSITY_PROBABILITY, density) as number)) {
                            newDensity = +density;
                            break;
                        }
                    }
                } while (newDensity == oldDensity);

                update.density = object.density = newDensity as number;
            }
            bulk.update(object, update);
        }
    }

    const effect = object.effects?.find((e) => e.power === C.PWR_REGEN_MINERAL);
    if (effect && effect.endTime > gameTime && !object.nextRegenerationTime && object.mineralAmount) {
        const info = powerInfo(C.PWR_REGEN_MINERAL) as PowerInfoEntry;
        if ((effect.endTime - gameTime - 1) % (info.period as number) === 0) {
            bulk.update(object, {
                mineralAmount: object.mineralAmount + powerEffect(C.PWR_REGEN_MINERAL, effect.level),
            });
        }
    }
}
