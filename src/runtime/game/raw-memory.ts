/*
 * `RawMemory` and memory segment bookkeeping (screeps/driver `lib/runtime/runtime.js` `_start`).
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { jsString } from '../../utils/js.ts';
import { isNaNValue, isString } from '../../utils/lodash.ts';
import { isArray } from './compat.ts';
import type { ForeignMemorySegment } from './runtime-data.ts';

export interface ActiveForeignSegment {
  username: unknown;
  id: number | undefined;
}

export interface RawMemory {
  get(): string;
  set(value: unknown): void;
  readonly segments: Record<string, unknown>;
  interShardSegment: unknown;
  setActiveSegments(ids: unknown): void;
  setPublicSegments(ids: unknown): void;
  setDefaultPublicSegment(id: unknown): void;
  setActiveForeignSegment(username: unknown, id?: unknown): void;
  foreignSegment?: ForeignMemorySegment;
  /** Parsed `Memory` root once player code touched `Memory`. */
  _parsed?: unknown;
}

/** Segment requests made by player code during the tick (`undefined` when not requested). */
export interface SegmentRequests {
  activeSegments: number[] | undefined;
  publicSegments: number[] | undefined;
  defaultPublicSegment: number | null | undefined;
  activeForeignSegment: ActiveForeignSegment | null | undefined;
}

function parseSegmentId(value: unknown): number {
  return parseInt(String(value));
}

function invalidSegmentId(id: number): boolean {
  return isNaNValue(id) || id > 99 || id < 0;
}

export function createRawMemory(
  userMemory: { data: string },
  memorySegments: Record<number, string> | undefined,
  foreignMemorySegment: ForeignMemorySegment | undefined,
  requests: SegmentRequests,
): RawMemory {
  const rawMemory = Object.create(null, {
    get: {
      value: function (): string {
        return userMemory.data;
      },
    },
    set: {
      value: function (this: RawMemory, value: unknown): void {
        if (!isString(value)) {
          throw new Error('Raw memory value is not a string');
        }
        // `isString` also accepts boxed strings; unwrap like upstream string use.
        const text = jsString(value);
        if (text.length > 2 * 1024 * 1024) {
          throw new Error('Raw memory length exceeded 2 MB limit');
        }
        if (this._parsed) {
          delete this._parsed;
        }
        userMemory.data = text;
      },
    },
    segments: {
      value: Object.create(null) as Record<string, unknown>,
    },
    interShardSegment: {
      value: '',
      writable: true,
    },
    setActiveSegments: {
      value: function (ids: unknown): void {
        if (!isArray(ids)) {
          throw new Error(`"${String(ids)}" is not an array`);
        }
        if (ids.length > 10) {
          throw new Error('Only 10 memory segments can be active at the same time');
        }
        const active: number[] = [];
        requests.activeSegments = active;
        for (const item of ids) {
          const id = parseSegmentId(item);
          if (invalidSegmentId(id)) {
            throw new Error(`"${String(item)}" is not a valid segment ID`);
          }
          active.push(id);
        }
      },
    },
    setPublicSegments: {
      value: function (ids: unknown): void {
        if (!isArray(ids)) {
          throw new Error(`"${String(ids)}" is not an array`);
        }
        const published: number[] = [];
        requests.publicSegments = published;
        for (const item of ids) {
          const id = parseSegmentId(item);
          if (invalidSegmentId(id)) {
            throw new Error(`"${String(item)}" is not a valid segment ID`);
          }
          published.push(id);
        }
      },
    },
    setDefaultPublicSegment: {
      value: function (id: unknown): void {
        let segment: number | null = null;
        if (id !== null) {
          segment = parseSegmentId(id);
          if (invalidSegmentId(segment)) {
            throw new Error(`"${String(segment)}" is not a valid segment ID`);
          }
        }
        requests.defaultPublicSegment = segment;
      },
    },
    setActiveForeignSegment: {
      value: function (username: unknown, id?: unknown): void {
        if (username === null) {
          requests.activeForeignSegment = null;
          return;
        }
        let segment: number | undefined;
        if (id !== undefined) {
          segment = parseSegmentId(id);
          if (invalidSegmentId(segment)) {
            throw new Error(`"${String(segment)}" is not a valid segment ID`);
          }
        }
        requests.activeForeignSegment = { username, id: segment };
      },
    },
  }) as RawMemory;

  if (memorySegments) {
    for (const [key, value] of Object.entries(memorySegments)) {
      rawMemory.segments[key] = value;
    }
  }
  if (foreignMemorySegment) {
    const foreign = Object.create(null) as ForeignMemorySegment;
    Object.assign(foreign, foreignMemorySegment);
    rawMemory.foreignSegment = foreign;
  }
  return rawMemory;
}
