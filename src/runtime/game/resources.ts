/*
 * Resource, a dropped resource pile (screeps/engine `src/game/resources.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

export class Resource extends RoomObject {
    declare id: string;
    declare readonly energy: number | undefined;
    declare readonly amount: number | undefined;
    declare readonly resourceType: string;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[resource (${this.resourceType}) #${this.id}]`;
    }
}

finalizeClass(Resource);

defineGameObjectProperties<Resource, RawRoomObject>(Resource.prototype, rawObject, {
    energy: (o) => o.energy,
    amount: (o) => Reflect.get(o, o.resourceType || C.RESOURCE_ENERGY) as number | undefined,
    resourceType: (o) => o.resourceType || C.RESOURCE_ENERGY,
});

export function make(): void {
    if (scope().globals.Resource) {
        return;
    }
    exposeGlobal('Resource', Resource);
    exposeGlobal('Energy', Resource);
}
