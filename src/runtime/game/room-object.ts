/*
 * RoomObject, the base class of every positioned game object (screeps/engine `src/game/rooms.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { jsString, jsSub } from '../../utils/js.ts';
import { collectionValues } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { gameConstructor, type GameConstructor } from './define.ts';
import { RoomPosition } from './room-position.ts';
import type { Room } from './rooms.ts';
import { scope } from './scope.ts';

export interface RoomObjectEffect {
  power: number | undefined;
  effect: number | undefined;
  level: number | undefined;
  ticksRemaining: number;
}

class RoomObjectImpl {
  declare room: Room | undefined;
  declare pos: RoomPosition;
  declare effects?: RoomObjectEffect[];
}

export type RoomObject = RoomObjectImpl;

/** Upstream `register.wrapFn(function(x, y, room, effects) {…})`. */
export const RoomObject: GameConstructor<
  RoomObject,
  [x?: unknown, y?: unknown, room?: unknown, effects?: unknown]
> = gameConstructor(
  RoomObjectImpl,
  function (this: RoomObject, x?: unknown, y?: unknown, room?: unknown, effects?: unknown): void {
    const { register, runtimeData } = scope();
    this.room = Reflect.get(register.rooms, typeof room === 'symbol' ? room : jsString(room)) as
      Room | undefined;
    this.pos = new RoomPosition(x, y, room);
    if (effects) {
      // `_(effects).map(...).filter(...)` over any lodash collection.
      this.effects = collectionValues(effects)
        .map((i: unknown) => ({
          power: getProp(i, 'power') as number | undefined,
          effect: getProp(i, 'effect') as number | undefined,
          level: getProp(i, 'level') as number | undefined,
          ticksRemaining: jsSub(getProp(i, 'endTime'), runtimeData.time) as number,
        }))
        .filter((i) => i.ticksRemaining > 0);
    }
  },
  { name: '', length: 4, enumerableConstructor: false },
);
