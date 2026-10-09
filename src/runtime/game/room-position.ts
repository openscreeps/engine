/*
 * RoomPosition (screeps/engine `src/game/rooms.js` `makePos`): a packed world position with the
 * position-based game API helpers.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { clone, isArray, isUndefined } from './compat.ts';
import { gameConstructor, type GameConstructor } from './define.ts';
import {
  findClosestByPath2,
  lodashFilter,
  lodashFind,
  maskBits,
  readProp,
  staticTerrain,
  terrainAt,
  toOptions,
} from './rooms.ts';
import type { Room, RoomPathStep } from './rooms.ts';
import { scope } from './scope.ts';
import {
  fetchXYArguments,
  getDirection,
  getRoomNameFromXY as getRoomNameFromXYSlow,
  jsAdd,
  jsBitAnd,
  jsGt,
  jsLe,
  jsLt,
  jsSub,
  roomNameToXY,
  toNumber,
} from '../../utils/index.ts';
import { isNumber } from '../../utils/lodash.ts';

const kMaxWorldSize = 256;
const kMaxWorldSize2 = kMaxWorldSize >> 1;

/** Room names by packed `(x + 128) << 8 | (y + 128)` world coordinates (upstream memo cache). */
const roomNames: (string | undefined)[] = [];
roomNames[0] = 'sim';

/** Memoized `utils.getRoomNameFromXY` installed by upstream `makePos`. */
export function getRoomNameFromXY(xx: number, yy: number): string {
  const id = ((xx + kMaxWorldSize2) << 8) | (yy + kMaxWorldSize2);
  const roomName = roomNames[id];
  if (roomName === undefined) {
    const computed = getRoomNameFromXYSlow(xx, yy);
    roomNames[id] = computed;
    return computed;
  }
  return roomName;
}

/** `utils.roomNameToXY(roomName)` with upstream's `sim` special case and property-access failures. */
function worldXY(roomName: unknown): [number, number] {
  if (roomName === 'sim') {
    return [-kMaxWorldSize2, -kMaxWorldSize2];
  }
  if (roomName === null || roomName === undefined) {
    throw new TypeError(`Cannot read properties of ${String(roomName)} (reading 'substring')`);
  }
  if (typeof roomName !== 'string' && !(roomName instanceof String)) {
    throw new TypeError('name.substring is not a function');
  }
  return roomNameToXY(String(roomName));
}

/** Upstream `v < 0 || v > 49 || v !== v` on a raw value (same evaluation order). */
function invalidCoordinate(value: unknown): boolean {
  return jsLt(value, 0) || jsGt(value, 49) || value !== value;
}

/** Upstream `v << n` / `p | v` operand: ToInt32 of the raw value (`v & -1`; BigInt throws mixing). */
function toInt32(value: unknown): number {
  return toNumber(jsBitAnd(value, -1));
}

/** Upstream `abs(a - b)` on raw values (BigInt operands throw like upstream). */
function absDiff(a: unknown, b: unknown): number {
  return Math.abs(toNumber(jsSub(a, b)));
}

function requireRoom(roomName: string): Room {
  const room = scope().register.rooms[roomName];
  if (!room) {
    throw new Error(`Could not access room ${roomName}`);
  }
  return room;
}

class RoomPositionImpl {
  declare __packedPos: number;

  // Upstream defines x/y/roomName first (`Object.defineProperties`), before the prototype methods.
  get x(): number {
    return (this.__packedPos >> 8) & 0xff;
  }

  set x(val: unknown) {
    if (invalidCoordinate(val)) {
      throw new Error('Invalid coordinate');
    }
    this.__packedPos = (this.__packedPos & ~(0xff << 8)) | (toInt32(val) << 8);
  }

  get y(): number {
    return this.__packedPos & 0xff;
  }

  set y(val: unknown) {
    if (invalidCoordinate(val)) {
      throw new Error('Invalid coordinate');
    }
    this.__packedPos = (this.__packedPos & ~0xff) | toInt32(val);
  }

  get roomName(): string {
    const roomName = roomNames[this.__packedPos >>> 16];
    if (roomName === undefined) {
      return getRoomNameFromXY(
        (this.__packedPos >>> 24) - kMaxWorldSize2,
        ((this.__packedPos >>> 16) & 0xff) - kMaxWorldSize2,
      );
    }
    return roomName;
  }

  set roomName(val: unknown) {
    const xy = worldXY(val);
    xy[0] += kMaxWorldSize2;
    xy[1] += kMaxWorldSize2;
    if (
      xy[0] < 0 ||
      xy[0] > kMaxWorldSize ||
      Number.isNaN(xy[0]) ||
      xy[1] < 0 ||
      xy[1] > kMaxWorldSize ||
      Number.isNaN(xy[1])
    ) {
      throw new Error('Invalid roomName');
    }
    this.__packedPos = (this.__packedPos & ~(0xffff << 16)) | (xy[0] << 24) | (xy[1] << 16);
  }

  toJSON(): object {
    return Object.assign({ x: this.x, y: this.y, roomName: this.roomName }, this);
  }

  toString(): string {
    return `[room ${this.roomName} pos ${String(this.x)},${String(this.y)}]`;
  }

  inRangeTo(firstArg: unknown, secondArg?: unknown, thirdArg?: unknown): boolean {
    let x = firstArg;
    let y = secondArg;
    let range = thirdArg;
    let roomName: unknown = this.roomName;
    if (isUndefined(thirdArg)) {
      let pos = firstArg;
      const inner = readProp(pos, 'pos');
      if (inner) {
        pos = inner;
      }
      x = readProp(pos, 'x');
      y = readProp(pos, 'y');
      roomName = readProp(pos, 'roomName');
      range = secondArg;
    }
    return (
      jsLe(absDiff(x, this.x), range) &&
      jsLe(absDiff(y, this.y), range) &&
      roomName == this.roomName
    );
  }

  isNearTo(firstArg: unknown, secondArg?: unknown): boolean {
    const [x, y, roomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    return (
      absDiff(x, this.x) <= 1 && absDiff(y, this.y) <= 1 && (!roomName || roomName == this.roomName)
    );
  }

  getDirectionTo(firstArg: unknown, secondArg?: unknown): number | undefined {
    const [x, y, roomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);

    if (!roomName || roomName == this.roomName) {
      return getDirection(toNumber(jsSub(x, this.x)), toNumber(jsSub(y, this.y)));
    }

    const [thisRoomX, thisRoomY] = roomNameToXY(this.roomName);
    const [thatRoomX, thatRoomY] = roomNameToXY(roomName);

    return getDirection(
      toNumber(jsSub(jsSub(jsAdd(thatRoomX * 50, x), thisRoomX * 50), this.x)),
      toNumber(jsSub(jsSub(jsAdd(thatRoomY * 50, y), thisRoomY * 50), this.y)),
    );
  }

  findPathTo(firstArg: unknown, secondArg?: unknown, opts?: unknown): string | RoomPathStep[] {
    const [x, y, fetchedRoomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    const { register } = scope();
    const room = register.rooms[this.roomName];

    let options: unknown = opts;
    if (secondArg !== null && (typeof secondArg === 'object' || typeof secondArg === 'function')) {
      options = clone(secondArg);
    }
    options = options || {};

    const roomName = fetchedRoomName || this.roomName;

    if (!room) {
      throw new Error(`Could not access room ${this.roomName}`);
    }

    if (roomName == this.roomName || register._useNewPathFinder) {
      return room.findPath(this, new RoomPosition(x, y, roomName), options);
    }
    const exitDir = room.findExitTo(roomName);
    if (jsLt(exitDir, 0)) {
      return [];
    }
    const exit = this.findClosestByPath(exitDir, options);
    if (!exit) {
      return [];
    }
    return room.findPath(this, exit, options);
  }

  findClosestByPath(type: unknown, opts?: unknown): unknown {
    const options = toOptions(clone(opts || {}));
    const { register } = scope();
    const room = requireRoom(this.roomName);

    if (isUndefined(type)) {
      return null;
    }

    if (register._useNewPathFinder) {
      return findClosestByPath2(this, type, options);
    }

    options.serialize = false;

    let result: unknown = null;
    let isNear: number | undefined;
    const endNodes = room.getEndNodes(type, options);
    const objects = endNodes.objects;
    if (!isArray(objects)) {
      throw new TypeError('endNodes.objects.forEach is not a function');
    }

    if (!options.algorithm) {
      let minH: number | undefined;
      let sumH = 0;

      for (const i of objects) {
        let x = readProp(i, 'x');
        let y = readProp(i, 'y');
        const pos = readProp(i, 'pos');
        if (pos) {
          x = readProp(pos, 'x');
          y = readProp(pos, 'y');
        }
        const h = Math.max(absDiff(this.x, x), absDiff(this.y, y));
        if (minH === undefined || minH > h) {
          minH = h;
        }
        sumH += h;
      }

      options.algorithm = sumH > (minH ?? NaN) * 10 ? 'dijkstra' : 'astar';
    }

    if (options.algorithm == 'dijkstra') {
      let near = 1;

      for (const i of objects) {
        const distance = this.isEqualTo(i) ? -1 : this.isNearTo(i) ? 0 : 1;
        if (distance < near) {
          result = i;
          near = distance;
        }
      }

      if (near == 1) {
        const path = room.findPath(this, endNodes.key, options);
        if (Array.isArray(path) && path.length > 0) {
          const lastStep = path[path.length - 1];
          const lastStepPos = lastStep ? room.getPositionAt(lastStep.x, lastStep.y) : null;
          if (!lastStepPos) {
            throw new TypeError("Cannot read properties of null (reading 'isEqualTo')");
          }
          result = lodashFind(objects, (i: unknown) => lastStepPos.isEqualTo(i));
        }
      }
    }

    if (options.algorithm == 'astar') {
      for (const i of objects) {
        let distance: number | undefined;
        if (this.isEqualTo(i)) {
          distance = -1;
        } else if (this.isNearTo(i)) {
          distance = 0;
        } else {
          const path = this.findPathTo(i, options);
          const last = Array.isArray(path) ? path[path.length - 1] : undefined;
          if (Array.isArray(path) && path.length > 0) {
            const lastPos = room.getPositionAt(readProp(last, 'x'), readProp(last, 'y'));
            if (!lastPos) {
              throw new TypeError("Cannot read properties of null (reading 'isNearTo')");
            }
            distance = lastPos.isNearTo(i) ? path.length : undefined;
          }
        }

        if (
          (isNear === undefined || (distance !== undefined && distance <= isNear)) &&
          distance !== undefined
        ) {
          isNear = distance;
          result = i;
        }
      }
    }

    return result;
  }

  findInRange(type: unknown, range: unknown, opts?: unknown): unknown[] {
    const room = requireRoom(this.roomName);
    const options = toOptions(clone(opts || {}));

    let objects: unknown[] = [];
    const result: unknown[] = [];

    if (isNumber(type)) {
      objects = room.find(type, options);
    }
    if (isArray(type)) {
      objects = options.filter ? lodashFilter(type, options.filter) : type;
    }

    for (const i of objects) {
      if (this.inRangeTo(i, range)) {
        result.push(i);
      }
    }

    return result;
  }

  findClosestByRange(type: unknown, opts?: unknown): unknown {
    const room = requireRoom(this.roomName);
    const options = toOptions(clone(opts || {}));

    let objects: unknown[] = [];

    if (isNumber(type)) {
      objects = room.find(type, options);
    }
    if (isArray(type)) {
      objects = options.filter ? lodashFilter(type, options.filter) : type;
    }

    let closest: unknown = null;
    let minRange = Infinity;

    for (const i of objects) {
      const range = this.getRangeTo(i);
      if (range < minRange) {
        minRange = range;
        closest = i;
      }
    }

    return closest;
  }

  isEqualTo(firstArg: unknown, secondArg?: unknown): boolean {
    const packed = readProp(firstArg, '__packedPos');
    if (packed !== undefined) {
      return packed === this.__packedPos;
    }
    const [x, y, roomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    return x == this.x && y == this.y && (!roomName || roomName == this.roomName);
  }

  getRangeTo(firstArg: unknown, secondArg?: unknown): number {
    const [x, y, roomName] = fetchXYArguments(firstArg, secondArg, RoomPosition);
    if (roomName && roomName != this.roomName) {
      return Infinity;
    }
    return Math.max(absDiff(this.x, x), absDiff(this.y, y));
  }

  look(): unknown[] {
    return requireRoom(this.roomName).lookAt(this);
  }

  lookFor(type: unknown): unknown {
    if (type == 'terrain') {
      const terrainCode = terrainAt(staticTerrain(this.roomName), this.x, this.y);
      if (maskBits(terrainCode, C.TERRAIN_MASK_WALL)) {
        return ['wall'];
      } else if (maskBits(terrainCode, C.TERRAIN_MASK_SWAMP)) {
        return ['swamp'];
      }
      return ['plain'];
    }
    return requireRoom(this.roomName).lookForAt(type, this);
  }

  createFlag(name?: unknown, color?: unknown, secondaryColor?: unknown): unknown {
    return requireRoom(this.roomName).createFlag(this, name, color, secondaryColor);
  }

  createConstructionSite(structureType: unknown, name?: unknown): number {
    return requireRoom(this.roomName).createConstructionSite(this.x, this.y, structureType, name);
  }
}

export type RoomPosition = RoomPositionImpl;

/** Upstream `register.wrapFn(function RoomPosition(xx, yy, roomName) {…})` (default prototype kept). */
export const RoomPosition: GameConstructor<
  RoomPosition,
  [xx?: unknown, yy?: unknown, roomName?: unknown]
> = gameConstructor(
  RoomPositionImpl,
  function (this: RoomPosition, xx?: unknown, yy?: unknown, roomName?: unknown): void {
    const xy = worldXY(roomName);
    xy[0] += kMaxWorldSize2;
    xy[1] += kMaxWorldSize2;
    if (
      xy[0] < 0 ||
      xy[0] > kMaxWorldSize ||
      Number.isNaN(xy[0]) ||
      xy[1] < 0 ||
      xy[1] > kMaxWorldSize ||
      Number.isNaN(xy[1]) ||
      invalidCoordinate(xx) ||
      invalidCoordinate(yy)
    ) {
      throw new Error('Invalid arguments in RoomPosition constructor');
    }
    Object.defineProperty(this, '__packedPos', {
      enumerable: false,
      value: (xy[0] << 24) | (xy[1] << 16) | (toInt32(xx) << 8) | toInt32(yy),
      writable: true,
    });
  },
  { name: 'RoomPosition', length: 3, enumerableConstructor: false },
);

// Upstream `Object.defineProperties(RoomPosition.prototype, {x: {enumerable: true, get, set}, …})`.
Object.defineProperties(RoomPosition.prototype, {
  x: { enumerable: true, configurable: false },
  y: { enumerable: true, configurable: false },
  roomName: { enumerable: true, configurable: false },
});
