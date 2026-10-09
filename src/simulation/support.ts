/*
 * Small data helpers reproducing the exact lodash 3.10.1 semantics the upstream engine relies on.
 *
 * Portions derived from lodash 3.10.1, Copyright 2012-2015 The Dojo Foundation, Jeremy Ashkenas,
 * DocumentCloud and Investigative Reporters & Editors, used under the MIT license
 * (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';

export type PlainRecord = Record<string, unknown>;

export function isObjectLike(value: unknown): value is object {
    return typeof value === 'object' && value !== null;
}

/** lodash `_.isObject`: objects, arrays and functions. */
export function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function isPlainObject(value: unknown): value is PlainRecord {
    if (!isObjectLike(value) || Array.isArray(value)) {
        return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === null || proto === Object.prototype;
}

function asRecord(value: object): PlainRecord {
    return value as PlainRecord;
}

/**
 * lodash 3 `_.merge(object, source)` for plain data: nested plain objects and arrays are merged
 * in place, `undefined` source values are skipped (except for missing array slots).
 */
export function merge<T extends object>(object: T, source: object): T {
    baseMerge(object, source, [], []);
    return object;
}

function baseMerge(object: object, source: object, stackA: unknown[], stackB: unknown[]): void {
    const target = asRecord(object);
    const src = asRecord(source);
    const isSrcArr = Array.isArray(source);
    const keys = isSrcArr ? Array.from({ length: source.length }, (_v, i) => String(i)) : Object.keys(source);
    for (const key of keys) {
        const srcValue = src[key];
        if (isObjectLike(srcValue)) {
            baseMergeDeep(target, key, srcValue, stackA, stackB);
            continue;
        }
        const value = target[key];
        if (
            (srcValue !== undefined || (isSrcArr && !(key in target))) &&
            (srcValue === srcValue ? srcValue !== value : value === value)
        ) {
            target[key] = srcValue;
        }
    }
}

function baseMergeDeep(target: PlainRecord, key: string, srcValue: object, stackA: unknown[], stackB: unknown[]): void {
    for (let i = stackA.length - 1; i >= 0; i--) {
        if (stackA[i] === srcValue) {
            target[key] = stackB[i];
            return;
        }
    }
    const value = target[key];
    let result: object;
    if (Array.isArray(srcValue)) {
        result = Array.isArray(value) ? value : [];
    } else if (isPlainObject(srcValue)) {
        result = isPlainObject(value) ? value : {};
    } else {
        stackA.push(srcValue);
        stackB.push(srcValue);
        if (srcValue !== value) {
            target[key] = srcValue;
        }
        return;
    }
    stackA.push(srcValue);
    stackB.push(result);
    baseMerge(result, srcValue, stackA, stackB);
    target[key] = result;
}

/** Deep clone of plain JSON-like data (lodash `_.cloneDeep` for the data the engine handles). */
export function cloneDeep<T>(value: T): T {
    return cloneValue(value) as T;
}

function cloneValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (isObjectLike(value)) {
        const result: PlainRecord = {};
        for (const key of Object.keys(value)) {
            result[key] = cloneValue(asRecord(value)[key]);
        }
        return result;
    }
    return value;
}

/** Serialization round-trip matching what crosses the upstream storage RPC boundary. */
export function jsonClone<T>(value: T): T {
    if (value === undefined) {
        return value;
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

/** lodash `_.isEqual` restricted to JSON-like data. */
export function isEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a === 'number' && typeof b === 'number') {
        return Number.isNaN(a) && Number.isNaN(b);
    }
    if (!isObjectLike(a) || !isObjectLike(b)) {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (!isEqual(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) {
        return false;
    }
    const rb = asRecord(b);
    const ra = asRecord(a);
    for (const key of ka) {
        if (!Object.prototype.hasOwnProperty.call(b, key) || !isEqual(ra[key], rb[key])) {
            return false;
        }
    }
    return true;
}

/** Typed lookup in a constant table indexed by an arbitrary runtime key. */
export function lookup<V>(table: Readonly<Record<string, V>>, key: string | number | null | undefined): V | undefined {
    if (key === null || key === undefined) {
        return undefined;
    }
    const k = String(key);
    return Object.prototype.hasOwnProperty.call(table, k) ? table[k] : undefined;
}

/** Shape of one `C.POWER_INFO` entry; every field is optional because powers differ. */
export interface PowerInfoEntry {
    readonly className?: string;
    readonly level?: readonly number[];
    readonly cooldown?: number;
    readonly effect?: readonly number[];
    readonly duration?: number | readonly number[];
    readonly range?: number;
    readonly ops?: number | readonly number[];
    readonly period?: number;
    readonly energy?: number;
}

/** `C.POWER_INFO[power]` for a runtime power key. */
export function powerInfo(power: string | number | null | undefined): PowerInfoEntry | undefined {
    return lookup<PowerInfoEntry>(C.POWER_INFO, power);
}

/** `C.POWER_INFO[power].effect[level - 1]` with upstream JS semantics (throws on unknown powers). */
export function powerEffect(power: string | number, level: number | undefined): number {
    const info = powerInfo(power) as PowerInfoEntry;
    return (info.effect as readonly number[])[(level as number) - 1] as number;
}

/** Membership test of an arbitrary value in a constant list (lodash `_.contains`). */
export function contains(list: readonly unknown[], value: unknown): boolean {
    return list.includes(value);
}

/** lodash `_.sum` over values of a record or array, treating missing values as 0 like `+value`. */
export function sumValues(values: Readonly<Record<string, number | null | undefined>> | null | undefined): number {
    let total = 0;
    if (!values) {
        return 0;
    }
    for (const key of Object.keys(values)) {
        total += values[key] ?? 0;
    }
    return total;
}

/** JS `+value || 0` style numeric coercion for optional numeric document fields. */
export function num(value: number | null | undefined): number {
    return value ?? 0;
}

/** lodash `_.shuffle` with an injected random source. */
export function shuffle<T>(list: readonly T[], random: () => number): T[] {
    const result = list.slice();
    for (let index = 0; index < result.length; index++) {
        const rand = index + Math.floor(random() * (result.length - index));
        const tmp = result[rand] as T;
        result[rand] = result[index] as T;
        result[index] = tmp;
    }
    return result;
}

/** lodash `_.sample` with an injected random source. */
export function sample<T>(list: readonly T[], random: () => number): T | undefined {
    if (list.length === 0) {
        return undefined;
    }
    return list[Math.floor(random() * list.length)];
}

/** lodash `_.random(min, max)` (integer form) with an injected random source. */
export function randomInt(min: number, max: number, random: () => number): number {
    return min + Math.floor(random() * (max - min + 1));
}

/** Seeded PRNG (mulberry32) whose state lives in the world state. */
export class SeededRandom {
    state: number;

    constructor(state: number) {
        this.state = state >>> 0;
    }

    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}
