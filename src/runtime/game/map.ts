/*
 * Game.map (screeps/engine `src/game/map.js`).
 *
 * Upstream map.js is sloppy-mode code: `this` is coerced with `sloppyThis`, and every operation on
 * player-supplied values goes through the JS-semantics helpers so conversions, inherited property
 * lookups and thrown errors match.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { getRoomNameFromXY } from '../../utils/rooms.ts';
import { jsAdd, jsBitAnd, jsConcat, jsGt, jsLt, jsMul } from '../../utils/js.ts';
import { isObject } from '../../utils/lodash.ts';
import { Heap, OpenClosed } from '../../utils/path-utils.ts';
import { getProp } from '../../utils/tables.ts';
import { contains, isArray, isUndefined, sloppyThis } from './compat.ts';
import { RoomPosition } from './room-position.ts';
import { scope } from './scope.ts';

const kRouteGrid = 30;

/** Calls `target[name](...args)` like upstream `name.<method>(…)` on an untrusted room name. */
function callNameMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = getProp(target, method);
  if (typeof fn !== 'function') {
    throw new TypeError(`name.${method} is not a function`);
  }
  const result: unknown = Reflect.apply(fn, target, args);
  return result;
}

/**
 * Upstream `utils.roomNameToXY` applied to an untrusted value: the `substr`/`charAt` methods are
 * looked up on the value itself and `parseInt` performs its own ToString, exactly like upstream.
 */
export function roomNameToXYLoose(name: unknown): [number, number] {
  // Boundary: `parseInt` applies ToString to whatever `substr` returned, like upstream.
  let xx = parseInt(callNameMethod(name, 'substr', [1]) as string, 10);
  let verticalPos = 2;
  if (xx >= 100) {
    verticalPos = 4;
  } else if (xx >= 10) {
    verticalPos = 3;
  }
  let yy = parseInt(callNameMethod(name, 'substr', [verticalPos + 1]) as string, 10);
  const horizontalDir = callNameMethod(name, 'charAt', [0]);
  const verticalDir = callNameMethod(name, 'charAt', [verticalPos]);
  if (horizontalDir === 'W' || horizontalDir === 'w') {
    xx = -xx - 1;
  }
  if (verticalDir === 'N' || verticalDir === 'n') {
    yy = -yy - 1;
  }
  return [xx, yy];
}

/** Upstream `utils.calcRoomsDistance` on untrusted room names (`driver.getWorldSize()` passed in). */
export function calcRoomsDistanceLoose(
  room1: unknown,
  room2: unknown,
  continuous: unknown,
  worldSize: number,
): number {
  const [x1, y1] = roomNameToXYLoose(room1);
  const [x2, y2] = roomNameToXYLoose(room2);
  let dx = Math.abs(x2 - x1);
  let dy = Math.abs(y2 - y1);
  if (continuous) {
    dx = Math.min(worldSize - dx, dx);
    dy = Math.min(worldSize - dy, dy);
  }
  return Math.max(dx, dy);
}

/** RegExp test with the regexp's own ToString of the argument (symbols throw like upstream). */
function testRoomName(re: RegExp, value: unknown): boolean {
  // Boundary: `RegExp.prototype.test` performs ToString on any value.
  return re.test(value as string);
}

const roomNameRe = /^(W|E)\d+(N|S)\d+$/;
const routeRoomNameRe = /(W|E)\d+(N|S)\d+$/;

export interface RouteStep {
  exit: number;
  room: string;
}

export interface RoomStatus {
  status: 'normal' | 'closed' | 'novice' | 'respawn';
  timestamp: unknown;
}

export interface MapVisual {
  circle(pos: unknown, style?: unknown): object;
  line(pos1: unknown, pos2: unknown, style?: unknown): object;
  rect(pos: unknown, w: unknown, h: unknown, style?: unknown): object;
  poly(points: unknown, style?: unknown): object;
  text(text: unknown, pos: unknown, style?: unknown): object;
  clear(): object;
  getSize(): number;
  export(): string | undefined;
  import(data: unknown): object;
}

export interface GameMap {
  findRoute(fromRoom: unknown, toRoom: unknown, opts?: unknown): RouteStep[] | number;
  findExit(fromRoom: unknown, toRoom: unknown, opts?: unknown): unknown;
  describeExits(roomName: unknown): Record<string, string> | null;
  isRoomAvailable(roomName: unknown): boolean;
  getRoomStatus(roomName: unknown): RoomStatus | undefined;
  getTerrainAt(x: unknown, y?: unknown, roomName?: unknown): 'wall' | 'swamp' | 'plain' | undefined;
  getRoomTerrain(roomName: unknown): unknown;
  getRoomLinearDistance(roomName1: unknown, roomName2: unknown, continuous?: unknown): number;
  getWorldSize(): number;
  readonly visual: MapVisual;
}

function assertRoomPosition(pos: unknown, message: string): asserts pos is RoomPosition {
  if (!(pos instanceof RoomPosition)) {
    throw new Error(message);
  }
}

/** `globals.console.addVisual("map", …)`, reading the console at call time like upstream. */
function addMapVisual(data: unknown): void {
  scope().globals.console.addVisual('map', data);
}

function makeVisual(): MapVisual {
  return Object.defineProperties(
    {},
    {
      circle: {
        value: function (this: unknown, pos: unknown, style?: unknown): object {
          assertRoomPosition(pos, 'Invalid pos, RoomPosition expected');
          addMapVisual({
            t: 'c',
            x: pos.x,
            y: pos.y,
            n: pos.roomName,
            s: style || {},
          });
          return sloppyThis(this);
        },
      },
      line: {
        value: function (this: unknown, pos1: unknown, pos2: unknown, style?: unknown): object {
          assertRoomPosition(pos1, 'Invalid pos1, RoomPosition expected');
          assertRoomPosition(pos2, 'Invalid pos2, RoomPosition expected');
          addMapVisual({
            t: 'l',
            x1: pos1.x,
            y1: pos1.y,
            n1: pos1.roomName,
            x2: pos2.x,
            y2: pos2.y,
            n2: pos2.roomName,
            s: style || {},
          });
          return sloppyThis(this);
        },
      },
      rect: {
        value: function (
          this: unknown,
          pos: unknown,
          w: unknown,
          h: unknown,
          style?: unknown,
        ): object {
          assertRoomPosition(pos, 'Invalid pos, RoomPosition expected');
          addMapVisual({
            t: 'r',
            x: pos.x,
            y: pos.y,
            n: pos.roomName,
            w,
            h,
            s: style || {},
          });
          return sloppyThis(this);
        },
      },
      poly: {
        value: function (this: unknown, points: unknown, style?: unknown): object {
          if (isArray(points) && lodashSomeTruthy(points)) {
            const mapped = points.map((i) => {
              const p = getProp(i, 'pos') || i;
              return { x: getProp(p, 'x'), y: getProp(p, 'y'), n: getProp(p, 'roomName') };
            });
            addMapVisual({
              t: 'p',
              points: mapped,
              s: style || {},
            });
          }
          return sloppyThis(this);
        },
      },
      text: {
        value: function (this: unknown, text: unknown, pos: unknown, style?: unknown): object {
          assertRoomPosition(pos, 'Invalid pos , RoomPosition expected');
          addMapVisual({
            t: 't',
            text,
            x: pos.x,
            y: pos.y,
            n: pos.roomName,
            s: style || {},
          });
          return sloppyThis(this);
        },
      },
      clear: {
        value: function (this: unknown): object {
          scope().globals.console.clearVisual('map');
          return sloppyThis(this);
        },
      },
      getSize: {
        value: function (): number {
          return scope().globals.console.getVisualSize('map');
        },
      },
      export: {
        value: function (): string | undefined {
          return scope().globals.console.getVisual('map');
        },
      },
      import: {
        value: function (this: unknown, data: unknown): object {
          addMapVisual(jsConcat(data));
          return sloppyThis(this);
        },
      },
    },
  ) as MapVisual;
}

/** lodash 3 `_.some(array)` without predicate: index loop over every slot (holes read as `undefined`). */
function lodashSomeTruthy(array: unknown[]): boolean {
  const length = array.length;
  for (let index = 0; index < length; index++) {
    if (array[index]) {
      return true;
    }
  }
  return false;
}

export function makeMap(): GameMap {
  const { runtimeData, register } = scope();

  // Route search state is per map object (upstream `makeMap` closure variables).
  let heap: Heap | undefined;
  let openClosed: OpenClosed | undefined;
  let parents: Uint16Array | undefined;
  let originX = 0;
  let originY = 0;
  let toX = 0;
  let toY = 0;
  let visual: MapVisual | undefined;

  const accessibleRooms: unknown = JSON.parse(runtimeData.accessibleRooms);

  function describeExits(roomName: unknown): Record<string, string> | null {
    if (!testRoomName(roomNameRe, roomName)) {
      return null;
    }
    const [x, y] = roomNameToXYLoose(roomName);
    const gridItem = getProp(runtimeData.mapGrid.gridData, `${String(x)},${String(y)}`);
    if (!gridItem) {
      return null;
    }

    const exits: Record<string, string> = {};

    if (getProp(gridItem, 't')) {
      exits[C.TOP] = getRoomNameFromXY(x, y - 1);
    }
    if (getProp(gridItem, 'b')) {
      exits[C.BOTTOM] = getRoomNameFromXY(x, y + 1);
    }
    if (getProp(gridItem, 'l')) {
      exits[C.LEFT] = getRoomNameFromXY(x - 1, y);
    }
    if (getProp(gridItem, 'r')) {
      exits[C.RIGHT] = getRoomNameFromXY(x + 1, y);
    }

    return exits;
  }

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

  const map = {
    findRoute(fromRoomArg: unknown, toRoomArg: unknown, opts?: unknown): RouteStep[] | number {
      let fromRoom = fromRoomArg;
      let toRoom = toRoomArg;
      if (isObject(fromRoom)) {
        fromRoom = getProp(fromRoom, 'name');
      }
      if (isObject(toRoom)) {
        toRoom = getProp(toRoom, 'name');
      }
      // Boundary: upstream compares with loose equality.
      if (fromRoom == toRoom) {
        return [];
      }

      if (!testRoomName(routeRoomNameRe, fromRoom) || !testRoomName(routeRoomNameRe, toRoom)) {
        return C.ERR_NO_PATH;
      }

      const [fromX, fromY] = roomNameToXYLoose(fromRoom);
      [toX, toY] = roomNameToXYLoose(toRoom);

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
      const routeCallback: unknown =
        (opts && getProp(opts, 'routeCallback')) ||
        function () {
          return 1;
        };

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
        // for-in like upstream: inherited enumerable keys are visited too (`null` iterates nothing).
        for (const dir in exits ?? (Object.create(null) as object)) {
          // Calculate costs and check if this node was already visited
          const roomName = getProp(exits, dir);
          // Upstream builds the (unused) `graphKey` string, converting `roomName`.
          jsAdd(`${fromRoomName}:`, roomName);
          const [nxx, nyy] = roomNameToXYLoose(roomName);
          const neighborIndex = xyToIndex(nxx, nyy);
          if (neighborIndex === undefined || openClosed.isClosed(neighborIndex)) {
            continue;
          }
          if (typeof routeCallback !== 'function') {
            throw new TypeError('routeCallback is not a function');
          }
          const cost =
            Number(Reflect.apply(routeCallback, undefined, [roomName, fromRoomName])) || 1;
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

    findExit(this: unknown, fromRoom: unknown, toRoom: unknown, opts?: unknown): unknown {
      const self = sloppyThis(this);
      const findRoute = getProp(self, 'findRoute');
      if (typeof findRoute !== 'function') {
        throw new TypeError('this.findRoute is not a function');
      }
      const route: unknown = Reflect.apply(findRoute, self, [fromRoom, toRoom, opts]);
      if (!isArray(route)) {
        return route;
      }
      if (!route.length) {
        return C.ERR_INVALID_ARGS;
      }
      return getProp(route[0], 'exit');
    },

    describeExits,

    isRoomAvailable(roomName: unknown): boolean {
      register.deprecated(
        'Method `Game.map.isRoomAvailable` is deprecated and will be removed. Please use `Game.map.getRoomStatus` instead.',
      );
      if (!testRoomName(roomNameRe, roomName)) {
        return false;
      }
      return contains(accessibleRooms, roomName);
    },

    getRoomStatus(roomName: unknown): RoomStatus | undefined {
      if (!testRoomName(roomNameRe, roomName)) {
        return undefined;
      }

      const statusData: unknown = runtimeData.roomStatusData;
      if (!statusData) {
        throw new Error('No runtime status data');
      }

      // Boundary: property keys are converted by the lookup itself, once per access like upstream.
      const key = roomName as PropertyKey;
      if (!isUndefined(getProp(getProp(statusData, 'closed'), key))) {
        return { status: 'closed', timestamp: getProp(getProp(statusData, 'closed'), key) };
      }
      if (!isUndefined(getProp(getProp(statusData, 'novice'), key))) {
        return { status: 'novice', timestamp: getProp(getProp(statusData, 'novice'), key) };
      }
      if (!isUndefined(getProp(getProp(statusData, 'respawn'), key))) {
        return { status: 'respawn', timestamp: getProp(getProp(statusData, 'respawn'), key) };
      }

      if (contains(accessibleRooms, roomName)) {
        return { status: 'normal', timestamp: null };
      }

      return { status: 'closed', timestamp: null };
    },

    getTerrainAt(
      xArg: unknown,
      yArg?: unknown,
      roomNameArg?: unknown,
    ): 'wall' | 'swamp' | 'plain' | undefined {
      register.deprecated(
        'Method `Game.map.getTerrainAt` is deprecated and will be removed. Please use a faster method `Game.map.getRoomTerrain` instead.',
      );
      let x = xArg;
      let y = yArg;
      let roomName = roomNameArg;
      if (isObject(x)) {
        y = getProp(x, 'y');
        roomName = getProp(x, 'roomName');
        x = getProp(x, 'x');
      }

      // check if coordinates are out of bounds
      if (jsLt(x, 0) || jsGt(x, 49) || jsLt(y, 0) || jsGt(y, 49)) {
        return undefined;
      }

      const staticTerrainData: unknown = runtimeData.staticTerrainData;
      // Boundary: property keys are converted by the lookup itself, once per access like upstream.
      const roomKey = roomName as PropertyKey;
      if (!staticTerrainData || !getProp(staticTerrainData, roomKey)) {
        return undefined;
      }
      const terrain = getProp(
        getProp(staticTerrainData, roomKey),
        jsAdd(jsMul(y, 50), x) as PropertyKey,
      );
      if (jsBitAnd(terrain, C.TERRAIN_MASK_WALL)) {
        return 'wall';
      }
      if (jsBitAnd(terrain, C.TERRAIN_MASK_SWAMP)) {
        return 'swamp';
      }
      return 'plain';
    },

    getRoomTerrain(roomName: unknown): unknown {
      const Terrain = getProp(getProp(scope().globals, 'Room'), 'Terrain');
      if (typeof Terrain !== 'function') {
        throw new TypeError('globals.Room.Terrain is not a constructor');
      }
      // Probe constructibility without invoking it, so non-constructors throw upstream's message.
      try {
        Reflect.construct(Object, [], Terrain);
      } catch {
        throw new TypeError('globals.Room.Terrain is not a constructor');
      }
      const terrain: unknown = Reflect.construct(Terrain, [roomName]);
      return terrain;
    },

    getRoomLinearDistance(roomName1: unknown, roomName2: unknown, continuous?: unknown): number {
      return calcRoomsDistanceLoose(roomName1, roomName2, continuous, runtimeData.worldSize);
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
