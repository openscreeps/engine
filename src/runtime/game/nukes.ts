/*
 * Nuke, a launched nuke in flight (screeps/engine `src/game/nukes.js`).
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

class NukeImpl extends RoomObject {
  declare id: string;
  declare readonly timeToLand: number;
  declare readonly launchRoomName: string | undefined;

  override toString(): string {
    return `[nuke #${this.id}]`;
  }
}

export type Nuke = NukeImpl;

/** Upstream `register.wrapFn(function(id) {…})`. */
export const Nuke: GameConstructor<Nuke, [id?: unknown]> = gameConstructor(
  NukeImpl,
  function (this: Nuke, id?: unknown): void {
    const data = rawObject(id);
    RoomObject.call(this, data.x, data.y, data.room, data.effects);
    // upstream stores the raw argument
    this.id = id as string;
  },
  { name: '', length: 1 },
);

defineGameObjectProperties<Nuke, RawRoomObject>(Nuke.prototype, rawObject, {
  // The cast lets TypeScript emit upstream's raw arithmetic (`undefined`/`null` coerce like JS).
  timeToLand: (o) => (o.landTime as number) - scope().runtimeData.time,
  launchRoomName: (o) => o.launchRoomName,
});

export function make(): void {
  if (scope().globals.Nuke) {
    return;
  }
  exposeGlobal('Nuke', Nuke);
}
