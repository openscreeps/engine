/*
 * Ruin (screeps/engine `src/game/ruins.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import { RoomObject } from './room-object.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';
import { OwnedStructure, Structure } from './structures.ts';

export class Ruin extends RoomObject {
    declare id: string;
    declare readonly structureType: string | undefined;
    declare readonly destroyTime: number | undefined;
    declare readonly ticksToDecay: number;
    declare readonly store: Store;
    declare readonly structure: Structure;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[ruin (${String(this.structure.structureType)}) #${this.id}]`;
    }
}

finalizeClass(Ruin);

defineGameObjectProperties<Ruin, RawRoomObject>(Ruin.prototype, rawObject, {
    structureType: (o) => o.structureType,
    destroyTime: (o) => o.destroyTime,
    // upstream `undefined - time` is NaN for non-numeric decay data
    ticksToDecay: (o) => (typeof o.decayTime === 'number' ? o.decayTime : NaN) - scope().runtimeData.time,
    store: (o) => new Store(o),
    structure: (o) => {
        const info = o.structure;
        if (!info) {
            throw new TypeError("Cannot read properties of undefined (reading 'user')");
        }
        const { runtimeData } = scope();
        const owner = info.user;
        if (owner) {
            const structure = new OwnedStructure();
            Object.defineProperties(structure, {
                id: { enumerable: true, get: () => info.id },
                hits: { enumerable: true, get: () => info.hits },
                hitsMax: { enumerable: true, get: () => info.hitsMax },
                structureType: { enumerable: true, get: () => info.type },
                owner: { enumerable: true, get: () => ({ username: username(owner) }) },
                my: { enumerable: true, get: () => owner == runtimeData.user._id },
            });
            return structure;
        }

        const structure = new Structure();
        Object.defineProperties(structure, {
            id: { enumerable: true, get: () => info.id },
            hits: { enumerable: true, get: () => info.hits },
            hitsMax: { enumerable: true, get: () => info.hitsMax },
            structureType: { enumerable: true, get: () => info.type },
        });
        return structure;
    },
});

export function make(): void {
    if (scope().globals.Ruin) {
        return;
    }
    exposeGlobal('Ruin', Ruin);
}
