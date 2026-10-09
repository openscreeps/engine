/*
 * Source, an energy source (screeps/engine `src/game/sources.js`).
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
import type { RawRoomObject } from './runtime-data.ts';
import { RoomObject } from './room-object.ts';
import { rawObject, scope } from './scope.ts';

class SourceImpl extends RoomObject {
  declare id: string;
  declare readonly energy: number | undefined;
  declare readonly energyCapacity: number | undefined;
  declare readonly ticksToRegeneration: number | undefined;

  override toString(): string {
    return `[source #${this.id}]`;
  }
}

export type Source = SourceImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Source: GameConstructor<Source, [id?: unknown]> = gameConstructor(
  SourceImpl,
  function (this: Source, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Source, RawRoomObject>(Source.prototype, rawObject, {
  energy: (o) => o.energy,
  energyCapacity: (o) => o.energyCapacity,
  ticksToRegeneration: (o) =>
    o.nextRegenerationTime ? o.nextRegenerationTime - scope().runtimeData.time : undefined,
});

export function make(): void {
  if (scope().globals.Source) {
    return;
  }
  exposeGlobal('Source', Source);
}
