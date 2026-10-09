/*
 * Mineral, a mineral deposit (screeps/engine `src/game/minerals.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

export class Mineral extends RoomObject {
    declare id: string;
    declare readonly mineralType: string | undefined;
    declare readonly mineralAmount: number | undefined;
    declare readonly density: number | undefined;
    declare readonly ticksToRegeneration: number | undefined;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[mineral (${String(this.mineralType)}) #${this.id}]`;
    }
}

finalizeClass(Mineral);

defineGameObjectProperties<Mineral, RawRoomObject>(Mineral.prototype, rawObject, {
    mineralType: (o) => o.mineralType,
    mineralAmount: (o) => o.mineralAmount,
    density: (o) => o.density,
    ticksToRegeneration: (o) => (o.nextRegenerationTime ? o.nextRegenerationTime - scope().runtimeData.time : undefined),
});

export function make(): void {
    if (scope().globals.Mineral) {
        return;
    }
    exposeGlobal('Mineral', Mineral);
}
