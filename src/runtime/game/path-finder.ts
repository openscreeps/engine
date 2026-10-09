/*
 * PathFinder and CostMatrix (screeps/engine `src/game/path-finder.js`, screeps/driver
 * `lib/path-finder.js`). The driver-level search is implemented by the shared terrain PathFinder.
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { PathFinder as TerrainPathFinder } from '../../utils/pathfinder.ts';
import { exposeGlobal, finalizeClass } from './define.ts';
import { RoomPosition } from './room-position.ts';
import { scope } from './scope.ts';

/** 2d array of costs for pathfinding. */
export class CostMatrix {
    declare _bits: Uint8Array;

    constructor() {
        this._bits = new Uint8Array(2500);
    }

    set(xx: unknown, yy: unknown, val: unknown): void {
        const x = Number(xx) | 0;
        const y = Number(yy) | 0;
        this._bits[x * 50 + y] = Math.min(Math.max(0, Number(val)), 255);
    }

    get(xx: unknown, yy: unknown): number | undefined {
        const x = Number(xx) | 0;
        const y = Number(yy) | 0;
        return this._bits[x * 50 + y];
    }

    clone(): CostMatrix {
        const newMatrix = new CostMatrix();
        newMatrix._bits = new Uint8Array(this._bits);
        return newMatrix;
    }

    serialize(): number[] {
        return Array.from(new Uint32Array(this._bits.buffer));
    }

    static deserialize(data: unknown): CostMatrix {
        const instance = Object.create(CostMatrix.prototype) as CostMatrix;
        // Boundary: upstream hands any player value to the Uint32Array constructor.
        instance._bits = new Uint8Array(new Uint32Array(data as ArrayLike<number>).buffer);
        return instance;
    }
}
// Upstream is a plain function: `constructor` keeps its default non-enumerable descriptor.
finalizeClass(CostMatrix, { enumerableConstructor: false });

export interface PathFinderResult {
    path: RoomPosition[];
    ops: number;
    cost?: number;
    incomplete?: boolean;
}

export interface PathFinderApi {
    readonly CostMatrix: typeof CostMatrix;
    search(origin: unknown, goal: unknown, options?: unknown): PathFinderResult;
    use(isActive: unknown): void;
}

let terrainPathFinder: TerrainPathFinder | undefined;
const loadedRooms = new Set<string>();

/** Loads terrain of rooms that appeared in `staticTerrainData` since the last call. */
function syncTerrain(): TerrainPathFinder {
    const finder = terrainPathFinder ?? new TerrainPathFinder();
    terrainPathFinder = finder;
    const terrainData = scope().runtimeData.staticTerrainData;
    const added: { room: string; terrain: Uint8Array }[] = [];
    for (const room of Object.keys(terrainData)) {
        const terrain = terrainData[room];
        if (terrain && !loadedRooms.has(room)) {
            loadedRooms.add(room);
            added.push({ room, terrain });
        }
    }
    if (added.length) {
        finder.loadTerrain(added);
    }
    return finder;
}

export const PathFinder: PathFinderApi = Object.create(Object.prototype, {
    CostMatrix: {
        enumerable: true,
        value: CostMatrix,
    },

    search: {
        enumerable: true,
        value: function (origin: unknown, goal: unknown, options?: unknown): PathFinderResult {
            if (!goal || (Array.isArray(goal) && !goal.length)) {
                return { path: [], ops: 0 };
            }
            return syncTerrain().search(origin, goal, options, (x, y, roomName) => new RoomPosition(x, y, roomName));
        },
    },

    use: {
        enumerable: true,
        value: function (isActive: unknown): void {
            const { register } = scope();
            if (!isActive) {
                register.deprecated('`PathFinder.use` is considered deprecated and will be removed soon.');
            }
            register._useNewPathFinder = !!isActive;
        },
    },
}) as PathFinderApi;

export function make(): void {
    syncTerrain();

    if (scope().globals.PathFinder) {
        return;
    }

    exposeGlobal('PathFinder', PathFinder);
}
