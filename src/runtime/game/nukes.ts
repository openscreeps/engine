/*
 * Nuke, a launched nuke in flight (screeps/engine `src/game/nukes.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

export class Nuke extends RoomObject {
    declare id: string;
    declare readonly timeToLand: number;
    declare readonly launchRoomName: string | undefined;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[nuke #${this.id}]`;
    }
}

finalizeClass(Nuke);

defineGameObjectProperties<Nuke, RawRoomObject>(Nuke.prototype, rawObject, {
    // upstream `undefined - time` is NaN when `landTime` is missing
    timeToLand: (o) => (o.landTime ?? NaN) - scope().runtimeData.time,
    launchRoomName: (o) => o.launchRoomName,
});

export function make(): void {
    if (scope().globals.Nuke) {
        return;
    }
    exposeGlobal('Nuke', Nuke);
}
