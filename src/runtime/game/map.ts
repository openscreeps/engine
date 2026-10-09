/*
 * Game.map (screeps/engine `src/game/map.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { calcRoomsDistance, getRoomNameFromXY, roomNameToXY } from '../../utils/index.ts';
import { Heap, OpenClosed } from '../../utils/path-utils.ts';
import { contains, isArray, isObject, isUndefined } from './compat.ts';
import { RoomPosition } from './room-position.ts';
import { RoomTerrain } from './rooms.ts';
import { scope } from './scope.ts';

const kRouteGrid = 30;

/** `value[key]` with the TypeError JS throws for `null`/`undefined` bases. */
export function readProperty(value: unknown, key: string): unknown {
    if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)} (reading '${key}')`);
    }
    return (Object(value) as Record<string, unknown>)[key];
}

/** The room name argument of upstream `utils.roomNameToXY`, throwing where `name.substr` would. */
export function roomNameString(name: unknown): string {
    if (typeof name === 'string') {
        return name;
    }
    if (name === null || name === undefined) {
        throw new TypeError(`Cannot read properties of ${String(name)} (reading 'substr')`);
    }
    if (name instanceof String) {
        return name.valueOf();
    }
    throw new TypeError('name.substr is not a function');
}

export interface RouteStep {
    exit: number;
    room: string;
}

export interface RoomStatus {
    status: 'normal' | 'closed' | 'novice' | 'respawn';
    timestamp: number | null;
}

export interface MapVisual {
    circle(pos: unknown, style?: unknown): MapVisual;
    line(pos1: unknown, pos2: unknown, style?: unknown): MapVisual;
    rect(pos: unknown, w: unknown, h: unknown, style?: unknown): MapVisual;
    poly(points: unknown, style?: unknown): MapVisual;
    text(text: unknown, pos: unknown, style?: unknown): MapVisual;
    clear(): MapVisual;
    getSize(): number;
    export(): string | undefined;
    import(data: unknown): MapVisual;
}

export interface GameMap {
    findRoute(fromRoom: unknown, toRoom: unknown, opts?: unknown): RouteStep[] | number;
    findExit(this: GameMap, fromRoom: unknown, toRoom: unknown, opts?: unknown): number;
    describeExits(roomName: unknown): Record<string, string> | null;
    isRoomAvailable(roomName: unknown): boolean;
    getRoomStatus(roomName: unknown): RoomStatus | undefined;
    getTerrainAt(x: unknown, y?: unknown, roomName?: unknown): 'wall' | 'swamp' | 'plain' | undefined;
    getRoomTerrain(roomName: unknown): RoomTerrain;
    getRoomLinearDistance(roomName1: unknown, roomName2: unknown, continuous?: unknown): number;
    getWorldSize(): number;
    readonly visual: MapVisual;
}

// Route search structures, reused across calls like upstream.
let heap: Heap | undefined;
let openClosed: OpenClosed | undefined;
let parents: Uint16Array | undefined;
let originX = 0;
let originY = 0;
let toX = 0;
let toY = 0;

function xyToIndex(xx: number, yy: number): number | undefined {
    const ox = originX - xx;
    const oy = originY - yy;
    if (ox < 0 || ox >= kRouteGrid * 2 || oy < 0 || oy >= kRouteGrid * 2) {
        return undefined;
    }
    return ox * kRouteGrid * 2 + oy;
}

function indexToXY(index: number): [number, number] {
    return [originX - Math.floor(index / (kRouteGrid * 2)), originY - (index % (kRouteGrid * 2))];
}

function heuristic(xx: number, yy: number): number {
    return Math.abs(xx - toX) + Math.abs(yy - toY);
}

function describeExits(roomName: unknown): Record<string, string> | null {
    if (!/^(W|E)\d+(N|S)\d+$/.test(String(roomName))) {
        return null;
    }
    const [x, y] = roomNameToXY(roomNameString(roomName));
    const gridItem = scope().runtimeData.mapGrid.gridData[`${String(x)},${String(y)}`];
    if (!gridItem) {
        return null;
    }

    const exits: Record<string, string> = {};

    if (gridItem.t) {
        exits[C.TOP] = getRoomNameFromXY(x, y - 1);
    }
    if (gridItem.b) {
        exits[C.BOTTOM] = getRoomNameFromXY(x, y + 1);
    }
    if (gridItem.l) {
        exits[C.LEFT] = getRoomNameFromXY(x - 1, y);
    }
    if (gridItem.r) {
        exits[C.RIGHT] = getRoomNameFromXY(x + 1, y);
    }

    return exits;
}

function terrainByte(terrain: Uint8Array, key: number | string): number | undefined {
    if (typeof key === 'number') {
        return terrain[key];
    }
    // Typed arrays only resolve canonical numeric string keys to elements.
    return String(Number(key)) === key ? terrain[Number(key)] : undefined;
}

function assertRoomPosition(pos: unknown, name: string): asserts pos is RoomPosition {
    if (!(pos instanceof RoomPosition)) {
        throw new Error(`Invalid ${name}, RoomPosition expected`);
    }
}

function makeVisual(): MapVisual {
    const { console } = scope().globals;
    return Object.defineProperties(
        {},
        {
            circle: {
                value: function (this: MapVisual, pos: unknown, style?: unknown): MapVisual {
                    assertRoomPosition(pos, 'pos');
                    console.addVisual('map', {
                        t: 'c',
                        x: pos.x,
                        y: pos.y,
                        n: pos.roomName,
                        s: style || {},
                    });
                    return this;
                },
            },
            line: {
                value: function (this: MapVisual, pos1: unknown, pos2: unknown, style?: unknown): MapVisual {
                    assertRoomPosition(pos1, 'pos1');
                    assertRoomPosition(pos2, 'pos2');
                    console.addVisual('map', {
                        t: 'l',
                        x1: pos1.x,
                        y1: pos1.y,
                        n1: pos1.roomName,
                        x2: pos2.x,
                        y2: pos2.y,
                        n2: pos2.roomName,
                        s: style || {},
                    });
                    return this;
                },
            },
            rect: {
                value: function (this: MapVisual, pos: unknown, w: unknown, h: unknown, style?: unknown): MapVisual {
                    assertRoomPosition(pos, 'pos');
                    console.addVisual('map', {
                        t: 'r',
                        x: pos.x,
                        y: pos.y,
                        n: pos.roomName,
                        w,
                        h,
                        s: style || {},
                    });
                    return this;
                },
            },
            poly: {
                value: function (this: MapVisual, points: unknown, style?: unknown): MapVisual {
                    if (isArray(points) && points.some(Boolean)) {
                        const mapped = points.map((i) => {
                            const p = readProperty(i, 'pos') || i;
                            return { x: readProperty(p, 'x'), y: readProperty(p, 'y'), n: readProperty(p, 'roomName') };
                        });
                        console.addVisual('map', {
                            t: 'p',
                            points: mapped,
                            s: style || {},
                        });
                    }
                    return this;
                },
            },
            text: {
                value: function (this: MapVisual, text: unknown, pos: unknown, style?: unknown): MapVisual {
                    assertRoomPosition(pos, 'pos ');
                    console.addVisual('map', {
                        t: 't',
                        text,
                        x: pos.x,
                        y: pos.y,
                        n: pos.roomName,
                        s: style || {},
                    });
                    return this;
                },
            },
            clear: {
                value: function (this: MapVisual): MapVisual {
                    console.clearVisual('map');
                    return this;
                },
            },
            getSize: {
                value: function (): number {
                    return console.getVisualSize('map');
                },
            },
            export: {
                value: function (): string | undefined {
                    return console.getVisual('map');
                },
            },
            import: {
                value: function (this: MapVisual, data: unknown): MapVisual {
                    console.addVisual('map', String(data));
                    return this;
                },
            },
        },
    ) as MapVisual;
}

export function makeMap(): GameMap {
    const { runtimeData, register } = scope();
    const accessibleRooms: unknown = JSON.parse(runtimeData.accessibleRooms);
    let visual: MapVisual | undefined;

    const map = {
        findRoute(fromRoom: unknown, toRoom: unknown, opts?: unknown): RouteStep[] | number {
            let from = fromRoom;
            let to = toRoom;
            if (isObject(from)) {
                from = readProperty(from, 'name');
            }
            if (isObject(to)) {
                to = readProperty(to, 'name');
            }
            if (from == to) {
                return [];
            }

            if (!/(W|E)\d+(N|S)\d+$/.test(String(from)) || !/(W|E)\d+(N|S)\d+$/.test(String(to))) {
                return C.ERR_NO_PATH;
            }

            const [fromX, fromY] = roomNameToXY(roomNameString(from));
            [toX, toY] = roomNameToXY(roomNameString(to));

            if (fromX == toX && fromY == toY) {
                return [];
            }

            originX = fromX + kRouteGrid;
            originY = fromY + kRouteGrid;

            // Init path finding structures
            if (heap && openClosed) {
                heap.clear();
                openClosed.clear();
            } else {
                heap = new Heap(Math.pow(kRouteGrid * 2, 2), Float64Array);
                openClosed = new OpenClosed(Math.pow(kRouteGrid * 2, 2));
            }
            parents ??= new Uint16Array(Math.pow(kRouteGrid * 2, 2));
            // xyToIndex(fromX, fromY): the origin is always the grid center.
            const fromIndex = kRouteGrid * kRouteGrid * 2 + kRouteGrid;
            heap.push(fromIndex, heuristic(fromX, fromY));
            const routeCallback: unknown = (opts && readProperty(opts, 'routeCallback')) || (() => 1);

            // Astar
            while (heap.size()) {
                // Pull node off heap
                let index = heap.min();
                const fcost = heap.minPriority();

                // Close this node
                heap.pop();
                openClosed.close(index);

                // Calculate costs
                const [xx, yy] = indexToXY(index);
                const hcost = heuristic(xx, yy);
                const gcost = fcost - hcost;

                // Reached destination?
                if (hcost === 0) {
                    const route: RouteStep[] = [];
                    while (index !== fromIndex) {
                        const [cx, cy] = indexToXY(index);
                        index = parents[index] ?? 0;
                        const [nx, ny] = indexToXY(index);
                        let dir: number;
                        if (nx < cx) {
                            dir = C.FIND_EXIT_RIGHT;
                        } else if (nx > cx) {
                            dir = C.FIND_EXIT_LEFT;
                        } else if (ny < cy) {
                            dir = C.FIND_EXIT_BOTTOM;
                        } else {
                            dir = C.FIND_EXIT_TOP;
                        }
                        route.push({
                            exit: dir,
                            room: getRoomNameFromXY(cx, cy),
                        });
                    }
                    route.reverse();
                    return route;
                }

                // Add neighbors
                const fromRoomName = getRoomNameFromXY(xx, yy);
                const exits = describeExits(fromRoomName);
                for (const dir in exits) {
                    // Calculate costs and check if this node was already visited
                    const roomName = exits[dir];
                    if (roomName === undefined) {
                        continue;
                    }
                    const [nxx, nyy] = roomNameToXY(roomName);
                    const neighborIndex = xyToIndex(nxx, nyy);
                    if (neighborIndex === undefined || openClosed.isClosed(neighborIndex)) {
                        continue;
                    }
                    if (typeof routeCallback !== 'function') {
                        throw new TypeError('routeCallback is not a function');
                    }
                    // Boundary: player callback invoked like upstream `routeCallback(roomName, fromRoomName)`.
                    const callback = routeCallback as (roomName: string, fromRoomName: string) => unknown;
                    const cost = Number(callback(roomName, fromRoomName)) || 1;
                    if (cost === Infinity) {
                        continue;
                    }

                    const neighborFcost = gcost + heuristic(nxx, nyy) + cost;

                    // Add to or update heap
                    if (openClosed.isOpen(neighborIndex)) {
                        if (heap.priority(neighborIndex) > neighborFcost) {
                            heap.update(neighborIndex, neighborFcost);
                            parents[neighborIndex] = index;
                        }
                    } else {
                        heap.push(neighborIndex, neighborFcost);
                        openClosed.open(neighborIndex);
                        parents[neighborIndex] = index;
                    }
                }
            }

            return C.ERR_NO_PATH;
        },

        findExit(this: GameMap, fromRoom: unknown, toRoom: unknown, opts?: unknown): number {
            const route = this.findRoute(fromRoom, toRoom, opts);
            if (!isArray(route)) {
                return route;
            }
            const first = route[0];
            if (!first) {
                return C.ERR_INVALID_ARGS;
            }
            return first.exit;
        },

        describeExits,

        isRoomAvailable(roomName: unknown): boolean {
            register.deprecated(
                'Method `Game.map.isRoomAvailable` is deprecated and will be removed. Please use `Game.map.getRoomStatus` instead.',
            );
            if (!/^(W|E)\d+(N|S)\d+$/.test(String(roomName))) {
                return false;
            }
            return contains(accessibleRooms, roomName);
        },

        getRoomStatus(roomName: unknown): RoomStatus | undefined {
            if (!/^(W|E)\d+(N|S)\d+$/.test(String(roomName))) {
                return undefined;
            }

            // Upstream guards against missing status data; kept for runtimes delivering none.
            const statusData = runtimeData.roomStatusData as typeof runtimeData.roomStatusData | undefined;
            if (!statusData) {
                throw new Error('No runtime status data');
            }

            const key = String(roomName);
            const closed = statusData.closed[key];
            if (!isUndefined(closed)) {
                return { status: 'closed', timestamp: closed };
            }
            const novice = statusData.novice[key];
            if (!isUndefined(novice)) {
                return { status: 'novice', timestamp: novice };
            }
            const respawn = statusData.respawn[key];
            if (!isUndefined(respawn)) {
                return { status: 'respawn', timestamp: respawn };
            }

            if (contains(accessibleRooms, roomName)) {
                return { status: 'normal', timestamp: null };
            }

            return { status: 'closed', timestamp: null };
        },

        getTerrainAt(xArg: unknown, yArg?: unknown, roomNameArg?: unknown): 'wall' | 'swamp' | 'plain' | undefined {
            register.deprecated(
                'Method `Game.map.getTerrainAt` is deprecated and will be removed. Please use a faster method `Game.map.getRoomTerrain` instead.',
            );
            let x = xArg;
            let y = yArg;
            let roomName = roomNameArg;
            if (isObject(x)) {
                y = readProperty(x, 'y');
                roomName = readProperty(x, 'roomName');
                x = readProperty(x, 'x');
            }

            // check if coordinates are out of bounds
            const nx = Number(x);
            const ny = Number(y);
            if (nx < 0 || nx > 49 || ny < 0 || ny > 49) {
                return undefined;
            }

            // Upstream guards against missing terrain data; kept for runtimes delivering none.
            const staticTerrainData = runtimeData.staticTerrainData as typeof runtimeData.staticTerrainData | undefined;
            const roomTerrain = staticTerrainData?.[String(roomName)];
            if (!roomTerrain) {
                return undefined;
            }
            // `y*50+x`: a string `x` concatenates like JS `+`.
            const index = typeof x === 'string' ? String(ny * 50) + x : ny * 50 + nx;
            const terrain = terrainByte(roomTerrain, index) ?? 0;
            if (terrain & C.TERRAIN_MASK_WALL) {
                return 'wall';
            }
            if (terrain & C.TERRAIN_MASK_SWAMP) {
                return 'swamp';
            }
            return 'plain';
        },

        getRoomTerrain(roomName: unknown): RoomTerrain {
            return new RoomTerrain(roomName);
        },

        getRoomLinearDistance(roomName1: unknown, roomName2: unknown, continuous?: unknown): number {
            return calcRoomsDistance(roomNameString(roomName1), roomNameString(roomName2), !!continuous, runtimeData.worldSize);
        },

        getWorldSize(): number {
            return runtimeData.worldSize;
        },
    };

    Object.defineProperties(map, {
        visual: {
            enumerable: true,
            get(): MapVisual {
                visual ??= makeVisual();
                return visual;
            },
        },
    });

    // `visual` was attached above as an enumerable, non-configurable accessor.
    return map as typeof map & Pick<GameMap, 'visual'>;
}
