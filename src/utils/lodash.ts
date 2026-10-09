/*
 * Minimal, typed re-implementations of the lodash 3.10.1 primitives the upstream engine relies on.
 * Semantics (iteration order, coercions, NaN handling) intentionally match lodash 3, because the
 * official engine's observable behaviour depends on them.
 *
 * lodash 3.10.1: Copyright 2012-2015 The Dojo Foundation <http://dojofoundation.org/>,
 * based on Underscore.js 1.8.3, Copyright 2009-2015 Jeremy Ashkenas, DocumentCloud and Investigative
 * Reporters & Editors. Available under MIT license <https://lodash.com/license>.
 */

import { getProp } from './tables.ts';

/** `Object.prototype.toString` tag of a value, as lodash's internal tag lookup. */
function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}
const MAX_SAFE_INTEGER = 9007199254740991;

/** `_.isObject`: objects, arrays and functions (not `null`). */
export function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** `_.isNumber`: number primitives and `Number` objects. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' || (isObjectLike(value) && tagOf(value) === '[object Number]');
}

/** `_.isString`: string primitives and `String` objects. */
export function isString(value: unknown): value is string {
  return typeof value === 'string' || (isObjectLike(value) && tagOf(value) === '[object String]');
}

/** `_.isNaN`: only true for numeric `NaN` values (unlike the global `isNaN`). */
export function isNaNValue(value: unknown): boolean {
  // `valueOf` unwraps Number objects, matching lodash's loose `value != +value`.
  return isNumber(value) && Number.isNaN(value.valueOf());
}

function isLength(value: unknown): value is number {
  return typeof value === 'number' && value > -1 && value % 1 === 0 && value <= MAX_SAFE_INTEGER;
}

/**
 * Values of a collection in lodash 3 `baseEach` order: truthy values with a valid `length` (arrays,
 * strings, functions, other array-likes) are read by index from `Object(collection)`, holes included;
 * other objects yield their own enumerable string-keyed values; remaining primitives yield nothing.
 */
export function collectionValues<T>(
  collection: Readonly<Record<string, T>> | readonly T[] | null | undefined,
): T[];
export function collectionValues(collection: unknown): unknown[];
export function collectionValues(collection: unknown): unknown[] {
  if (!collection) {
    return [];
  }
  const iterable = Object(collection) as object;
  const length = getProp(iterable, 'length');
  if (isLength(length)) {
    return Array.from({ length }, (_unused, index) => getProp(iterable, index));
  }
  return isObject(collection) ? Object.values(collection) : [];
}

/** `_.size`. */
export function size(collection: unknown): number {
  if (collection === null || collection === undefined) {
    return 0;
  }
  if (typeof collection === 'string') {
    return collection.length;
  }
  if (!isObject(collection)) {
    return 0;
  }
  if ('length' in collection && isLength(collection.length)) {
    return collection.length;
  }
  return Object.keys(collection).length;
}

/**
 * `_.sum(collection)` / `_.sum(collection, i => ...)` with a unary iteratee: lodash 3 sums array-like
 * values from the last element to the first, coercing every term with `+value || 0`.
 */
export function sum<T>(values: readonly T[], iteratee?: (value: T) => unknown): number {
  let result = 0;
  let length = values.length;
  while (length--) {
    const value = values[length] as T;
    result += Number(iteratee ? iteratee(value) : value) || 0;
  }
  return result;
}

/** `_.shuffle` (lodash 3 `sample(collection, Infinity)` Fisher-Yates variant). */
export function shuffle<T>(collection: readonly T[], random: () => number = Math.random): T[] {
  const result = collection.slice();
  const lastIndex = result.length - 1;
  for (let index = 0; index < result.length; index++) {
    const rand = index + Math.floor(random() * (lastIndex - index + 1));
    const value = result[rand] as T;
    result[rand] = result[index] as T;
    result[index] = value;
  }
  return result;
}

/** `_.isEqual` (lodash 3 deep equality, NaN equals NaN, constructor check for objects). */
export function isEqual(value: unknown, other: unknown): boolean {
  return baseIsEqual(value, other, [], []);
}

function baseIsEqual(
  value: unknown,
  other: unknown,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  if (value === other) {
    return true;
  }
  if (
    value === null ||
    value === undefined ||
    other === null ||
    other === undefined ||
    (!isObject(value) && !isObjectLike(other))
  ) {
    return Number.isNaN(value) && Number.isNaN(other);
  }
  return baseIsEqualDeep(value, other, stackA, stackB);
}

const arrayTag = '[object Array]';
const argsTag = '[object Arguments]';
const objectTag = '[object Object]';

function baseIsEqualDeep(
  object: unknown,
  other: unknown,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  let objIsArr = Array.isArray(object);
  let objTag = arrayTag;
  let othTag = arrayTag;

  if (!objIsArr) {
    objTag = tagOf(object);
    if (objTag === argsTag) {
      objTag = objectTag;
    } else if (objTag !== objectTag) {
      objIsArr = ArrayBuffer.isView(object) && !(object instanceof DataView);
    }
  }
  if (!Array.isArray(other)) {
    othTag = tagOf(other);
    if (othTag === argsTag) {
      othTag = objectTag;
    }
  }
  const objIsObj = objTag === objectTag;
  const isSameTag = objTag === othTag;

  if (isSameTag && !(objIsArr || objIsObj)) {
    return equalByTag(object, other, objTag);
  }
  if (!isSameTag) {
    return false;
  }
  let length = stackA.length;
  while (length--) {
    if (stackA[length] === object) {
      return stackB[length] === other;
    }
  }
  stackA.push(object);
  stackB.push(other);
  const result = objIsArr
    ? equalArrays(object as ArrayLike<unknown>, other as ArrayLike<unknown>, stackA, stackB)
    : equalObjects(
        object as Record<string, unknown>,
        other as Record<string, unknown>,
        stackA,
        stackB,
      );
  stackA.pop();
  stackB.pop();
  return result;
}

function equalArrays(
  array: ArrayLike<unknown>,
  other: ArrayLike<unknown>,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  if (array.length !== other.length) {
    return false;
  }
  for (let index = 0; index < array.length; index++) {
    const arrValue = array[index];
    const othValue = other[index];
    if (!(arrValue === othValue || baseIsEqual(arrValue, othValue, stackA, stackB))) {
      return false;
    }
  }
  return true;
}

function equalByTag(object: unknown, other: unknown, tag: string): boolean {
  switch (tag) {
    case '[object Boolean]':
    case '[object Date]':
      return Number(object) === Number(other);
    case '[object Error]': {
      const a = object as Error;
      const b = other as Error;
      return a.name === b.name && a.message === b.message;
    }
    case '[object Number]': {
      const a = Number(object);
      const b = Number(other);
      return Number.isNaN(a) ? Number.isNaN(b) : a === b;
    }
    case '[object RegExp]':
    case '[object String]':
      return String(object) === String(other);
  }
  return false;
}

function equalObjects(
  object: Record<string, unknown>,
  other: Record<string, unknown>,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  const objProps = Object.keys(object);
  const othProps = Object.keys(other);
  if (objProps.length !== othProps.length) {
    return false;
  }
  for (const key of objProps) {
    if (!Object.prototype.hasOwnProperty.call(other, key)) {
      return false;
    }
  }
  let skipCtor = false;
  for (const key of objProps) {
    if (!baseIsEqual(object[key], other[key], stackA, stackB)) {
      return false;
    }
    skipCtor ||= key === 'constructor';
  }
  if (!skipCtor) {
    const objCtor: unknown = object.constructor;
    const othCtor: unknown = other.constructor;
    if (
      objCtor !== othCtor &&
      'constructor' in object &&
      'constructor' in other &&
      !(
        typeof objCtor === 'function' &&
        objCtor instanceof objCtor &&
        typeof othCtor === 'function' &&
        othCtor instanceof othCtor
      )
    ) {
      return false;
    }
  }
  return true;
}
