/*
 * Tombstone (screeps/engine `src/game/tombstones.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { getProp } from '../../utils/tables.ts';
import { isUndefined, sloppyThis } from './compat.ts';
import { Creep } from './creeps.ts';
import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import { PowerCreep } from './power-creeps.ts';
import { RoomObject } from './room-object.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';

/**
 * Upstream `_storeGetter` installed as an accessor (called without data): an empty store sized by the
 * receiver's `carryCapacity`, read on the sloppy-mode receiver exactly like `this.carryCapacity`.
 */
function emptyStoreGetter(this: unknown): Store {
  // The raw value is forwarded untouched like upstream; the cast only types the stub.
  const storeCapacity = getProp(sloppyThis(this), 'carryCapacity') as number;
  return new Store({ store: {}, storeCapacity });
}

function ownerOf(o: RawRoomObject): { username: string } | undefined {
  return isUndefined(o.user) || o.user === null ? undefined : { username: username(o.user) };
}

class TombstoneImpl extends RoomObject {
  declare id: string;
  declare readonly deathTime: number | undefined;
  declare readonly store: Store;
  declare readonly ticksToDecay: number;
  declare readonly creep: Creep | PowerCreep | undefined;

  override toString(): string {
    return `[Tombstone #${this.id}]`;
  }
}

export type Tombstone = TombstoneImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Tombstone: GameConstructor<Tombstone, [id?: unknown]> = gameConstructor(
  TombstoneImpl,
  function (this: Tombstone, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Tombstone, RawRoomObject>(Tombstone.prototype, rawObject, {
  deathTime: (o) => o.deathTime,
  store: (o) => new Store(o),
  // The casts let TypeScript emit upstream's raw arithmetic (`undefined`/`null` coerce like JS).
  ticksToDecay: (o) => (o.decayTime as number) - scope().runtimeData.time,
  creep: (o) => {
    const body = (): { type: string; hits: number }[] =>
      (o.creepBody ?? []).map((type) => ({ type, hits: 0 }));
    if (o.creepId) {
      const creep = new Creep();
      RoomObject.call(creep, o.x, o.y, o.room);
      Object.defineProperties(creep, {
        id: { enumerable: true, get: () => o.creepId },
        name: { enumerable: true, get: () => o.creepName },
        spawning: { enumerable: true, get: () => false },
        my: { enumerable: true, get: () => o.user == scope().runtimeData.user._id },
        body: { enumerable: true, get: body },
        owner: { enumerable: true, get: () => ownerOf(o) },
        ticksToLive: { enumerable: true, get: () => o.creepTicksToLive },
        carryCapacity: {
          enumerable: true,
          get: () =>
            (o.creepBody ?? []).reduce(
              (result, type) => result + (type === C.CARRY ? C.CARRY_CAPACITY : 0),
              0,
            ),
        },
        carry: { enumerable: true, get: emptyStoreGetter },
        store: { enumerable: true, get: emptyStoreGetter },
        fatigue: { enumerable: true, get: () => 0 },
        hits: { enumerable: true, get: () => 0 },
        hitsMax: { enumerable: true, get: () => (o.creepBody as string[]).length * 100 },
        saying: { enumerable: true, get: () => o.creepSaying },
      });
      return creep;
    }

    if (o.powerCreepId) {
      const powerCreep = new PowerCreep();
      RoomObject.call(powerCreep, o.x, o.y, o.room);
      Object.defineProperties(powerCreep, {
        id: { enumerable: true, get: () => o.powerCreepId },
        name: { enumerable: true, get: () => o.powerCreepName },
        className: { enumerable: true, get: () => o.powerCreepClassName },
        level: { enumerable: true, get: () => o.powerCreepLevel },
        my: { enumerable: true, get: () => o.user == scope().runtimeData.user._id },
        body: { enumerable: true, get: body },
        owner: { enumerable: true, get: () => ownerOf(o) },
        ticksToLive: { enumerable: true, get: () => o.powerCreepTicksToLive },
        carryCapacity: { enumerable: true, get: () => (o.powerCreepLevel as number) * 100 },
        carry: { enumerable: true, get: emptyStoreGetter },
        store: { enumerable: true, get: emptyStoreGetter },
        hits: { enumerable: true, get: () => 0 },
        hitsMax: { enumerable: true, get: () => (o.powerCreepLevel as number) * 1000 },
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
