/*
 * Ported from @screeps/engine src/utils.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { collectionValues, isEqual, isNumber } from './lodash.ts';
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
  // Reflect.get applies ToPropertyKey, so `undefined` reads the "undefined" key like `table[undefined]`.
  const limit = getProp(table, level as PropertyKey);
  return typeof limit === 'number' ? limit : NaN;
}

function isTerrainSpatial(objects: unknown): objects is TerrainSpatial {
  if (!Array.isArray(objects)) {
    return false;
  }
  const firstRow: unknown = objects[0];
  return Array.isArray(firstRow) && typeof firstRow[0] === 'string';
}

function spatialCode(grid: TerrainSpatial, x: number, y: number): number {
  const row = grid[y];
  if (!row) {
    throw new TypeError(`Cannot read properties of undefined (reading '${String(x)}')`);
  }
  return Number(row[x]);
}

/**
 * Whether a construction site of `structureType` may be placed at `(x, y)`.
 * `objects` is either the room terrain (string / `Uint8Array` / spatial grid), checking terrain rules
 * only, or the room objects collection, checking occupancy rules — exactly the upstream overload.
 */
export function checkConstructionSite(
  objects: RoomTerrainData | TerrainSpatial | RoomObjectCollection<RoomObjectLike>,
  structureType: string,
  x: number,
  y: number,
): boolean {
  let borderTiles: [number, number][] | undefined;
  if (
    structureType !== 'road' &&
    structureType !== 'container' &&
    (x === 1 || x === 48 || y === 1 || y === 48)
  ) {
    if (x === 1)
      borderTiles = [
        [0, y - 1],
        [0, y],
        [0, y + 1],
      ];
    if (x === 48)
      borderTiles = [
        [49, y - 1],
        [49, y],
        [49, y + 1],
      ];
    if (y === 1)
      borderTiles = [
        [x - 1, 0],
        [x, 0],
        [x + 1, 0],
      ];
    if (y === 48)
      borderTiles = [
        [x - 1, 49],
        [x, 49],
        [x + 1, 49],
      ];
  }

  if (typeof objects === 'string' || objects instanceof Uint8Array) {
    if (borderTiles) {
      for (const [bx, by] of borderTiles) {
        if (!checkTerrain(objects, bx, by, C.TERRAIN_MASK_WALL)) {
          return false;
        }
      }
    }
    if (structureType === 'extractor') {
      return true;
    }
    if (structureType !== 'road' && checkTerrain(objects, x, y, C.TERRAIN_MASK_WALL)) {
      return false;
    }
    return true;
  }

  if (isTerrainSpatial(objects)) {
    if (borderTiles) {
      for (const [bx, by] of borderTiles) {
        if (!(spatialCode(objects, bx, by) & C.TERRAIN_MASK_WALL)) {
          return false;
        }
      }
    }
    if (structureType === 'extractor') {
      return true;
    }
    if (structureType !== 'road' && spatialCode(objects, x, y) & C.TERRAIN_MASK_WALL) {
      return false;
    }
    return true;
  }

  // A spatial grid was excluded above; what remains is a room-object collection.
  const list = collectionValues(objects);
  const at = (i: RoomObjectLike, type: string): boolean =>
    isEqual(i.x, x) && isEqual(i.y, y) && isEqual(i.type, type);

  if (list.some((i) => at(i, structureType))) {
    return false;
  }
  if (list.some((i) => at(i, 'constructionSite'))) {
    return false;
  }
  if (structureType === 'extractor') {
    return list.some((i) => at(i, 'mineral')) && !list.some((i) => at(i, 'extractor'));
  }
  if (
    structureType !== 'rampart' &&
    structureType !== 'road' &&
    list.some(
      (i) =>
        i.x === x &&
        i.y === y &&
        i.type !== 'rampart' &&
        i.type !== 'road' &&
        Boolean(getProp(C.CONSTRUCTION_COST, i.type)),
    )
  ) {
    return false;
  }
  if (x <= 0 || y <= 0 || x >= 49 || y >= 49) {
    return false;
  }
  return true;
}

/**
 * Whether one more structure of `type` is allowed by the controller level. `roomController` is the
 * controller object (counted only when owned/leveled) or a level number; `offset` widens the limit.
 */
export function checkControllerAvailability(
  type: string,
  roomObjects: RoomObjectCollection<RoomObjectLike>,
  roomController: ControllerLike | number | null | undefined,
  offset?: number,
): boolean {
  let rcl = 0;

  if (
    typeof roomController === 'object' &&
    roomController !== null &&
    roomController.level &&
    (roomController.user || roomController.owner)
  ) {
    rcl = roomController.level;
  }
  if (isNumber(roomController)) {
    rcl = roomController;
  }

  const structuresCnt = collectionValues(roomObjects).filter(
    (i) => i.type === type || (i.type === 'constructionSite' && i.structureType === type),
  ).length;
  // A level missing from the table yields NaN, which never admits a structure (as upstream's `undefined + offset`).
  const availableCnt = controllerLimit(type, rcl) + (offset || 0);

  return structuresCnt < availableCnt;
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
