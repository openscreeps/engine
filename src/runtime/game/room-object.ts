/*
 * RoomObject, the base class of every positioned game object (screeps/engine `src/game/rooms.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { Effect } from '../../simulation/state.ts';
import { finalizeClass } from './define.ts';
import { RoomPosition } from './room-position.ts';
import type { Room } from './rooms.ts';
import { scope } from './scope.ts';

export interface RoomObjectEffect {
    power: number | undefined;
    effect: number;
    level: number | undefined;
    ticksRemaining: number;
}

export class RoomObject {
    declare room: Room | undefined;
    declare pos: RoomPosition;
    declare effects?: RoomObjectEffect[];

    /**
     * Upstream subclasses skip `RoomObject.call` when constructed without an id; calling this
     * constructor with no position arguments reproduces that by leaving the instance empty.
     */
    constructor(x?: number, y?: number, room?: string, effects?: readonly Effect[] | null) {
        if (x === undefined && y === undefined && room === undefined) {
            return;
        }
        const { register, runtimeData } = scope();
        this.room = room === undefined ? undefined : register.rooms[room];
        this.pos = new RoomPosition(x, y, room);
        if (effects) {
            this.effects = effects
                .map((i) => ({
                    power: i.power,
                    effect: i.effect,
                    level: i.level,
                    ticksRemaining: i.endTime - runtimeData.time,
                }))
                .filter((i) => i.ticksRemaining > 0);
        }
    }
}

finalizeClass(RoomObject, { enumerableConstructor: false });
