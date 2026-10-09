/*
 * Typed equivalents of lodash 3.10.1 helpers and sloppy-mode JS semantics used by the upstream game
 * API that are not provided by `src/utils` (`utils/lodash.ts` holds isObject/isString/isNumber/
 * isNaNValue/size/sum/collectionValues; `utils/js.ts` holds toPrimitive/jsString/jsConcat/jsAdd and the
 * other operator semantics). The player-facing `_` global remains real lodash 3.10.1.
 *
 * Portions derived from lodash 3.10.1 (MIT, Copyright 2012-2015 The Dojo Foundation) and
 * screeps/engine (ISC, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>).
 */

import { jsString } from '../../utils/js.ts';
import { isObject } from '../../utils/lodash.ts';

function objectTag(value: object): string {
  return Object.prototype.toString.call(value);
}

function isObjectLike(value: unknown): value is object {
  return !!value && typeof value === 'object';
}

/** `_.isUndefined` */
export function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

/** `_.isBoolean` */
export function isBoolean(value: unknown): value is boolean {
  return (
    value === true ||
    value === false ||
    (isObjectLike(value) && objectTag(value) === '[object Boolean]')
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

/** `_.isPlainObject`: objects created by `Object`, object literals or with a `null` prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObjectLike(value) || objectTag(value) !== '[object Object]') {
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
    Object.prototype.hasOwnProperty.call(value, 'constructor') || !('constructor' in proto)
      ? undefined
      : proto.constructor;
  return (
    typeof ctor === 'function' &&
    (ctor === Object ||
      Function.prototype.toString.call(ctor) === Function.prototype.toString.call(Object))
  );
}

/** `_.contains` for arrays (SameValueZero), strings (substring) and object values. */
export function contains(collection: unknown, target: unknown): boolean {
  if (typeof collection === 'string') {
    return collection.includes(jsString(target));
  }
  if (Array.isArray(collection)) {
    return collection.includes(target);
  }
  if (isObject(collection)) {
    return Object.values(collection).includes(target);
  }
  return false;
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
    return Object.assign(
      Object.create(Object.getPrototypeOf(value) as object | null) as T & object,
      value,
    );
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
    const result = Object.create(Object.getPrototypeOf(value) as object | null) as Record<
      string,
      unknown
    >;
    for (const [key, item] of Object.entries(value)) {
      result[key] = cloneDeep(item);
    }
    return result as T;
  }
  return value;
}

/**
 * Sloppy-mode `object[key] = value` (upstream game files are not strict): throws on a
 * `null`/`undefined` base like V8, otherwise never throws (primitives and frozen targets are
 * ignored; setters run with the original receiver).
 */
export function jsSetSloppy(object: unknown, key: PropertyKey, value: unknown): void {
  if (object === null || object === undefined) {
    throw new TypeError(`Cannot set properties of ${String(object)} (setting '${jsString(key)}')`);
  }
  const target = Object(object) as object;
  Reflect.set(target, key, value, object);
}

/** Sloppy-mode `this` coercion: `null`/`undefined` become the global object, primitives are boxed. */
export function sloppyThis(value: unknown): object {
  return value === null || value === undefined ? globalThis : (Object(value) as object);
}
