/*
 * PathFinder and CostMatrix (screeps/engine `src/game/path-finder.js`, screeps/driver
 * `lib/path-finder.js`). The driver-level search is implemented by the shared terrain PathFinder.
 *
 * Upstream builds these once per sandbox from anonymous strict-mode functions wrapped by the
 * identity `register.wrapFn`, so `CostMatrix` is a plain function (callable without `new`) and every
 * function here has an empty `name`.
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { PathFinder as TerrainPathFinder } from '../../utils/pathfinder.ts';
import { exposeGlobal } from './define.ts';
import { RoomPosition } from './room-position.ts';
import { scope, type Register } from './scope.ts';

/** 2d array of costs for pathfinding. */
export interface CostMatrix {
  _bits: Uint8Array;
  set(xx: unknown, yy: unknown, val: unknown): void;
  get(xx: unknown, yy: unknown): number | undefined;
  clone(): CostMatrix;
  serialize(): number[];
}

export interface CostMatrixConstructor {
  new (): CostMatrix;
  prototype: CostMatrix;
  deserialize(data: unknown): CostMatrix;
}

/** Identity wrapper standing in for upstream `register.wrapFn`: keeps function expressions anonymous. */
function wrapFn<F>(fn: F): F {
  return fn;
}

// Boundary: a plain constructor function typed through its construct signature (upstream is not a class).
export const CostMatrix = wrapFn(function (this: CostMatrix) {
  this._bits = new Uint8Array(2500);
}) as unknown as CostMatrixConstructor;

// Prototype assignments keep the methods anonymous and enumerable like upstream; operators work on the
// untrusted arguments through `as number` so the native conversions (and BigInt errors) apply.
CostMatrix.prototype.set = function (
  this: CostMatrix,
  xx: unknown,
  yy: unknown,
  val: unknown,
): void {
  const x = (xx as number) | 0;
  const y = (yy as number) | 0;
  this._bits[x * 50 + y] = Math.min(Math.max(0, val as number), 255);
};

CostMatrix.prototype.get = function (
  this: CostMatrix,
  xx: unknown,
  yy: unknown,
): number | undefined {
  const x = (xx as number) | 0;
  const y = (yy as number) | 0;
  return this._bits[x * 50 + y];
};

CostMatrix.prototype.clone = function (this: CostMatrix): CostMatrix {
  const newMatrix = new CostMatrix();
  newMatrix._bits = new Uint8Array(this._bits);
  return newMatrix;
};

CostMatrix.prototype.serialize = function (this: CostMatrix): number[] {
  return Array.prototype.slice.apply(new Uint32Array(this._bits.buffer)) as number[];
};

CostMatrix.deserialize = function (data: unknown): CostMatrix {
  const instance = Object.create(CostMatrix.prototype) as CostMatrix;
  // Boundary: upstream hands any player value to the Uint32Array constructor.
  instance._bits = new Uint8Array(new Uint32Array(data as ArrayLike<number>).buffer);
  return instance;
};

export interface PathFinderResult {
  path: RoomPosition[];
  ops: number;
  cost?: number;
  incomplete?: boolean;
}

export interface PathFinderApi {
  readonly CostMatrix: CostMatrixConstructor;
  search(origin: unknown, goal: unknown, options?: unknown): PathFinderResult;
  use(isActive: unknown): void;
}

/** Finder over the current `staticTerrainData`; dropped by `resetTerrain` when the host replaces it. */
let terrainPathFinder: TerrainPathFinder | undefined;

/**
 * The register of the tick that created `PathFinder` (upstream closes over the first `make` call's
 * register, so later `PathFinder.use` calls only touch that stale register).
 */
let pathFinderRegister: Register | undefined;

/**
 * Discards the finder built from the previous `staticTerrainData` after the host replaced the terrain
 * (edited or removed rooms must not stay searchable). The player's `PathFinder` global is kept.
 */
export function resetTerrain(): void {
  terrainPathFinder = undefined;
}

/** The finder for the current `staticTerrainData`, built once per terrain load. */
function syncTerrain(): TerrainPathFinder {
  if (!terrainPathFinder) {
    const terrainData = scope().runtimeData.staticTerrainData;
    terrainPathFinder = new TerrainPathFinder(
      Object.entries(terrainData).map(([room, terrain]) => ({ room, terrain })),
    );
  }
  return terrainPathFinder;
}

export const PathFinder: PathFinderApi = Object.create(Object.prototype, {
  CostMatrix: {
    enumerable: true,
    value: CostMatrix,
  },

  search: {
    enumerable: true,
    value: wrapFn(function (origin: unknown, goal: unknown, options?: unknown): PathFinderResult {
      if (!goal || (Array.isArray(goal) && !goal.length)) {
        return { path: [], ops: 0 };
      }
      return syncTerrain().search(
        origin,
        goal,
        options,
        (x, y, roomName) => new RoomPosition(x, y, roomName),
      );
    }),
  },

  use: {
    enumerable: true,
    value: wrapFn(function (isActive: unknown): void {
      const register = pathFinderRegister ?? scope().register;
      if (!isActive) {
        register.deprecated('`PathFinder.use` is considered deprecated and will be removed soon.');
      }
      register._useNewPathFinder = !!isActive;
    }),
  },
}) as PathFinderApi;

export function make(): void {
  syncTerrain();

  if (scope().globals.PathFinder) {
    return;
  }

  pathFinderRegister = scope().register;
  exposeGlobal('PathFinder', PathFinder);
}
