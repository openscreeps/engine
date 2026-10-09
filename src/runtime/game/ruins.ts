/*
 * Ruin (screeps/engine `src/game/ruins.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import {
  defineGameObjectProperties,
  exposeGlobal,
  gameConstructor,
  type GameConstructor,
} from './define.ts';
import { RoomObject } from './room-object.ts';
import type { RawRoomObject } from './runtime-data.ts';
import { rawObject, scope, username } from './scope.ts';
import { Store } from './store.ts';
import { OwnedStructure, Structure } from './structures.ts';

class RuinImpl extends RoomObject {
  declare id: string;
  declare readonly structureType: string | undefined;
  declare readonly destroyTime: number | undefined;
  declare readonly ticksToDecay: number;
  declare readonly store: Store;
  declare readonly structure: Structure;

  override toString(): string {
    return `[ruin (${this.structure.structureType}) #${this.id}]`;
  }
}

export type Ruin = RuinImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Ruin: GameConstructor<Ruin, [id?: unknown]> = gameConstructor(
  RuinImpl,
  function (this: Ruin, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Ruin, RawRoomObject>(Ruin.prototype, rawObject, {
  structureType: (o) => o.structureType,
  destroyTime: (o) => o.destroyTime,
  // The cast lets TypeScript emit upstream's raw arithmetic (`undefined`/`null` coerce like JS).
  ticksToDecay: (o) => (o.decayTime as number) - scope().runtimeData.time,
  store: (o) => new Store(o),
  structure: (o) => {
    // upstream dereferences `o.structure.user` unguarded; the cast keeps that native TypeError
    const info = o.structure as NonNullable<RawRoomObject['structure']>;
    const owner = info.user;
    if (owner) {
      const structure = new OwnedStructure();
      Object.defineProperties(structure, {
        id: { enumerable: true, get: () => info.id },
        hits: { enumerable: true, get: () => info.hits },
        hitsMax: { enumerable: true, get: () => info.hitsMax },
        structureType: { enumerable: true, get: () => info.type },
        owner: { enumerable: true, get: () => ({ username: username(owner) }) },
        my: { enumerable: true, get: () => owner == scope().runtimeData.user._id },
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
