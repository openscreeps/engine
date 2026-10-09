/*
 * Ported from @screeps/engine src/utils.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { jsAdd, jsBitAnd, jsGe, jsLe, jsLt, jsSub, looseEquals, toPropertyKey } from './js.ts';
import { collectionValues, isEqual, isNumber, isObject, isString } from './lodash.ts';
import { getProp } from './tables.ts';
import { checkTerrain, type RoomTerrainData, type TerrainSpatial } from './terrain.ts';

/** Minimal stored room-object shape the structure helpers read. */
export interface RoomObjectLike {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly user?: string | null | undefined;
  readonly structureType?: string | undefined;
}

/** Minimal stored controller shape the structure helpers read. */
export interface ControllerLike {
  readonly x: number;
  readonly y: number;
  readonly level?: number | undefined;
  readonly user?: string | null | undefined;
  readonly owner?: unknown;
}

export type RoomObjectCollection<T> = Readonly<Record<string, T>> | readonly T[];

/**
 * Upstream `CONTROLLER_STRUCTURES[type][level]`: plain (inherited) property reads, throwing a TypeError
 * when no table exists. Non-numeric results become NaN, which compares and adds like upstream's `undefined`.
 */
function controllerLimit(type: string, level: number | undefined): number {
  const table = getProp(C.CONTROLLER_STRUCTURES, type);
  // ToPropertyKey(undefined) is "undefined", so a missing level reads `table["undefined"]` like upstream.
  const limit = getProp(table, toPropertyKey(level));
  return typeof limit === 'number' ? limit : NaN;
}

/** Upstream `objects && _.isArray(objects[0]) && _.isString(objects[0][0])`. */
function isTerrainSpatial(objects: unknown): boolean {
  if (!objects) {
    return false;
  }
  const firstRow = getProp(objects, 0);
  return Array.isArray(firstRow) && isString(getProp(firstRow, 0));
}

/** Upstream `objects[y][x] & mask` with raw (player-supplied) coordinates. */
function spatialMasked(grid: unknown, x: unknown, y: unknown, mask: number): number | bigint {
  // Keys are converted after each base is read, exactly like `grid[y][x]`.
  return jsBitAnd(getProp(getProp(grid, toPropertyKey(y)), toPropertyKey(x)), mask);
}

/** lodash 3 `_.matches` predicate for a single `[key, srcValue]` pair (strict for primitives, isEqual otherwise). */
function matchesProperty(object: object, key: string, srcValue: unknown): boolean {
  const isStrictComparable = !Number.isNaN(srcValue) && !isObject(srcValue);
  if (isStrictComparable) {
    return getProp(object, key) === srcValue && (srcValue !== undefined || key in object);
  }
  return key in object && isEqual(srcValue, getProp(object, key));
}

/**
 * Whether a construction site of `structureType` may be placed at `(x, y)`.
 * `objects` is either the room terrain (string / `Uint8Array` / spatial grid), checking terrain rules
 * only, or the room objects collection, checking occupancy rules — exactly the upstream overload.
 * `structureType`, `x` and `y` may be raw player values: every comparison and arithmetic step uses the
 * upstream JS operators (`==`, `+`, `-`, `<=`, …) with their coercions.
 */
export function checkConstructionSite(
  objects:
    RoomTerrainData | TerrainSpatial | RoomObjectCollection<RoomObjectLike> | null | undefined,
  structureType: unknown,
  x: unknown,
  y: unknown,
): boolean {
  let borderTiles: [unknown, unknown][] | undefined;
  if (
    !looseEquals(structureType, 'road') &&
    !looseEquals(structureType, 'container') &&
    (looseEquals(x, 1) || looseEquals(x, 48) || looseEquals(y, 1) || looseEquals(y, 48))
  ) {
    if (looseEquals(x, 1)) {
      borderTiles = [
        [0, jsSub(y, 1)],
        [0, y],
        [0, jsAdd(y, 1)],
      ];
    }
    if (looseEquals(x, 48)) {
      borderTiles = [
        [49, jsSub(y, 1)],
        [49, y],
        [49, jsAdd(y, 1)],
      ];
    }
    if (looseEquals(y, 1)) {
      borderTiles = [
        [jsSub(x, 1), 0],
        [x, 0],
        [jsAdd(x, 1), 0],
      ];
    }
    if (looseEquals(y, 48)) {
      borderTiles = [
        [jsSub(x, 1), 49],
        [x, 49],
        [jsAdd(x, 1), 49],
      ];
    }
  }

  if (isString(objects) || objects instanceof Uint8Array) {
    if (borderTiles) {
      for (const [bx, by] of borderTiles) {
        if (!checkTerrain(objects, bx, by, C.TERRAIN_MASK_WALL)) {
          return false;
        }
      }
    }
    if (looseEquals(structureType, 'extractor')) {
      return true;
    }
    if (!looseEquals(structureType, 'road') && checkTerrain(objects, x, y, C.TERRAIN_MASK_WALL)) {
      return false;
    }
    return true;
  }

  if (isTerrainSpatial(objects)) {
    if (borderTiles) {
      for (const [bx, by] of borderTiles) {
        if (!spatialMasked(objects, bx, by, C.TERRAIN_MASK_WALL)) {
          return false;
        }
      }
    }
    if (looseEquals(structureType, 'extractor')) {
      return true;
    }
    if (!looseEquals(structureType, 'road') && spatialMasked(objects, x, y, C.TERRAIN_MASK_WALL)) {
      return false;
    }
    return true;
  }

  // Spatial grids and terrain strings were handled above; what remains is a room-object collection.
  const roomObjects = objects as RoomObjectCollection<RoomObjectLike> | null | undefined;
  const list = collectionValues(roomObjects);
  // `_.any(objects, {x, y, type})`: lodash checks the pairs last-to-first, then first-to-last.
  const at = (i: RoomObjectLike, type: unknown): boolean =>
    matchesProperty(i, 'type', type) && matchesProperty(i, 'y', y) && matchesProperty(i, 'x', x);

  if (list.some((i) => at(i, structureType))) {
    return false;
  }
  if (list.some((i) => at(i, 'constructionSite'))) {
    return false;
  }
  if (looseEquals(structureType, 'extractor')) {
    return list.some((i) => at(i, 'mineral')) && !list.some((i) => at(i, 'extractor'));
  }
  if (
    !looseEquals(structureType, 'rampart') &&
    !looseEquals(structureType, 'road') &&
    list.some(
      (i) =>
        looseEquals(i.x, x) &&
        looseEquals(i.y, y) &&
        i.type !== 'rampart' &&
        i.type !== 'road' &&
        Boolean(getProp(C.CONSTRUCTION_COST, i.type)),
    )
  ) {
    return false;
  }
  if (jsLe(x, 0) || jsLe(y, 0) || jsGe(x, 49) || jsGe(y, 49)) {
    return false;
  }
  return true;
}

/**
 * Whether one more structure of `type` is allowed by the controller level. `roomController` is the
 * controller object (counted only when owned/leveled) or a level number; `offset` widens the limit.
 * `type` may be a raw player value (compared with `==`, used as a property key like upstream).
 */
export function checkControllerAvailability(
  type: unknown,
  roomObjects: RoomObjectCollection<RoomObjectLike> | null | undefined,
  roomController: ControllerLike | number | null | undefined,
  offset?: number,
): boolean {
  let rcl: unknown = 0;

  if (
    isObject(roomController) &&
    roomController.level &&
    (roomController.user || roomController.owner)
  ) {
    rcl = roomController.level;
  }
  if (isNumber(roomController)) {
    rcl = roomController;
  }

  const structuresCnt = collectionValues(roomObjects).filter(
    (i) =>
      looseEquals(i.type, type) ||
      (i.type === 'constructionSite' && looseEquals(i.structureType, type)),
  ).length;
  // Exactly `CONTROLLER_STRUCTURES[type][rcl] + offset`.
  const table = getProp(C.CONTROLLER_STRUCTURES, toPropertyKey(type));
  const availableCnt = jsAdd(getProp(table, toPropertyKey(rcl)), offset || 0);

  return jsLt(structuresCnt, availableCnt);
}

/**
 * Whether an owned structure is active under its room's controller: structures beyond the RCL limit
 * are deactivated by distance to the controller (ties broken by collection order).
 * `object` must be the same instance that appears in `roomObjects`.
 */
export function checkStructureAgainstController(
  object: RoomObjectLike,
  roomObjects: RoomObjectCollection<RoomObjectLike>,
  roomController: ControllerLike | null | undefined,
): boolean {
  // owner-less objects are always active
  if (!object.user) {
    return true;
  }

  // eliminate some other easy cases
  // Upstream's `undefined < 1` is false, so a controller without a level falls through.
  const level = roomController?.level;
  if (
    !roomController ||
    (level !== undefined && level < 1) ||
    roomController.user !== object.user
  ) {
    return false;
  }

  // A level missing from the table behaves as upstream's `undefined`: never equal to 0, NaN after decrement.
  let allowedRemaining = controllerLimit(object.type, level);

  if (allowedRemaining === 0) {
    return false;
  }

  // if only one object ever allowed, this is it
  if (controllerLimit(object.type, 8) === 1) {
    return true;
  }

  // Scan through the room objects of the same type and count how many are closer.
  let foundSelf = false;
  const objectDist = Math.max(
    Math.abs(object.x - roomController.x),
    Math.abs(object.y - roomController.y),
  );
  for (const compareObj of collectionValues(roomObjects)) {
    if (compareObj.type === object.type && compareObj.user === object.user) {
      const compareDist = Math.max(
        Math.abs(compareObj.x - roomController.x),
        Math.abs(compareObj.y - roomController.y),
      );

      if (compareDist < objectDist) {
        allowedRemaining--;
        if (allowedRemaining === 0) {
          return false;
        }
      } else if (!foundSelf && compareDist === objectDist) {
        // Objects of equal distance that are discovered before we scan over the selected object are considered closer
        if (object === compareObj) {
          foundSelf = true;
        } else {
          allowedRemaining--;
          if (allowedRemaining === 0) {
            return false;
          }
        }
      }
    }
  }

  return true;
}
