/**
 * Exact ECMAScript operator semantics for values that may come straight from player code.
 * Upstream engine code applies `==`, `+`, `-`, `*`, `&`, `<`/`<=` to raw arguments; these helpers
 * reproduce the language semantics (ToPrimitive hints, evaluation order, BigInt rules, thrown
 * TypeErrors) on `unknown` inputs.
 */

import { isObject } from './lodash.ts';
import { getProp } from './tables.ts';

export type PrimitiveHint = 'default' | 'number' | 'string';

/** ECMAScript ToPrimitive(value, hint). */
export function toPrimitive(value: unknown, hint: PrimitiveHint): unknown {
  if (!isObject(value)) {
    return value;
  }
  const exotic = getProp(value, Symbol.toPrimitive);
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== 'function') {
      throw new TypeError('Symbol.toPrimitive is not a function');
    }
    const result: unknown = Reflect.apply(exotic, value, [hint]);
    if (isObject(result)) {
      throw new TypeError('Cannot convert object to primitive value');
    }
    return result;
  }
  const order = hint === 'string' ? ['toString', 'valueOf'] : ['valueOf', 'toString'];
  for (const method of order) {
    const fn = getProp(value, method);
    if (typeof fn === 'function') {
      const result: unknown = Reflect.apply(fn, value, []);
      if (!isObject(result)) {
        return result;
      }
    }
  }
  throw new TypeError('Cannot convert object to primitive value');
}

/** ToString of an already-primitive value. */
function primitiveToString(primitive: unknown): string {
  switch (typeof primitive) {
    case 'string':
      return primitive;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(primitive);
    case 'undefined':
      return 'undefined';
    case 'symbol':
      throw new TypeError('Cannot convert a Symbol value to a string');
    default:
      // Objects and functions are excluded by the callers; only `null` remains.
      return 'null';
  }
}

/** ToNumeric of an already-primitive value. */
function primitiveToNumeric(primitive: unknown): number | bigint {
  switch (typeof primitive) {
    case 'bigint':
    case 'number':
      return primitive;
    case 'symbol':
      throw new TypeError('Cannot convert a Symbol value to a number');
    case 'string':
    case 'boolean':
      return Number(primitive);
    case 'undefined':
      return NaN;
    default:
      // Only `null` remains.
      return 0;
  }
}

/** JS `String(value)`: Symbols yield their description string, everything else uses ToString (`string` hint). */
export function jsString(value: unknown): string {
  return typeof value === 'symbol'
    ? String(value)
    : primitiveToString(toPrimitive(value, 'string'));
}

/** JS `'' + value`: ToPrimitive with the `default` hint, then ToString (Symbols throw). */
export function jsConcat(value: unknown): string {
  return primitiveToString(toPrimitive(value, 'default'));
}

/** ECMAScript ToPropertyKey: ToPrimitive with the `string` hint; Symbols are kept, everything else becomes a string. */
export function toPropertyKey(value: unknown): PropertyKey {
  const key = toPrimitive(value, 'string');
  return typeof key === 'symbol' ? key : primitiveToString(key);
}

/** ECMAScript ToNumeric. */
function toNumeric(value: unknown): number | bigint {
  return primitiveToNumeric(toPrimitive(value, 'number'));
}

/** ECMAScript ToNumber (throws for BigInt, like unary `+`). */
export function toNumber(value: unknown): number {
  const numeric = toNumeric(value);
  if (typeof numeric === 'bigint') {
    throw new TypeError('Cannot convert a BigInt value to a number');
  }
  return numeric;
}

const mixError = 'Cannot mix BigInt and other types, use explicit conversions';

type NumericOperands =
  | { readonly kind: 'number'; readonly left: number; readonly right: number }
  | { readonly kind: 'bigint'; readonly left: bigint; readonly right: bigint };

/** Converts both operands with ToNumeric (left first) and enforces matching numeric types. */
function numericOperands(a: unknown, b: unknown): NumericOperands {
  const left = toNumeric(a);
  const right = toNumeric(b);
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return { kind: 'bigint', left, right };
  }
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    throw new TypeError(mixError);
  }
  return { kind: 'number', left, right };
}

/** JS `a + b`. */
export function jsAdd(a: unknown, b: unknown): number | string | bigint {
  const left = toPrimitive(a, 'default');
  const right = toPrimitive(b, 'default');
  if (typeof left === 'string' || typeof right === 'string') {
    return primitiveToString(left) + primitiveToString(right);
  }
  const ops = numericOperands(left, right);
  return ops.kind === 'bigint' ? ops.left + ops.right : ops.left + ops.right;
}

/** JS `a - b`. */
export function jsSub(a: unknown, b: unknown): number | bigint {
  const ops = numericOperands(a, b);
  return ops.kind === 'bigint' ? ops.left - ops.right : ops.left - ops.right;
}

/** JS `a * b`. */
export function jsMul(a: unknown, b: unknown): number | bigint {
  const ops = numericOperands(a, b);
  return ops.kind === 'bigint' ? ops.left * ops.right : ops.left * ops.right;
}

/** JS `a & b`. */
export function jsBitAnd(a: unknown, b: unknown): number | bigint {
  const ops = numericOperands(a, b);
  return ops.kind === 'bigint' ? ops.left & ops.right : ops.left & ops.right;
}

/** ECMAScript StringToBigInt; `undefined` when the string is not a valid BigInt literal. */
function stringToBigInt(text: string): bigint | undefined {
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

/** ECMAScript IsLessThan on already-primitive operands; `undefined` means "unordered" (NaN). */
function isLessThan(px: unknown, py: unknown): boolean | undefined {
  if (typeof px === 'string' && typeof py === 'string') {
    return px < py;
  }
  if (typeof px === 'bigint' && typeof py === 'string') {
    const ny = stringToBigInt(py);
    return ny === undefined ? undefined : px < ny;
  }
  if (typeof px === 'string' && typeof py === 'bigint') {
    const nx = stringToBigInt(px);
    return nx === undefined ? undefined : nx < py;
  }
  const nx = primitiveToNumeric(px);
  const ny = primitiveToNumeric(py);
  if (Number.isNaN(nx) || Number.isNaN(ny)) {
    return undefined;
  }
  return nx < ny;
}

/** JS `a < b` (operands converted left first). */
export function jsLt(a: unknown, b: unknown): boolean {
  const px = toPrimitive(a, 'number');
  const py = toPrimitive(b, 'number');
  return isLessThan(px, py) === true;
}

/** JS `a <= b` (operands converted left first). */
export function jsLe(a: unknown, b: unknown): boolean {
  const px = toPrimitive(a, 'number');
  const py = toPrimitive(b, 'number');
  return isLessThan(py, px) === false;
}

/** JS `a > b`. */
export function jsGt(a: unknown, b: unknown): boolean {
  const px = toPrimitive(a, 'number');
  const py = toPrimitive(b, 'number');
  return isLessThan(py, px) === true;
}

/** JS `a >= b`. */
export function jsGe(a: unknown, b: unknown): boolean {
  const px = toPrimitive(a, 'number');
  const py = toPrimitive(b, 'number');
  return isLessThan(px, py) === false;
}

/** JS `a == b` (IsLooselyEqual). */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === typeof b || (isObject(a) && isObject(b))) {
    return a === b;
  }
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return true;
  }
  if (typeof a === 'number' && typeof b === 'string') {
    return a === Number(b);
  }
  if (typeof a === 'string' && typeof b === 'number') {
    return Number(a) === b;
  }
  if (typeof a === 'bigint' && typeof b === 'string') {
    const n = stringToBigInt(b);
    return n !== undefined && a === n;
  }
  if (typeof a === 'string' && typeof b === 'bigint') {
    return looseEquals(b, a);
  }
  if (typeof a === 'boolean') {
    return looseEquals(Number(a), b);
  }
  if (typeof b === 'boolean') {
    return looseEquals(a, Number(b));
  }
  const isComparablePrimitive = (v: unknown): boolean =>
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'bigint' ||
    typeof v === 'symbol';
  if (isObject(a) && isComparablePrimitive(b)) {
    return looseEquals(toPrimitive(a, 'default'), b);
  }
  if (isComparablePrimitive(a) && isObject(b)) {
    return looseEquals(a, toPrimitive(b, 'default'));
  }
  if (typeof a === 'bigint' && typeof b === 'number') {
    return Number.isFinite(b) && Number.isInteger(b) && a === BigInt(b);
  }
  if (typeof a === 'number' && typeof b === 'bigint') {
    return looseEquals(b, a);
  }
  return false;
}
