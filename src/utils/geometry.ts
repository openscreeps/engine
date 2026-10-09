/*
 * Ported from @screeps/engine src/utils.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import type {
  DirectionConstant,
  HasPos,
  PosLike,
  PositionSource,
  RoomPosLike,
} from '../types/index.ts';
import { isNaNValue, isNumber, isObject } from './lodash.ts';

export type DirectionOffset = readonly [dx: number, dy: number];

/** `[dx, dy]` per direction constant; index 0 is a hole, exactly like upstream's sparse array. */
export const offsetsByDirection: readonly (DirectionOffset | undefined)[] = [
  undefined,
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

function hasPos(source: PositionSource): source is HasPos {
  return 'pos' in source && isObject(source.pos);
}

/** Unwraps `object.pos` when present, as upstream's `if (a.pos) a = a.pos`. */
export function toPos(source: PositionSource): PosLike {
  return hasPos(source) ? source.pos : source;
}

/** Approximate direction from a delta; returns `undefined` for a zero delta. */
export function getDirection(dx: number, dy: number): DirectionConstant | undefined {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);

  if (adx > ady * 2) {
    return dx > 0 ? C.RIGHT : C.LEFT;
  }
  if (ady > adx * 2) {
    return dy > 0 ? C.BOTTOM : C.TOP;
  }
  if (dx > 0 && dy > 0) {
    return C.BOTTOM_RIGHT;
  }
  if (dx > 0 && dy < 0) {
    return C.TOP_RIGHT;
  }
  if (dx < 0 && dy > 0) {
    return C.BOTTOM_LEFT;
  }
  if (dx < 0 && dy < 0) {
    return C.TOP_LEFT;
  }
  return undefined;
}

/**
 * Returns the `[dx, dy]` offset for a direction. An invalid direction logs the same diagnostic as
 * upstream (through the supplied logger, default `console.error`) and yields `undefined`.
 */
export function getOffsetsByDirection(
  direction: unknown,
  logError: (...args: unknown[]) => void = console.error,
): DirectionOffset | undefined {
  // Upstream indexes a sparse array with the raw value, i.e. by its property-key string.
  const key = typeof direction === 'symbol' ? '' : String(direction);
  const offset = /^[1-8]$/.test(key) ? offsetsByDirection[Number(key)] : undefined;
  if (!offset) {
    logError(
      'Wrong move direction',
      JSON.stringify(direction),
      JSON.stringify(offsetsByDirection),
      new Error().stack,
    );
  }
  return offset;
}

/** Chebyshev distance between two positions (or objects with `pos`). */
export function dist(a: PositionSource, b: PositionSource): number {
  const pa = toPos(a);
  const pb = toPos(b);
  return Math.max(Math.abs(pa.x - pb.x), Math.abs(pa.y - pb.y));
}

/** Comparator ordering positions (or objects with `pos`) by Chebyshev distance to `target`. */
export function comparatorDistance(
  target: PositionSource,
): (a: PositionSource, b: PositionSource) => number {
  const t = toPos(target);
  return (a, b) => {
    const pa = toPos(a);
    const pb = toPos(b);
    const da = Math.max(Math.abs(pa.x - t.x), Math.abs(pa.y - t.y));
    const db = Math.max(Math.abs(pb.x - t.x), Math.abs(pb.y - t.y));
    return da - db;
  };
}

/** Whether a position (or object with `pos`) lies on a room edge tile. */
export function isAtEdge(object: PositionSource): boolean {
  const pos = toPos(object);
  return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}

export type RoomPositionConstructor = abstract new (...args: never[]) => RoomPosLike;

/**
 * Normalises the `(x, y)` / `(target)` overload used by RoomPosition/Room APIs.
 * `x` is returned untouched when both arguments are given (it may be any user value), mirroring upstream.
 */
export function fetchXYArguments(
  firstArg: unknown,
  secondArg: unknown,
  RoomPosition: RoomPositionConstructor,
): [x: unknown, y: number | undefined, roomName: string | undefined] {
  let x: unknown;
  let y: number | undefined;
  let roomName: string | undefined;
  if (secondArg === undefined || !isNumber(secondArg)) {
    if (!isObject(firstArg)) {
      return [undefined, undefined, undefined];
    }
    if (firstArg instanceof RoomPosition) {
      x = firstArg.x;
      y = firstArg.y;
      roomName = firstArg.roomName;
    }
    if ('pos' in firstArg && firstArg.pos instanceof RoomPosition) {
      x = firstArg.pos.x;
      y = firstArg.pos.y;
      roomName = firstArg.pos.roomName;
    }
  } else {
    x = firstArg;
    y = secondArg;
  }
  if (isNaNValue(x)) {
    x = undefined;
  }
  if (isNaNValue(y)) {
    y = undefined;
  }
  return [x, y, roomName];
}

/** One step of a room path as produced by `Room.findPath`. */
export interface PathStep {
  x: number;
  y: number;
  dx: number;
  dy: number;
  direction: DirectionConstant;
}

export interface SerializablePathStep {
  readonly x: number;
  readonly y: number;
  readonly direction: number | undefined;
}

/** `Room.serializePath`: 2-digit x, 2-digit y of the first step, then one direction digit per step. */
export function serializePath(path: readonly SerializablePathStep[]): string {
  // Runtime guard for values coming from player code; checked on an `unknown` alias so `path` keeps its type.
  const candidate: unknown = path;
  if (!Array.isArray(candidate)) {
    throw new Error('path is not an array');
  }
  let result = '';
  const first = path[0];
  if (!first) {
    return result;
  }
  if (first.x < 0 || first.y < 0) {
    throw new Error('path coordinates cannot be negative');
  }
  result += first.x > 9 ? String(first.x) : `0${String(first.x)}`;
  result += first.y > 9 ? String(first.y) : `0${String(first.y)}`;

  for (const step of path) {
    result += String(step.direction);
  }
  return result;
}

/** `Room.deserializePath`: inverse of {@link serializePath}. */
export function deserializePath(path: unknown): PathStep[] {
  if (typeof path !== 'string') {
    throw new Error('`path` is not a string');
  }
  const result: PathStep[] = [];
  if (!path.length) {
    return result;
  }

  let x = parseInt(path.substring(0, 2));
  let y = parseInt(path.substring(2, 4));
  if (Number.isNaN(x) || Number.isNaN(y)) {
    throw new Error('`path` is not a valid serialized path string');
  }

  for (let i = 4; i < path.length; i++) {
    const direction = parseInt(path.charAt(i));
    const offset = offsetsByDirection[direction];
    if (!offset) {
      throw new Error('`path` is not a valid serialized path string');
    }
    const [dx, dy] = offset;
    if (i > 4) {
      x += dx;
      y += dy;
    }
    result.push({
      x,
      y,
      dx,
      dy,
      // Offsets exist only for indices 1..8, i.e. valid direction constants.
      direction: direction as DirectionConstant,
    });
  }
  return result;
}
