/*
 * Ported from @screeps/engine src/utils.js and @screeps/common index.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

/**
 * Engine `roomNameToXY`: fast positional parser (`W0N0` -> `[-1, -1]`, `E0S0` -> `[0, 0]`).
 * Malformed names produce `NaN` components exactly like upstream's `parseInt` based implementation.
 */
export function roomNameToXY(name: string): [x: number, y: number] {
  let xx = parseInt(name.substring(1), 10);
  let verticalPos = 2;
  if (xx >= 100) {
    verticalPos = 4;
  } else if (xx >= 10) {
    verticalPos = 3;
  }
  let yy = parseInt(name.substring(verticalPos + 1), 10);
  const horizontalDir = name.charAt(0);
  const verticalDir = name.charAt(verticalPos);
  if (horizontalDir === 'W' || horizontalDir === 'w') {
    xx = -xx - 1;
  }
  if (verticalDir === 'N' || verticalDir === 'n') {
    yy = -yy - 1;
  }
  return [xx, yy];
}

/**
 * `@screeps/common` `roomNameToXY`: strict regex parser (case-insensitive) that yields
 * `[undefined, undefined]` for malformed names.
 */
export function parseRoomNameXY(
  name: string,
): [x: number, y: number] | [x: undefined, y: undefined] {
  const match = /^(\w)(\d+)(\w)(\d+)$/.exec(name.toUpperCase());
  if (!match) {
    return [undefined, undefined];
  }
  const [, hor, xs, ver, ys] = match;
  const x = hor === 'W' ? -Number(xs) - 1 : Number(xs);
  const y = ver === 'N' ? -Number(ys) - 1 : Number(ys);
  return [x, y];
}

/** Inverse of {@link roomNameToXY}. */
export function getRoomNameFromXY(x: number, y: number): string {
  const xs = x < 0 ? `W${String(-x - 1)}` : `E${String(x)}`;
  const ys = y < 0 ? `N${String(-y - 1)}` : `S${String(y)}`;
  return xs + ys;
}

/**
 * Linear room distance. When `continuous` is set the world wraps around, which requires the
 * world size (upstream read it from the global driver).
 */
export function calcRoomsDistance(room1: string, room2: string, continuous?: false): number;
export function calcRoomsDistance(
  room1: string,
  room2: string,
  continuous: boolean,
  worldSize: number,
): number;
export function calcRoomsDistance(
  room1: string,
  room2: string,
  continuous = false,
  worldSize?: number,
): number {
  const [x1, y1] = roomNameToXY(room1);
  const [x2, y2] = roomNameToXY(room2);
  let dx = Math.abs(x2 - x1);
  let dy = Math.abs(y2 - y1);
  if (continuous) {
    if (worldSize === undefined) {
      throw new TypeError('calcRoomsDistance: worldSize is required for continuous distance');
    }
    dx = Math.min(worldSize - dx, dx);
    dy = Math.min(worldSize - dy, dy);
  }
  return Math.max(dx, dy);
}

/** `@screeps/common` `calcWorldSize`: world edge length from the list of room documents. */
export function calcWorldSize(rooms: Iterable<{ readonly _id: string }>): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  for (const room of rooms) {
    const [x, y] = parseRoomNameXY(room._id);
    // Comparisons against `undefined` are always false, matching upstream for malformed names.
    if (x !== undefined) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (y !== undefined) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Math.max(maxX - minX + 1, maxY - minY + 1);
}
