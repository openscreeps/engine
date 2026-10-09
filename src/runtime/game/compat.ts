/*
 * Typed equivalents of the lodash 3.10.1 helpers used by the upstream game API, with identical
 * semantics for the values the API handles. The player-facing `_` global remains real lodash 3.10.1.
 *
 * Portions derived from lodash 3.10.1 (MIT, Copyright 2012-2015 The Dojo Foundation) and
 * screeps/engine (ISC, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>).
 */

const objectToString = Object.prototype.toString;

/** `_.isUndefined` */
export function isUndefined(value: unknown): value is undefined {
    return value === undefined;
}

/** `_.isObject`: objects, arrays, functions, boxed primitives and regexes. */
export function isObject(value: unknown): value is object {
    const type = typeof value;
    return !!value && (type === 'object' || type === 'function');
}

/** `_.isString` */
export function isString(value: unknown): value is string {
    return typeof value === 'string' || (isObjectLike(value) && objectToString.call(value) === '[object String]');
}

/** `_.isNumber` (true for `NaN`, `Infinity` and boxed numbers). */
export function isNumber(value: unknown): value is number {
    return typeof value === 'number' || (isObjectLike(value) && objectToString.call(value) === '[object Number]');
}

/** `_.isBoolean` */
export function isBoolean(value: unknown): value is boolean {
    return (
        value === true ||
        value === false ||
        (isObjectLike(value) && objectToString.call(value) === '[object Boolean]')
    );
}

/** `_.isFunction` */
export function isFunction(value: unknown): value is (...args: never[]) => unknown {
    return typeof value === 'function';
}

/** `_.isArray` */
export function isArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

/** `_.isNaN`: `NaN` primitives and boxed `NaN` numbers. */
export function isNaN(value: unknown): boolean {
    return isNumber(value) && Number(value) !== Number(value);
}

/** `_.isFinite` (lodash 3 uses the global `isFinite` on numbers only). */
export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isObjectLike(value: unknown): value is object {
    return !!value && typeof value === 'object';
}

/** `_.isPlainObject`: objects created by `Object`, object literals or with a `null` prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!isObjectLike(value) || objectToString.call(value) !== '[object Object]') {
        return false;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === null || typeof proto !== 'object') {
        return proto === null;
    }
    if (Object.getPrototypeOf(proto) === null) {
        return true;
    }
    const ctor: unknown =
        Object.prototype.hasOwnProperty.call(value, 'constructor') || !('constructor' in proto) ? undefined : proto.constructor;
    return (
        typeof ctor === 'function' &&
        (ctor === Object || Function.prototype.toString.call(ctor) === Function.prototype.toString.call(Object))
    );
}

/** `_.contains` for arrays (SameValueZero), strings (substring) and object values. */
export function contains(collection: unknown, target: unknown): boolean {
    if (typeof collection === 'string') {
        return typeof target === 'string' ? collection.includes(target) : collection.includes(String(target));
    }
    if (Array.isArray(collection)) {
        return collection.includes(target);
    }
    if (isObject(collection)) {
        return Object.values(collection).includes(target);
    }
    return false;
}

/** `_.sum` over array elements or object values; non-numbers are added with `+` like lodash 3. */
export function sum(collection: Iterable<number> | Record<string, number | undefined> | null | undefined): number {
    if (collection === null || collection === undefined) {
        return 0;
    }
    let result = 0;
    const values: Iterable<number | undefined> =
        Symbol.iterator in collection ? (collection as Iterable<number>) : Object.values(collection);
    for (const value of values) {
        result += +(value ?? 0);
    }
    return result;
}

/** `_.size` */
export function size(collection: unknown): number {
    if (collection === null || collection === undefined) {
        return 0;
    }
    if (typeof collection === 'string' || Array.isArray(collection)) {
        return collection.length;
    }
    if (typeof collection === 'object') {
        return Object.keys(collection).length;
    }
    return 0;
}

/** `_.uniq` (SameValueZero, keeps first occurrence order). */
export function uniq<T>(array: readonly T[]): T[] {
    return [...new Set(array)];
}

/** `_.clone` for the plain data shapes handled by the API (arrays, plain objects, dates). */
export function clone<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.slice() as T;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as T;
    }
    if (isObjectLike(value)) {
        return Object.assign(Object.create(Object.getPrototypeOf(value) as object | null) as object, value) as T;
    }
    return value;
}

/** `_.cloneDeep` for plain data shapes (arrays, plain objects, dates, primitives). */
export function cloneDeep<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((item: unknown) => cloneDeep(item)) as T;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as T;
    }
    if (isObjectLike(value)) {
        const result = Object.create(Object.getPrototypeOf(value) as object | null) as Record<string, unknown>;
        for (const [key, item] of Object.entries(value)) {
            result[key] = cloneDeep(item);
        }
        return result as T;
    }
    return value;
}
