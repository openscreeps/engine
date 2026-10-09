/*
 * Ported from @screeps/engine src/utils.js and @screeps/common index.js.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import { collectionValues } from './lodash.ts';

/**
 * Room terrain as stored in the world: either the 2500-character string of digits (`y * 50 + x`)
 * or the equivalent per-tile code array.
 */
export type RoomTerrainData = string | Uint8Array;

/** Per-tile character grid produced by {@link decodeTerrainByRoom} (`grid[y][x]`). */
export type TerrainSpatial = string[][];

/** Terrain tile objects as found in legacy `terrain` collections. */
export interface TerrainTile {
  readonly x: number;
  readonly y: number;
  readonly type: string;
}

export interface DecodedTerrainTile {
  room: string;
  x: number;
  y: number;
  type: 'wall' | 'swamp';
}

/** Room `terrain` document (`{type: 'terrain', room, terrain}`). */
export interface TerrainDocument {
  readonly type: string;
  readonly room: string;
  readonly terrain: string;
}

type Collection<T> = Readonly<Record<string, T>> | readonly T[];

/** Builds the terrain string from wall/swamp tile objects. */
export function encodeTerrain(terrain: Collection<TerrainTile>): string {
  const codes = new Uint8Array(2500);
  for (const tile of collectionValues(terrain)) {
    const { x, y } = tile;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 49 || y < 0 || y > 49) {
      continue;
    }
    const index = y * 50 + x;
    if (tile.type === 'wall') {
      codes[index] = (codes[index] ?? 0) | C.TERRAIN_MASK_WALL;
    }
    if (tile.type === 'swamp') {
      codes[index] = (codes[index] ?? 0) | C.TERRAIN_MASK_SWAMP;
    }
  }
  let result = '';
  for (const code of codes) {
    result += String(code);
  }
  return result;
}

/** Engine `decodeTerrain`: expands every `terrain` document into wall/swamp tile objects. */
export function decodeTerrain(items: Collection<TerrainDocument>): DecodedTerrainTile[] {
  const result: DecodedTerrainTile[] = [];
  for (const item of collectionValues(items)) {
    if (item.type !== 'terrain') {
      continue;
    }
    result.push(...decodeRoomTerrain(item.terrain, item.room));
  }
  return result;
}

/** `@screeps/common` `decodeTerrain(str, room)`: expands one room's terrain string into tile objects. */
export function decodeRoomTerrain(terrain: string, room: string): DecodedTerrainTile[] {
  const result: DecodedTerrainTile[] = [];
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 50; x++) {
      const code = Number(terrain.charAt(y * 50 + x));
      if (code & C.TERRAIN_MASK_WALL) {
        result.push({ room, x, y, type: 'wall' });
      }
      if (code & C.TERRAIN_MASK_SWAMP) {
        result.push({ room, x, y, type: 'swamp' });
      }
    }
  }
  return result;
}

export interface DecodedTerrainByRoom {
  /** `spatial[roomName][y][x]` is the terrain digit character. */
  readonly spatial: Record<string, TerrainSpatial>;
  /** Rooms seen, in document order (upstream stored an always-empty array per room name). */
  readonly rooms: Record<string, never[]>;
}

/** Engine `decodeTerrainByRoom`: per-room character grids. */
export function decodeTerrainByRoom(items: Collection<TerrainDocument>): DecodedTerrainByRoom {
  const result: DecodedTerrainByRoom = { spatial: {}, rooms: {} };
  for (const item of collectionValues(items)) {
    if (item.type !== 'terrain') {
      continue;
    }
    result.rooms[item.room] ??= [];
    const grid: TerrainSpatial = new Array<string[]>(50);
    for (let y = 0; y < 50; y++) {
      const row = new Array<string>(50);
      for (let x = 0; x < 50; x++) {
        row[x] = item.terrain.charAt(y * 50 + x);
      }
      grid[y] = row;
    }
    result.spatial[item.room] = grid;
  }
  return result;
}

/** Whether the terrain tile at `(x, y)` has any bit of `mask` set. */
export function checkTerrain(
  terrain: RoomTerrainData,
  x: number,
  y: number,
  mask: number,
): boolean {
  const code =
    terrain instanceof Uint8Array ? terrain[y * 50 + x] : Number(terrain.charAt(y * 50 + x));
  // An out-of-range Uint8Array read is `undefined`, which upstream coerced to 0 via `&`.
  return ((code ?? 0) & mask) > 0;
}
