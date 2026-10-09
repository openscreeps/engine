/*
 * Port of the Screeps native path finder (Jump Point Search over a multi-room grid) and its JS glue.
 *
 * Sources: screeps/driver @ cf63d8adf902663e2ebddd7f8c5b7baa425dc928 — lib/path-finder.js,
 * native/src/pf.cc, native/src/pf.h (native code authored by Marcel Laverdet), and
 * screeps/engine src/game/path-finder.js (CostMatrix).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 *
 * The native implementation works on unsigned 32-bit integers; all coordinate and cost arithmetic below
 * is explicitly reduced with `>>> 0` / `Math.imul` to reproduce its wrap-around behaviour exactly.
 */

import type { RoomPosLike } from '../types/index.ts';

// ---------------------------------------------------------------------------
// CostMatrix

/** 50x50 matrix of movement costs (0 = use terrain, 255 = unwalkable), stored column-major (`x * 50 + y`). */
export class CostMatrix {
  _bits: Uint8Array;

  constructor() {
    this._bits = new Uint8Array(2500);
  }

  set(xx: number, yy: number, val: number): void {
    const x = xx | 0;
    const y = yy | 0;
    this._bits[x * 50 + y] = Math.min(Math.max(0, val), 255);
  }

  /** Returns `undefined` for coordinates outside the matrix, as upstream's raw typed-array read. */
  get(xx: number, yy: number): number | undefined {
    const x = xx | 0;
    const y = yy | 0;
    return this._bits[x * 50 + y];
  }

  clone(): CostMatrix {
    const newMatrix = new CostMatrix();
    newMatrix._bits = new Uint8Array(this._bits);
    return newMatrix;
  }

  /** Packs the matrix into 625 little-endian 32-bit words. */
  serialize(): number[] {
    return Array.from(new Uint32Array(this._bits.buffer));
  }

  static deserialize(data: ArrayLike<number>): CostMatrix {
    const instance = new CostMatrix();
    instance._bits = new Uint8Array(new Uint32Array(data).buffer);
    return instance;
  }
}

// ---------------------------------------------------------------------------
// Public types

export interface PathFinderGoal {
  readonly pos: RoomPosLike;
  readonly range?: number | undefined;
}

export interface PathFinderOpts {
  /** Returns a CostMatrix (anything with a 2500-byte `_bits` view), `false` to block the room, or nothing. */
  readonly roomCallback?: ((roomName: string) => unknown) | undefined;
  readonly plainCost?: number | undefined;
  readonly swampCost?: number | undefined;
  readonly flee?: boolean | undefined;
  readonly maxOps?: number | undefined;
  readonly maxRooms?: number | undefined;
  readonly maxCost?: number | undefined;
  readonly heuristicWeight?: number | undefined;
}

export interface PathFinderPosition {
  x: number;
  y: number;
  roomName: string;
}

export interface PathFinderResult<P> {
  path: P[];
  ops: number;
  cost: number;
  incomplete: boolean;
}

/** Room terrain for the path finder: digit string or code array indexed `y * 50 + x`. */
export interface PathFinderTerrainRoom {
  readonly room: string;
  readonly terrain: string | ArrayLike<number>;
}

export type MakePosition<P> = (x: number, y: number, roomName: string) => P;

// ---------------------------------------------------------------------------
// Coordinate helpers (driver lib/path-finder.js)

const kWorldSize = 255; // Talk to marcel before growing world larger than W127N127 :: E127S127
const kHalfWorld = kWorldSize >> 1;
const kMaxRooms = 64;
const obstacle = 0xffffffff;
const uint32Max = 0xffffffff;

interface MapPosition {
  xx: number;
  yy: number;
}

function parseRoomName(roomName: unknown): MapPosition {
  const room = /^([WE])([0-9]+)([NS])([0-9]+)$/.exec(String(roomName));
  if (!room) {
    throw new Error('Invalid room name');
  }
  const rx = kHalfWorld + (room[1] === 'W' ? -Number(room[2]) : Number(room[2]) + 1);
  const ry = kHalfWorld + (room[3] === 'N' ? -Number(room[4]) : Number(room[4]) + 1);
  if (!(rx >= 0 && rx <= kWorldSize && ry >= 0 && ry <= kWorldSize)) {
    throw new Error('Invalid room name');
  }
  return { xx: rx, yy: ry };
}

function generateRoomName(xx: number, yy: number): string {
  return (
    (xx <= kHalfWorld ? `W${String(kHalfWorld - xx)}` : `E${String(xx - kHalfWorld - 1)}`) +
    (yy <= kHalfWorld ? `N${String(kHalfWorld - yy)}` : `S${String(yy - kHalfWorld - 1)}`)
  );
}

/** JS `value | 0` on an arbitrary user value (ToNumber then ToInt32). */
function int32(value: unknown): number {
  const operand = value as number;
  return operand | 0;
}

/** Reads `object[key]` with JS semantics (throws on null/undefined like a plain property access). */
function prop(object: unknown, key: string): unknown {
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot read properties of ${String(object)} (reading '${key}')`);
  }
  const value: unknown = Reflect.get(Object(object), key);
  return value;
}

interface WorldPosition {
  xx: number;
  yy: number;
}

function toWorldPosition(rp: unknown): WorldPosition {
  const xx = int32(prop(rp, 'x'));
  const yy = int32(prop(rp, 'y'));
  if (!(xx >= 0 && xx < 50 && yy >= 0 && yy < 50)) {
    throw new Error('Invalid room position');
  }
  const offset = parseRoomName(prop(rp, 'roomName'));
  return {
    xx: xx + offset.xx * 50,
    yy: yy + offset.yy * 50,
  };
}

function mapId(xx: number, yy: number): number {
  // map_position_t stores uint8 coordinates of the uint32 world position divided by 50.
  return (Math.floor(xx / 50) & 0xff) | ((Math.floor(yy / 50) & 0xff) << 8);
}

function rangeTo(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(ax > bx ? ax - bx : bx - ax, ay > by ? ay - by : by - ay);
}

/** Uint32 heuristic * weight conversion (double -> uint32 truncation; NaN -> 0). */
function weighted(hCost: number, weight: number): number {
  return (hCost * weight) >>> 0;
}

// ---------------------------------------------------------------------------
// Native search engine (pf.cc)

interface Goal {
  range: number;
  xx: number;
  yy: number;
}

interface RoomInfo {
  terrain: Uint8Array;
  costMatrix: Uint8Array | null;
  mapId: number;
}

type RoomCallback = (xx: number, yy: number) => unknown;

/** Node returned by jump functions; `null` stands for upstream's `world_position_t::null()` (0, 0). */
type JumpResult = WorldPosition | null;

class SearchEngine {
  inUse = false;

  private readonly roomTable: RoomInfo[] = [];
  private roomTableSize = 0;
  private readonly reverseRoomTable = new Uint8Array(1 << 16);
  private readonly blockedRooms = new Set<number>();
  private readonly parents = new Uint32Array(2500 * kMaxRooms);
  private readonly openClosed = new Uint32Array(2500 * kMaxRooms);
  private marker = 1;
  private readonly priorities = new Uint32Array(2500 * kMaxRooms);
  private readonly heap = new Uint32Array((2500 * kMaxRooms) / 8);
  private heapSize = 0;
  private goals: Goal[] = [];
  private readonly lookTable = [obstacle, obstacle, obstacle, obstacle];
  private heuristicWeight = 1;
  private maxRooms = 0;
  private flee = false;
  private roomCallback: RoomCallback | undefined;

  private readonly terrainData: ReadonlyMap<number, Uint8Array>;

  constructor(terrainData: ReadonlyMap<number, Uint8Array>) {
    this.terrainData = terrainData;
  }

  // --- open/closed list

  private clearOpenClosed(): void {
    if (uint32Max - 2 <= this.marker) {
      this.openClosed.fill(0);
      this.marker = 1;
    } else {
      this.marker += 2;
    }
  }

  // --- heap

  private heapPop(): [index: number, priority: number] {
    const heap = this.heap;
    const priorities = this.priorities;
    const top = heap[1] ?? 0;
    const ret: [number, number] = [top, priorities[top] ?? 0];
    heap[1] = heap[this.heapSize] ?? 0;
    --this.heapSize;
    let vv = 1;
    for (;;) {
      const uu = vv;
      if ((uu << 1) + 1 <= this.heapSize) {
        if ((priorities[heap[uu] ?? 0] ?? 0) >= (priorities[heap[uu << 1] ?? 0] ?? 0)) {
          vv = uu << 1;
        }
        if ((priorities[heap[vv] ?? 0] ?? 0) >= (priorities[heap[(uu << 1) + 1] ?? 0] ?? 0)) {
          vv = (uu << 1) + 1;
        }
      } else if (uu << 1 <= this.heapSize) {
        if ((priorities[heap[uu] ?? 0] ?? 0) >= (priorities[heap[uu << 1] ?? 0] ?? 0)) {
          vv = uu << 1;
        }
      }
      if (uu !== vv) {
        const tmp = heap[uu] ?? 0;
        heap[uu] = heap[vv] ?? 0;
        heap[vv] = tmp;
      } else {
        break;
      }
    }
    return ret;
  }

  private heapInsert(index: number, priority: number): void {
    if (this.heapSize === this.heap.length - 1) {
      throw new Error('Max heap');
    }
    this.priorities[index] = priority;
    ++this.heapSize;
    this.heap[this.heapSize] = index;
    this.heapBubbleUp(this.heapSize);
  }

  private heapUpdate(index: number, priority: number): void {
    for (let ii = this.heapSize; ii > 0; --ii) {
      if (this.heap[ii] === index) {
        this.priorities[index] = priority;
        this.heapBubbleUp(ii);
        return;
      }
    }
  }

  private heapBubbleUp(start: number): void {
    const heap = this.heap;
    const priorities = this.priorities;
    let ii = start;
    while (ii !== 1) {
      const child = heap[ii] ?? 0;
      const parent = heap[ii >> 1] ?? 0;
      if ((priorities[child] ?? 0) <= (priorities[parent] ?? 0)) {
        heap[ii] = parent;
        heap[ii >> 1] = child;
        ii = ii >> 1;
      } else {
        return;
      }
    }
  }

  // --- rooms

  /** Room index (1-based) for a map position, allocating it if possible; 0 when unavailable. */
  private roomIndexFromPos(id: number): number {
    const roomIndex = this.reverseRoomTable[id] ?? 0;
    if (roomIndex !== 0) {
      return roomIndex;
    }
    if (this.roomTableSize >= this.maxRooms) {
      return 0;
    }
    if (this.blockedRooms.has(id)) {
      return 0;
    }
    const terrain = this.terrainData.get(id);
    if (!terrain) {
      throw new Error('Could not load terrain data');
    }
    let costMatrix: Uint8Array | null = null;
    if (this.roomCallback) {
      const ret = this.roomCallback(id & 0xff, id >> 8);
      if (ret === false) {
        this.blockedRooms.add(id);
        return 0;
      }
      if (ArrayBuffer.isView(ret) && ret.byteLength === 2500) {
        costMatrix = new Uint8Array(ret.buffer, ret.byteOffset, 2500);
      }
    }
    this.roomTable[this.roomTableSize++] = { terrain, costMatrix, mapId: id };
    this.reverseRoomTable[id] = this.roomTableSize;
    return this.roomTableSize;
  }

  private indexFromPos(xx: number, yy: number): number {
    const roomIndex = this.roomIndexFromPos(mapId(xx, yy));
    if (roomIndex === 0) {
      throw new Error('Invalid invocation of index_from_pos');
    }
    return (roomIndex - 1) * 2500 + (xx % 50) * 50 + (yy % 50);
  }

  private posFromIndex(index: number): WorldPosition {
    const roomIndex = Math.floor(index / 2500);
    const room = this.roomTable[roomIndex];
    const id = room ? room.mapId : 0;
    const coord = index - roomIndex * 2500;
    return {
      xx: (Math.floor(coord / 50) + (id & 0xff) * 50) >>> 0,
      yy: ((coord % 50) + (id >> 8) * 50) >>> 0,
    };
  }

  // --- costs

  private pushNode(parentIndex: number, xx: number, yy: number, gCost: number): void {
    const index = this.indexFromPos(xx, yy);
    if (this.openClosed[index] === this.marker + 1) {
      return;
    }
    const hCost = weighted(this.heuristic(xx, yy), this.heuristicWeight);
    const fCost = (hCost + gCost) >>> 0;

    if (this.openClosed[index] === this.marker) {
      if ((this.priorities[index] ?? 0) > fCost) {
        this.heapUpdate(index, fCost);
        this.parents[index] = parentIndex;
      }
    } else {
      this.heapInsert(index, fCost);
      this.openClosed[index] = this.marker;
      this.parents[index] = parentIndex;
    }
  }

  private look(xx: number, yy: number): number {
    const roomIndex = this.roomIndexFromPos(mapId(xx, yy));
    if (roomIndex === 0) {
      return obstacle;
    }
    const room = this.roomTable[roomIndex - 1];
    if (!room) {
      return obstacle;
    }
    const tile = (xx % 50) * 50 + (yy % 50);
    if (room.costMatrix) {
      const tmp = room.costMatrix[tile] ?? 0;
      if (tmp !== 0) {
        return tmp === 0xff ? obstacle : tmp;
      }
    }
    return this.lookTable[(room.terrain[tile] ?? 0) & 0x03] ?? obstacle;
  }

  private heuristic(xx: number, yy: number): number {
    if (this.flee) {
      let ret = 0;
      for (const goal of this.goals) {
        const dist = rangeTo(xx, yy, goal.xx, goal.yy);
        if (dist < goal.range) {
          ret = Math.max(ret, goal.range - dist);
        }
      }
      return ret;
    }
    let ret = uint32Max;
    for (const goal of this.goals) {
      const dist = rangeTo(xx, yy, goal.xx, goal.yy);
      if (dist > goal.range) {
        ret = Math.min(ret, dist - goal.range);
      } else {
        ret = 0;
      }
    }
    return ret;
  }

  // --- A*

  private astar(index: number, px: number, py: number, gCost: number): void {
    for (let dir = 0; dir < 8; ++dir) {
      const [ox, oy] = directionOffsets[dir] ?? [0, 0];
      const nx = (px + ox) >>> 0;
      const ny = (py + oy) >>> 0;

      // If this is a portal node there are some moves which will be impossible, and should be discarded
      if (px % 50 === 0) {
        if (nx % 50 === 49 && py !== ny) {
          continue;
        } else if (px === nx) {
          continue;
        }
      } else if (px % 50 === 49) {
        if (nx % 50 === 0 && py !== ny) {
          continue;
        } else if (px === nx) {
          continue;
        }
      } else if (py % 50 === 0) {
        if (ny % 50 === 49 && px !== nx) {
          continue;
        } else if (py === ny) {
          continue;
        }
      } else if (py % 50 === 49) {
        if (ny % 50 === 0 && px !== nx) {
          continue;
        } else if (py === ny) {
          continue;
        }
      }

      const nCost = this.look(nx, ny);
      if (nCost === obstacle) {
        continue;
      }
      this.pushNode(index, nx, ny, (gCost + nCost) >>> 0);
    }
  }

  // --- JPS

  private jumpX(cost: number, startX: number, py: number, dx: number): JumpResult {
    let px = startX;
    const up = (py - 1) >>> 0;
    const down = (py + 1) >>> 0;
    let prevCostU = this.look(px, up);
    let prevCostD = this.look(px, down);
    for (;;) {
      if (this.heuristic(px, py) === 0 || isNearBorderPos(px)) {
        break;
      }
      const next = (px + dx) >>> 0;
      const costU = this.look(next, up);
      const costD = this.look(next, down);
      if (
        (costU !== obstacle && prevCostU !== cost) ||
        (costD !== obstacle && prevCostD !== cost)
      ) {
        break;
      }
      prevCostU = costU;
      prevCostD = costD;
      px = next;

      const jumpCost = this.look(px, py);
      if (jumpCost === obstacle) {
        return null;
      } else if (jumpCost !== cost) {
        break;
      }
    }
    return { xx: px, yy: py };
  }

  private jumpY(cost: number, px: number, startY: number, dy: number): JumpResult {
    let py = startY;
    const left = (px - 1) >>> 0;
    const right = (px + 1) >>> 0;
    let prevCostL = this.look(left, py);
    let prevCostR = this.look(right, py);
    for (;;) {
      if (this.heuristic(px, py) === 0 || isNearBorderPos(py)) {
        break;
      }
      const next = (py + dy) >>> 0;
      const costL = this.look(left, next);
      const costR = this.look(right, next);
      if (
        (costL !== obstacle && prevCostL !== cost) ||
        (costR !== obstacle && prevCostR !== cost)
      ) {
        break;
      }
      prevCostL = costL;
      prevCostR = costR;
      py = next;

      const jumpCost = this.look(px, py);
      if (jumpCost === obstacle) {
        return null;
      } else if (jumpCost !== cost) {
        break;
      }
    }
    return { xx: px, yy: py };
  }

  private jumpXY(cost: number, startX: number, startY: number, dx: number, dy: number): JumpResult {
    let px = startX;
    let py = startY;
    let prevCostX = this.look((px - dx) >>> 0, py);
    let prevCostY = this.look(px, (py - dy) >>> 0);
    for (;;) {
      if (this.heuristic(px, py) === 0 || isNearBorderPos(px) || isNearBorderPos(py)) {
        break;
      }

      if (
        (this.look((px - dx) >>> 0, (py + dy) >>> 0) !== obstacle && prevCostX !== cost) ||
        (this.look((px + dx) >>> 0, (py - dy) >>> 0) !== obstacle && prevCostY !== cost)
      ) {
        break;
      }
      prevCostX = this.look(px, (py + dy) >>> 0);
      prevCostY = this.look((px + dx) >>> 0, py);
      if (
        (prevCostY !== obstacle && !isNullPos(this.jumpX(cost, (px + dx) >>> 0, py, dx))) ||
        (prevCostX !== obstacle && !isNullPos(this.jumpY(cost, px, (py + dy) >>> 0, dy)))
      ) {
        break;
      }

      px = (px + dx) >>> 0;
      py = (py + dy) >>> 0;

      const jumpCost = this.look(px, py);
      if (jumpCost === obstacle) {
        return null;
      } else if (jumpCost !== cost) {
        break;
      }
    }
    return { xx: px, yy: py };
  }

  private jump(cost: number, px: number, py: number, dx: number, dy: number): JumpResult {
    if (dx !== 0) {
      if (dy !== 0) {
        return this.jumpXY(cost, px, py, dx, dy);
      }
      return this.jumpX(cost, px, py, dx);
    }
    return this.jumpY(cost, px, py, dy);
  }

  private jps(index: number, px: number, py: number, gCost: number): void {
    const parent = this.posFromIndex(this.parents[index] ?? 0);
    const dx = px > parent.xx ? 1 : px < parent.xx ? -1 : 0;
    const dy = py > parent.yy ? 1 : py < parent.yy ? -1 : 0;

    // First check to see if we're jumping to/from a border, options are limited in this case
    const neighbors: [number, number][] = [];
    if (px % 50 === 0) {
      if (dx === -1) {
        neighbors.push([px - 1, py]);
      } else if (dx === 1) {
        neighbors.push([px + 1, py - 1], [px + 1, py], [px + 1, py + 1]);
      }
    } else if (px % 50 === 49) {
      if (dx === 1) {
        neighbors.push([px + 1, py]);
      } else if (dx === -1) {
        neighbors.push([px - 1, py - 1], [px - 1, py], [px - 1, py + 1]);
      }
    } else if (py % 50 === 0) {
      if (dy === -1) {
        neighbors.push([px, py - 1]);
      } else if (dy === 1) {
        neighbors.push([px - 1, py + 1], [px, py + 1], [px + 1, py + 1]);
      }
    } else if (py % 50 === 49) {
      if (dy === 1) {
        neighbors.push([px, py + 1]);
      } else if (dy === -1) {
        neighbors.push([px - 1, py - 1], [px, py - 1], [px + 1, py - 1]);
      }
    }

    // Add special nodes from the above blocks to the heap
    if (neighbors.length !== 0) {
      for (const [rawX, rawY] of neighbors) {
        const nx = rawX >>> 0;
        const ny = rawY >>> 0;
        const nCost = this.look(nx, ny);
        if (nCost === obstacle) {
          continue;
        }
        this.pushNode(index, nx, ny, (gCost + nCost) >>> 0);
      }
      return;
    }

    // Regular JPS iteration follows

    // First check to see if we're close to borders
    let borderDx = 0;
    if (px % 50 === 1) {
      borderDx = -1;
    } else if (px % 50 === 48) {
      borderDx = 1;
    }
    let borderDy = 0;
    if (py % 50 === 1) {
      borderDy = -1;
    } else if (py % 50 === 48) {
      borderDy = 1;
    }

    // Now execute the logic that is shared between diagonal and straight jumps
    const cost = this.look(px, py);
    if (dx !== 0) {
      const nx = (px + dx) >>> 0;
      const nCost = this.look(nx, py);
      if (nCost !== obstacle) {
        if (borderDy === 0) {
          this.jumpNeighbor(px, py, index, nx, py, gCost, cost, nCost);
        } else {
          this.pushNode(index, nx, py, (gCost + nCost) >>> 0);
        }
      }
    }
    if (dy !== 0) {
      const ny = (py + dy) >>> 0;
      const nCost = this.look(px, ny);
      if (nCost !== obstacle) {
        if (borderDx === 0) {
          this.jumpNeighbor(px, py, index, px, ny, gCost, cost, nCost);
        } else {
          this.pushNode(index, px, ny, (gCost + nCost) >>> 0);
        }
      }
    }

    // Forced neighbor rules
    if (dx !== 0) {
      if (dy !== 0) {
        // Jumping diagonally
        const nx = (px + dx) >>> 0;
        const ny = (py + dy) >>> 0;
        const nCost = this.look(nx, ny);
        if (nCost !== obstacle) {
          this.jumpNeighbor(px, py, index, nx, ny, gCost, cost, nCost);
        }
        if (this.look((px - dx) >>> 0, py) !== cost) {
          const fx = (px - dx) >>> 0;
          this.jumpNeighbor(px, py, index, fx, ny, gCost, cost, this.look(fx, ny));
        }
        if (this.look(px, (py - dy) >>> 0) !== cost) {
          const fy = (py - dy) >>> 0;
          this.jumpNeighbor(px, py, index, nx, fy, gCost, cost, this.look(nx, fy));
        }
      } else {
        // Jumping left / right
        const nx = (px + dx) >>> 0;
        const down = (py + 1) >>> 0;
        const up = (py - 1) >>> 0;
        if (borderDy === 1 || this.look(px, down) !== cost) {
          this.jumpNeighbor(px, py, index, nx, down, gCost, cost, this.look(nx, down));
        }
        if (borderDy === -1 || this.look(px, up) !== cost) {
          this.jumpNeighbor(px, py, index, nx, up, gCost, cost, this.look(nx, up));
        }
      }
    } else {
      // Jumping up / down
      const ny = (py + dy) >>> 0;
      const right = (px + 1) >>> 0;
      const left = (px - 1) >>> 0;
      if (borderDx === 1 || this.look(right, py) !== cost) {
        this.jumpNeighbor(px, py, index, right, ny, gCost, cost, this.look(right, ny));
      }
      if (borderDx === -1 || this.look(left, py) !== cost) {
        this.jumpNeighbor(px, py, index, left, ny, gCost, cost, this.look(left, ny));
      }
    }
  }

  private jumpNeighbor(
    px: number,
    py: number,
    index: number,
    neighborX: number,
    neighborY: number,
    startGCost: number,
    cost: number,
    nCost: number,
  ): void {
    let gCost = startGCost;
    let nx = neighborX;
    let ny = neighborY;
    if (nCost !== cost || isBorderPos(nx) || isBorderPos(ny)) {
      if (nCost === obstacle) {
        return;
      }
      gCost = (gCost + nCost) >>> 0;
    } else {
      // Deltas are computed on uint32 values and narrowed to int, as in the native code.
      const jumped = this.jump(nCost, nx, ny, (nx - px) | 0, (ny - py) | 0);
      if (isNullPos(jumped)) {
        return;
      }
      nx = jumped.xx;
      ny = jumped.yy;
      const range = rangeTo(px, py, nx, ny);
      gCost = (gCost + Math.imul(nCost, (range - 1) >>> 0) + this.look(nx, ny)) >>> 0;
    }

    this.pushNode(index, nx, ny, gCost);
  }

  // --- entry point

  /** Returns `undefined` for "already at goal", `-1` when the origin room is inaccessible. */
  search(
    origin: WorldPosition,
    goals: Goal[],
    roomCallback: RoomCallback | undefined,
    plainCost: number,
    swampCost: number,
    maxRooms: number,
    maxOps: number,
    maxCost: number,
    flee: boolean,
    heuristicWeight: number,
  ): { path: [number, number][]; ops: number; cost: number; incomplete: boolean } | -1 | undefined {
    // Clean up from previous iteration
    for (let ii = 0; ii < this.roomTableSize; ++ii) {
      const room = this.roomTable[ii];
      if (room) {
        this.reverseRoomTable[room.mapId] = 0;
      }
    }
    this.roomTableSize = 0;
    this.blockedRooms.clear();
    this.clearOpenClosed();
    this.heapSize = 0;

    this.goals = goals;
    this.roomCallback = roomCallback;

    // Other initialization
    this.lookTable[0] = plainCost;
    this.lookTable[2] = swampCost;
    this.maxRooms = maxRooms;
    this.heuristicWeight = heuristicWeight;
    let opsRemaining = maxOps;
    this.flee = flee;
    let minNodeHCost = uint32Max;
    let minNodeGCost = uint32Max;

    // Special case for searching to same node, otherwise it searches everywhere because origin node
    // is closed
    if (this.heuristic(origin.xx, origin.yy) === 0) {
      return undefined;
    }

    this.inUse = true;
    try {
      // Prime data for `index_from_pos`
      if (this.roomIndexFromPos(mapId(origin.xx, origin.yy)) === 0) {
        // Initial room is inaccessible
        return -1;
      }

      // Initial A* iteration
      let minNode = this.indexFromPos(origin.xx, origin.yy);
      this.astar(minNode, origin.xx, origin.yy, 0);

      // Loop until we have a solution
      while (this.heapSize !== 0 && opsRemaining > 0) {
        // Pull cheapest open node off the heap and close the node
        const [currentIndex, currentPriority] = this.heapPop();
        this.openClosed[currentIndex] = this.marker + 1;

        // Calculate costs
        const pos = this.posFromIndex(currentIndex);
        const hCost = this.heuristic(pos.xx, pos.yy);
        const gCost = (currentPriority - weighted(hCost, this.heuristicWeight)) >>> 0;

        // Reached destination?
        if (hCost === 0) {
          minNode = currentIndex;
          minNodeHCost = 0;
          minNodeGCost = gCost;
          break;
        } else if (hCost < minNodeHCost) {
          minNode = currentIndex;
          minNodeHCost = hCost;
          minNodeGCost = gCost;
        }
        if ((gCost + hCost) >>> 0 > maxCost) {
          break;
        }

        // Add next neighbors to heap
        this.jps(currentIndex, pos.xx, pos.yy, gCost);
        --opsRemaining;
      }

      // Reconstruct path from A* graph
      const path: [number, number][] = [];
      let index = minNode;
      let pos = this.posFromIndex(index);
      while (pos.xx !== origin.xx || pos.yy !== origin.yy) {
        path.push([pos.xx, pos.yy]);
        index = this.parents[index] ?? 0;
        const next = this.posFromIndex(index);
        if (rangeTo(next.xx, next.yy, pos.xx, pos.yy) > 1) {
          const [ox, oy] = directionOffsets[directionTo(pos, next)] ?? [0, 0];
          do {
            pos = { xx: (pos.xx + ox) >>> 0, yy: (pos.yy + oy) >>> 0 };
            path.push([pos.xx, pos.yy]);
          } while (rangeTo(pos.xx, pos.yy, next.xx, next.yy) > 1);
        }
        pos = next;
      }
      return {
        path,
        ops: maxOps - opsRemaining,
        cost: minNodeGCost,
        incomplete: minNodeHCost !== 0,
      };
    } finally {
      this.inUse = false;
      this.roomCallback = undefined;
    }
  }
}

/** Offsets for native `direction_t` (TOP=0 … TOP_LEFT=7). */
const directionOffsets: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** Native `direction_to`: linear direction index from `from` towards `to` (-1 when equal). */
function directionTo(from: WorldPosition, to: WorldPosition): number {
  const dx = (to.xx - from.xx) | 0;
  const dy = (to.yy - from.yy) | 0;
  if (dx > 0) {
    return dy > 0 ? 3 : dy < 0 ? 1 : 2;
  }
  if (dx < 0) {
    return dy > 0 ? 5 : dy < 0 ? 7 : 6;
  }
  if (dy > 0) {
    return 4;
  }
  if (dy < 0) {
    return 0;
  }
  return -1;
}

function isBorderPos(val: number): boolean {
  return ((val + 1) >>> 0) % 50 < 2;
}

function isNearBorderPos(val: number): boolean {
  return ((val + 2) >>> 0) % 50 < 4;
}

function isNullPos(pos: JumpResult): pos is null {
  return pos === null || (pos.xx === 0 && pos.yy === 0);
}

// ---------------------------------------------------------------------------
// Public PathFinder (driver lib/path-finder.js glue)

/**
 * Multi-room path finder bound to one world's terrain. Independent instances share no state.
 * Nested searches (from inside `roomCallback`) are supported, as with the native module.
 */
export class PathFinder {
  private readonly terrain = new Map<number, Uint8Array>();
  private readonly engines: SearchEngine[] = [];

  constructor(rooms?: Iterable<PathFinderTerrainRoom>) {
    if (rooms) {
      this.loadTerrain(rooms);
    }
  }

  /** Adds or replaces terrain for the given rooms (other loaded rooms are kept). */
  loadTerrain(rooms: Iterable<PathFinderTerrainRoom>): void {
    for (const room of rooms) {
      const pos = parseRoomName(room.room);
      const data = new Uint8Array(2500);
      for (let xx = 0; xx < 50; ++xx) {
        for (let yy = 0; yy < 50; ++yy) {
          data[xx * 50 + yy] = Number(room.terrain[yy * 50 + xx]) & 0x03;
        }
      }
      this.terrain.set(pos.xx | (pos.yy << 8), data);
    }
  }

  /** Finds a path from `origin` to any of `goal` (positions or `{pos, range}`), or away from them with `flee`. */
  search(
    origin: RoomPosLike,
    goal: RoomPosLike | PathFinderGoal | readonly (RoomPosLike | PathFinderGoal)[],
    options?: PathFinderOpts,
  ): PathFinderResult<PathFinderPosition>;
  search<P>(
    origin: RoomPosLike,
    goal: RoomPosLike | PathFinderGoal | readonly (RoomPosLike | PathFinderGoal)[],
    options: PathFinderOpts | undefined,
    makePosition: MakePosition<P>,
  ): PathFinderResult<P>;
  /** Untyped entry point for values coming straight from player code. */
  search(origin: unknown, goal: unknown, options?: unknown): PathFinderResult<PathFinderPosition>;
  search<P>(
    origin: unknown,
    goal: unknown,
    options: unknown,
    makePosition: MakePosition<P>,
  ): PathFinderResult<P>;
  search<P>(
    origin: unknown,
    goal: unknown,
    options?: unknown,
    makePosition?: MakePosition<P>,
  ): PathFinderResult<P | PathFinderPosition> {
    const makePos: MakePosition<P | PathFinderPosition> =
      makePosition ?? ((x, y, roomName) => ({ x, y, roomName }));

    // Options
    const opts: unknown = options || {};
    const plainCost = Math.min(254, Math.max(1, int32(prop(opts, 'plainCost')) || 1));
    const swampCost = Math.min(254, Math.max(1, int32(prop(opts, 'swampCost')) || 5));
    const heuristicWeightRaw = prop(opts, 'heuristicWeight') || 1.2;
    const heuristicWeight = Math.min(9, Math.max(1, heuristicWeightRaw as number));
    const maxOps = Math.max(1, int32(prop(opts, 'maxOps')) || 2000);
    const maxCost = Math.max(1, int32(prop(opts, 'maxCost')) || 0xffffffff);
    const maxRooms = Math.min(64, Math.max(1, int32(prop(opts, 'maxRooms')) || 16));
    const flee = !!prop(opts, 'flee');

    // Convert one-or-many goal into standard format for native extension
    const goalList: unknown[] = Array.isArray(goal) ? (goal as unknown[]) : [goal];
    const goals: Goal[] = goalList.map((item) => {
      if (
        prop(item, 'x') !== undefined &&
        prop(item, 'y') !== undefined &&
        prop(item, 'roomName') !== undefined
      ) {
        return { range: 0, ...toWorldPosition(item) };
      }
      const range = Math.max(0, int32(prop(item, 'range')));
      return { range, ...toWorldPosition(prop(item, 'pos')) };
    });

    // Setup room callback
    const cb = prop(opts, 'roomCallback');
    let roomCallback: RoomCallback | undefined;
    if (typeof cb === 'function') {
      roomCallback = (xx, yy) => {
        const ret: unknown = Reflect.apply(cb, undefined, [generateRoomName(xx, yy)]);
        if (ret === false) {
          return ret;
        } else if (ret) {
          return prop(ret, '_bits');
        }
        return undefined;
      };
    }

    // Invoke native code
    const originWorld = toWorldPosition(origin);
    const engine = this.acquireEngine();
    const ret = engine.search(
      originWorld,
      goals,
      roomCallback,
      plainCost,
      swampCost,
      maxRooms,
      maxOps >>> 0,
      maxCost >>> 0,
      flee,
      heuristicWeight,
    );
    if (ret === undefined) {
      return { path: [], ops: 0, cost: 0, incomplete: false };
    } else if (ret === -1) {
      return { path: [], ops: 0, cost: 0, incomplete: true };
    }
    return {
      path: ret.path
        .map(([wx, wy]) =>
          makePos(wx % 50, wy % 50, generateRoomName(Math.floor(wx / 50), Math.floor(wy / 50))),
        )
        .reverse(),
      ops: ret.ops,
      cost: ret.cost,
      incomplete: ret.incomplete,
    };
  }

  private acquireEngine(): SearchEngine {
    // Two engines are kept warm (as the native thread-local pair); deeper recursion allocates temporaries.
    for (const engine of this.engines) {
      if (!engine.inUse) {
        return engine;
      }
    }
    const engine = new SearchEngine(this.terrain);
    if (this.engines.length < 2) {
      this.engines.push(engine);
    }
    return engine;
  }
}
