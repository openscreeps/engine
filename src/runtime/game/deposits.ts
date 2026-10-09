/*
 * Deposit, a highway commodity deposit (screeps/engine `src/game/deposits.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

export class Deposit extends RoomObject {
    declare id: string;
    declare readonly depositType: string | undefined;
    declare readonly cooldown: number;
    declare readonly lastCooldown: number;
    declare readonly ticksToDecay: number | undefined;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[deposit (${String(this.depositType)}) #${this.id}]`;
    }
}

finalizeClass(Deposit);

defineGameObjectProperties<Deposit, RawRoomObject>(Deposit.prototype, rawObject, {
    depositType: (o) => o.depositType,
    cooldown: (o) => {
        const time = scope().runtimeData.time;
        return o.cooldownTime && o.cooldownTime > time ? o.cooldownTime - time : 0;
    },
    // upstream Math.pow(undefined) yields NaN when `harvested` is missing
    lastCooldown: (o) => Math.ceil(C.DEPOSIT_EXHAUST_MULTIPLY * Math.pow(o.harvested ?? NaN, C.DEPOSIT_EXHAUST_POW)),
    ticksToDecay: (o) => (typeof o.decayTime === 'number' && o.decayTime ? o.decayTime - scope().runtimeData.time : undefined),
});

export function make(): void {
    if (scope().globals.Deposit) {
        return;
    }
    exposeGlobal('Deposit', Deposit);
}
