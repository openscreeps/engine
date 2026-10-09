/*
 * Flag (screeps/engine `src/game/flags.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { fetchXYArguments } from '../../utils/index.ts';
import { contains, isObject, isUndefined } from './compat.ts';
import { finalizeClass } from './define.ts';
import { RoomObject } from './room-object.ts';
import { RoomPosition } from './room-position.ts';
import { memoryRoot, scope } from './scope.ts';

export class Flag extends RoomObject {
    declare name: string;
    declare color: number;
    declare secondaryColor: number;
    declare memory: unknown;

    constructor(name: unknown, color: unknown, secondaryColor: unknown, roomName: string, x: unknown, y: unknown) {
        super(Number(x), Number(y), roomName);
        // upstream stores the raw value (Room.createFlag may pass a non-string truthy name)
        Reflect.set(this, 'name', name);
        this.color = Number(color);
        this.secondaryColor = Number(secondaryColor || color);
    }

    toString(): string {
        return `[flag ${this.name}]`;
    }

    remove(): number {
        scope().intents.pushByName('room', 'removeFlag', { roomName: this.pos.roomName, name: this.name });
        return C.OK;
    }

    setPosition(firstArg: unknown, secondArg?: unknown): number {
        const [x, y, fetchedRoomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);
        const roomName = fetchedRoomName || this.pos.roomName;
        if (isUndefined(x) || isUndefined(y)) {
            return C.ERR_INVALID_TARGET;
        }
        const { intents } = scope();
        intents.pushByName('room', 'removeFlag', { roomName: this.pos.roomName, name: this.name });
        intents.pushByName('room', 'createFlag', {
            roomName,
            x,
            y,
            name: this.name,
            color: this.color,
            secondaryColor: this.secondaryColor,
        });
        return C.OK;
    }

    setColor(color: unknown, secondaryColor?: unknown): number {
        if (!contains(C.COLORS_ALL, color)) {
            return C.ERR_INVALID_ARGS;
        }
        const secondary = secondaryColor || color;
        if (!contains(C.COLORS_ALL, secondary)) {
            return C.ERR_INVALID_ARGS;
        }
        const { intents } = scope();
        intents.pushByName('room', 'removeFlag', { roomName: this.pos.roomName, name: this.name });
        intents.pushByName('room', 'createFlag', {
            roomName: this.pos.roomName,
            x: this.pos.x,
            y: this.pos.y,
            name: this.name,
            color,
            secondaryColor: secondary,
        });
        return C.OK;
    }
}

finalizeClass(Flag);

Object.defineProperty(Flag.prototype, 'memory', {
    get(this: Flag): unknown {
        const memory = memoryRoot();
        if (isUndefined(memory.flags) || memory.flags === 'undefined') {
            memory.flags = {};
        }
        const flags = memory.flags;
        if (!isObject(flags)) {
            return undefined;
        }
        const value: unknown = Reflect.get(flags, this.name) || {};
        Reflect.set(flags, this.name, value);
        return value;
    },
    set(this: Flag, value: unknown): void {
        const memory = memoryRoot();
        if (isUndefined(memory.flags) || memory.flags === 'undefined') {
            memory.flags = {};
        }
        const flags = memory.flags;
        if (!isObject(flags)) {
            throw new Error('Could not set flag memory');
        }
        Reflect.set(flags, this.name, value);
    },
});

export function make(): void {
    const { globals } = scope();
    if (globals.Flag) {
        return;
    }
    Object.defineProperty(globals, 'Flag', {
        enumerable: true,
        value: Flag,
    });
}
