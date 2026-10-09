/*
 * Ported from @screeps/engine src/game/path-utils.js (used by Game.map.findRoute).
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC License (see THIRD_PARTY_NOTICES.md).
 */

/** Simple open-closed list with O(1) clearing via generation markers. */
export class OpenClosed {
  private list: Uint8Array;
  private marker = 1;

  constructor(size: number) {
    this.list = new Uint8Array(size);
  }

  clear(): void {
    if (this.marker >= 253) {
      this.list = new Uint8Array(this.list.length);
      this.marker = 1;
    } else {
      this.marker += 2;
    }
  }

  isOpen(index: number): boolean {
    return this.list[index] === this.marker;
  }

  isClosed(index: number): boolean {
    return this.list[index] === this.marker + 1;
  }

  open(index: number): void {
    this.list[index] = this.marker;
  }

  close(index: number): void {
    this.list[index] = this.marker + 1;
  }
}

export type PriorityArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;
export type PriorityArrayConstructor = new (length: number) => PriorityArray;

/** Binary min-heap of indices with per-index priorities, supporting priority updates. */
export class Heap {
  private readonly priorities: PriorityArray;
  private readonly heap: Uint16Array;
  private size_ = 0;

  constructor(size: number, ArrayType: PriorityArrayConstructor = Uint16Array) {
    this.priorities = new ArrayType(size + 1);
    this.heap = new Uint16Array(size + 1);
  }

  minPriority(): number {
    return this.priority(this.min());
  }

  min(): number {
    return this.at(1);
  }

  size(): number {
    return this.size_;
  }

  priority(index: number): number {
    // Out-of-range reads were `undefined` upstream and only ever compared; NaN compares identically.
    return this.priorities[index] ?? NaN;
  }

  pop(): void {
    this.heap[1] = this.at(this.size_);
    --this.size_;
    let vv = 1;
    for (;;) {
      const uu = vv;
      if ((uu << 1) + 1 <= this.size_) {
        if (this.priority(this.at(uu)) >= this.priority(this.at(uu << 1))) {
          vv = uu << 1;
        }
        if (this.priority(this.at(vv)) >= this.priority(this.at((uu << 1) + 1))) {
          vv = (uu << 1) + 1;
        }
      } else if (uu << 1 <= this.size_) {
        if (this.priority(this.at(uu)) >= this.priority(this.at(uu << 1))) {
          vv = uu << 1;
        }
      }
      if (uu !== vv) {
        const tmp = this.at(uu);
        this.heap[uu] = this.at(vv);
        this.heap[vv] = tmp;
      } else {
        return;
      }
    }
  }

  push(index: number, priority: number): void {
    this.priorities[index] = priority;
    const ii = ++this.size_;
    this.heap[ii] = index;
    this.bubbleUp(ii);
  }

  update(index: number, priority: number): void {
    for (let ii = this.size_; ii > 0; --ii) {
      if (this.heap[ii] === index) {
        this.priorities[index] = priority;
        this.bubbleUp(ii);
        return;
      }
    }
  }

  bubbleUp(start: number): void {
    let ii = start;
    while (ii !== 1) {
      if (this.priority(this.at(ii)) <= this.priority(this.at(ii >>> 1))) {
        const tmp = this.at(ii);
        this.heap[ii] = this.at(ii >>> 1);
        ii = ii >>> 1;
        this.heap[ii] = tmp;
      } else {
        return;
      }
    }
  }

  clear(): void {
    this.size_ = 0;
  }

  private at(slot: number): number {
    // Typed-array reads past the end are `undefined` upstream; as an index they hit no priority (NaN).
    return this.heap[slot] ?? NaN;
  }
}
