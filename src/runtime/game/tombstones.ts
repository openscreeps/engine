/*
 * Tombstone (screeps/engine `src/game/tombstones.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { Creep } from './creeps.ts';
import { defineGameObjectProperties, exposeGlobal, finalizeClass } from './define.ts';
import { PowerCreep } from './power-creeps.ts';
import { RoomObject } from './room-object.ts';
import { RoomPosition } from './room-position.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';

/** Upstream `RoomObject.call(obj, x, y, room)` on an id-less instance (no effects). */
function placeRoomObject(target: RoomObject, o: RawRoomObject): void {
    target.room = scope().register.rooms[o.room];
    target.pos = new RoomPosition(o.x, o.y, o.room);
}

/** Upstream `_storeGetter` used as a getter: an empty store sized by the pseudo creep's carry capacity. */
function emptyStoreGetter(this: { readonly carryCapacity: unknown }): Store {
    const capacity = this.carryCapacity;
    return new Store({ store: {}, storeCapacity: typeof capacity === 'number' ? capacity : null });
}

function ownerOf(o: RawRoomObject): { username: string } | undefined {
    return o.user === undefined || o.user === null ? undefined : { username: username(o.user) };
}

export class Tombstone extends RoomObject {
    declare id: string;
    declare readonly deathTime: number | undefined;
    declare readonly store: Store;
    declare readonly ticksToDecay: number;
    declare readonly creep: Creep | PowerCreep | undefined;

    constructor(id: string) {
        // upstream reads the data unconditionally, so a missing id throws
        const data = rawObject(id);
        super(data.x, data.y, data.room, data.effects);
        this.id = id;
    }

    toString(): string {
        return `[Tombstone #${this.id}]`;
    }
}

finalizeClass(Tombstone);

defineGameObjectProperties<Tombstone, RawRoomObject>(Tombstone.prototype, rawObject, {
    deathTime: (o) => o.deathTime,
    store: (o) => new Store(o),
    // upstream `undefined - time` is NaN for non-numeric decay data
    ticksToDecay: (o) => (typeof o.decayTime === 'number' ? o.decayTime : NaN) - scope().runtimeData.time,
    creep: (o) => {
        const { runtimeData } = scope();
        const body = (): { type: string; hits: number }[] => (o.creepBody ?? []).map((type) => ({ type, hits: 0 }));
        if (o.creepId) {
            const creep = new Creep();
            placeRoomObject(creep, o);
            Object.defineProperties(creep, {
                id: { enumerable: true, get: () => o.creepId },
                name: { enumerable: true, get: () => o.creepName },
                spawning: { enumerable: true, get: () => false },
                my: { enumerable: true, get: () => o.user == runtimeData.user._id },
                body: { enumerable: true, get: body },
                owner: { enumerable: true, get: () => ownerOf(o) },
                ticksToLive: { enumerable: true, get: () => o.creepTicksToLive },
                carryCapacity: {
                    enumerable: true,
                    get: () =>
                        (o.creepBody ?? []).reduce((result, type) => result + (type === C.CARRY ? C.CARRY_CAPACITY : 0), 0),
                },
                carry: { enumerable: true, get: emptyStoreGetter },
                store: { enumerable: true, get: emptyStoreGetter },
                fatigue: { enumerable: true, get: () => 0 },
                hits: { enumerable: true, get: () => 0 },
                hitsMax: {
                    enumerable: true,
                    get: () => {
                        if (!o.creepBody) {
                            throw new TypeError("Cannot read properties of undefined (reading 'length')");
                        }
                        return o.creepBody.length * 100;
                    },
                },
                saying: { enumerable: true, get: () => o.creepSaying },
            });
            return creep;
        }

        if (o.powerCreepId) {
            const powerCreep = new PowerCreep();
            placeRoomObject(powerCreep, o);
            // upstream `undefined * n` is NaN when the level is missing
            const level = o.powerCreepLevel ?? NaN;
            Object.defineProperties(powerCreep, {
                id: { enumerable: true, get: () => o.powerCreepId },
                name: { enumerable: true, get: () => o.powerCreepName },
                className: { enumerable: true, get: () => o.powerCreepClassName },
                level: { enumerable: true, get: () => o.powerCreepLevel },
                my: { enumerable: true, get: () => o.user == runtimeData.user._id },
                body: { enumerable: true, get: body },
                owner: { enumerable: true, get: () => ownerOf(o) },
                ticksToLive: { enumerable: true, get: () => o.powerCreepTicksToLive },
                carryCapacity: { enumerable: true, get: () => level * 100 },
                carry: { enumerable: true, get: emptyStoreGetter },
                store: { enumerable: true, get: emptyStoreGetter },
                hits: { enumerable: true, get: () => 0 },
                hitsMax: { enumerable: true, get: () => level * 1000 },
                saying: { enumerable: true, get: () => o.powerCreepSaying },
                powers: { enumerable: true, get: () => o.powerCreepPowers },
            });
            return powerCreep;
        }
        return undefined;
    },
});

export function make(): void {
    if (scope().globals.Tombstone) {
        return;
    }
    exposeGlobal('Tombstone', Tombstone);
}
