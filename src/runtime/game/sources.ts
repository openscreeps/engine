/*
 * Source, an energy source (screeps/engine `src/game/sources.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

export class Source extends RoomObject {
    declare id: string;
    declare readonly energy: number | undefined;
    declare readonly energyCapacity: number | undefined;
    declare readonly ticksToRegeneration: number | undefined;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[source #${this.id}]`;
    }
}

finalizeClass(Source);

defineGameObjectProperties<Source, RawRoomObject>(Source.prototype, rawObject, {
    energy: (o) => o.energy,
    energyCapacity: (o) => o.energyCapacity,
    ticksToRegeneration: (o) => (o.nextRegenerationTime ? o.nextRegenerationTime - scope().runtimeData.time : undefined),
});

export function make(): void {
    if (scope().globals.Source) {
        return;
    }
    exposeGlobal('Source', Source);
}
