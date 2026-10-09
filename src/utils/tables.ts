/** JS `target[key]` on an arbitrary value (throws on null/undefined, inherited members included). */
export function getProp(target: unknown, key: PropertyKey): unknown {
  if (target === null || target === undefined) {
    throw new TypeError(`Cannot read properties of ${String(target)} (reading '${String(key)}')`);
  }
  const value: unknown = Reflect.get(Object(target), key);
  return value;
}

/** Plain JS property read (`object[key]`) on a value whose shape is not statically known. */
export function readProp(object: object, key: PropertyKey): unknown {
  // Plain property read (including inherited members), exactly like `object[key]` in JS.
  const value: unknown = Reflect.get(object, key);
  return value;
}

/**
 * Reads `table[key]` only when `key` is an own property, so arbitrary strings coming from game state
 * or user code can index the literal-typed constant tables without hitting `Object.prototype` members.
 */
export function ownValue<T extends object>(table: T, key: PropertyKey): T[keyof T] | undefined {
  if (!Object.hasOwn(table, key)) {
    return undefined;
  }
  // `key` is an own property of `table`, hence one of `keyof T`.
  const ownKey = key as keyof T;
  return table[ownKey];
}
