/*
 * Flag (screeps/engine `src/game/flags.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { fetchXYArguments } from '../../utils/index.ts';
import { isObject } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { contains, isUndefined, jsSetSloppy, sloppyThis } from './compat.ts';
import { gameConstructor, type GameConstructor } from './define.ts';
import { RoomObject } from './room-object.ts';
import { RoomPosition } from './room-position.ts';
import { scope } from './scope.ts';

class FlagImpl extends RoomObject {
  declare name: string;
  declare color: number;
  declare secondaryColor: number;
  declare memory: unknown;

  override toString(): string {
    return `[flag ${this.name}]`;
  }

  remove(): number {
    scope().intents.pushByName('room', 'removeFlag', {
      roomName: this.pos.roomName,
      name: this.name,
    });
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

export type Flag = FlagImpl;

/** Upstream `register.wrapFn(function(name, color, secondaryColor, roomName, x, y) {…})`. */
export const Flag: GameConstructor<
  Flag,
  [
    name?: unknown,
    color?: unknown,
    secondaryColor?: unknown,
    roomName?: unknown,
    x?: unknown,
    y?: unknown,
  ]
> = gameConstructor(
  FlagImpl,
  function (
    this: Flag,
    name?: unknown,
    color?: unknown,
    secondaryColor?: unknown,
    roomName?: unknown,
    x?: unknown,
    y?: unknown,
  ): void {
    RoomObject.call(this, Number(x), Number(y), roomName);
    // upstream stores the raw value (Room.createFlag may pass a non-string truthy name)
    this.name = name as string;
    this.color = Number(color);
    this.secondaryColor = Number(secondaryColor || color);
  },
  { name: '', length: 6 },
);

// Upstream accessor bodies are sloppy-mode code reading `globals.Memory` on every access; the
// helpers reproduce each property read/assignment (and their TypeErrors) in the same order.
Object.defineProperty(Flag.prototype, 'memory', {
  get(this: unknown): unknown {
    const self = sloppyThis(this);
    const { globals } = scope();
    if (
      isUndefined(getProp(globals.Memory, 'flags')) ||
      getProp(globals.Memory, 'flags') === 'undefined'
    ) {
      jsSetSloppy(globals.Memory, 'flags', {});
    }
    if (!isObject(getProp(globals.Memory, 'flags'))) {
      return undefined;
    }
    // `Memory.flags[this.name] = Memory.flags[this.name] || {}`
    const flags = getProp(globals.Memory, 'flags');
    // ToPropertyKey is applied by the property operations themselves; the casts only type the key
    const key = getProp(self, 'name') as PropertyKey;
    const value: unknown =
      getProp(getProp(globals.Memory, 'flags'), getProp(self, 'name') as PropertyKey) || {};
    jsSetSloppy(flags, key, value);
    return value;
  },
  set(this: unknown, value: unknown): void {
    const self = sloppyThis(this);
    const { globals } = scope();
    if (
      isUndefined(getProp(globals.Memory, 'flags')) ||
      getProp(globals.Memory, 'flags') === 'undefined'
    ) {
      jsSetSloppy(globals.Memory, 'flags', {});
    }
    if (!isObject(getProp(globals.Memory, 'flags'))) {
      throw new Error('Could not set flag memory');
    }
    jsSetSloppy(getProp(globals.Memory, 'flags'), getProp(self, 'name') as PropertyKey, value);
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
