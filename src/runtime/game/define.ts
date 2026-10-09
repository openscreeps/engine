/*
 * Property/class definition helpers reproducing the observable shape of the upstream prototype-based
 * game objects (screeps/engine `utils.defineGameObjectProperties` and `X.prototype.fn = ...`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { sloppyThis } from './compat.ts';
import { scope } from './scope.ts';

export interface GameObjectPropertyOptions {
  enumerable?: boolean;
  configurable?: boolean;
  canSet?: boolean;
}

/** Getter table for `defineGameObjectProperties`: data property → computation from the raw data. */
export type GameObjectPropertyGetters<T, D> = {
  [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]?: (
    data: D,
    id: unknown,
  ) => T[K];
};

/**
 * Defines lazily cached data-backed accessors on a prototype. Each getter caches its value in the
 * instance property `_<name>` and recomputes while the cached value is falsy, exactly like upstream.
 * Also (re)assigns the enumerable `toJSON` that skips `_`-prefixed keys, `toJSON` and `toString`.
 */
export function defineGameObjectProperties<T extends object, D>(
  proto: T,
  dataFn: (id: unknown) => D,
  properties: GameObjectPropertyGetters<T, D>,
  opts: GameObjectPropertyOptions = {},
): void {
  const enumerable = opts.enumerable ?? true;
  const descriptors: PropertyDescriptorMap = {};
  for (const name of Object.keys(properties)) {
    const compute: unknown = Reflect.get(properties, name);
    if (typeof compute !== 'function') {
      continue;
    }
    const cacheKey = '_' + name;
    const descriptor: PropertyDescriptor = {
      configurable: !!opts.configurable,
      enumerable,
      get(this: object): unknown {
        let value: unknown = Reflect.get(this, cacheKey);
        if (!value) {
          // Upstream passes `this.id` unchanged (any value) to the data function.
          const id: unknown = Reflect.get(this, 'id');
          value = Reflect.apply(compute, undefined, [dataFn(id), id]);
          Reflect.set(this, cacheKey, value);
        }
        return value;
      },
    };
    if (opts.canSet) {
      descriptor.set = function (this: object, value: unknown): void {
        Reflect.set(this, cacheKey, value);
      };
    }
    descriptors[name] = descriptor;
  }
  Object.defineProperties(proto, descriptors);
  Reflect.set(proto, 'toJSON', gameObjectToJSON);
}

/** Upstream `obj.toJSON`: every enumerable (own and inherited) key except `_*`, `toJSON`, `toString`. */
export function gameObjectToJSON(this: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in this) {
    if (key.startsWith('_') || key === 'toJSON' || key === 'toString') {
      continue;
    }
    result[key] = Reflect.get(this, key);
  }
  return result;
}

export interface FinalizeClassOptions {
  /** Upstream assigned `X.prototype.constructor = X` (enumerable) for derived constructors. */
  enumerableConstructor?: boolean;
}

/**
 * Makes class-body methods enumerable on the prototype and static methods enumerable on the
 * constructor, matching upstream `X.prototype.fn = function` / `X.fn = function` assignments.
 * Accessors are left untouched (define them with `Object.defineProperty` where upstream does).
 */
export function finalizeClass(
  ctor: abstract new (...args: never[]) => object,
  opts: FinalizeClassOptions = {},
): void {
  const proto: unknown = ctor.prototype;
  if (typeof proto === 'object' && proto !== null) {
    makeMethodsEnumerable(proto, opts.enumerableConstructor ?? true);
  }
  for (const key of Object.getOwnPropertyNames(ctor)) {
    if (key === 'prototype' || key === 'length' || key === 'name') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(ctor, key);
    if (descriptor && 'value' in descriptor && !descriptor.enumerable) {
      Object.defineProperty(ctor, key, { ...descriptor, enumerable: true });
    }
  }
}

function makeMethodsEnumerable(proto: object, enumerableConstructor: boolean): void {
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor' && !enumerableConstructor) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (descriptor && 'value' in descriptor && !descriptor.enumerable) {
      Object.defineProperty(proto, key, { ...descriptor, enumerable: true });
    }
  }
}

/**
 * A game API constructor as upstream defines them: a plain function that can be invoked with `new`
 * (`new Creep(id)`) or applied to an existing receiver (`Creep.call(this, id)` in ES5-style
 * subclasses), sharing one prototype for `instanceof`.
 */
export interface GameConstructor<I extends object, A extends unknown[]> {
  new (...args: A): I;
  (this: unknown, ...args: A): unknown;
  readonly prototype: I;
}

export interface GameConstructorOptions {
  /** Upstream function name (`''` for the anonymous `register.wrapFn(function (…) {…})`). */
  name: string;
  /** Number of declared upstream parameters (`Function.prototype.length`). */
  length: number;
  /** Upstream assigned `X.prototype.constructor = X` (enumerable) for derived constructors. */
  enumerableConstructor?: boolean;
  /** The upstream body is strict-mode (`"use strict"`): the receiver is passed through unchanged. */
  strict?: boolean;
  /** Methods (prototype or static) whose upstream function expression is named, e.g. `spawnCreep`. */
  namedMethods?: readonly string[];
}

/**
 * Builds the callable constructor for a game class. `impl` supplies the prototype (methods, accessors
 * and static members, typed by the class declaration) and is never constructed itself; `init`
 * initializes the receiver exactly like the upstream constructor body and may return a replacement
 * object (e.g. `Store`'s proxy). Upstream game files are sloppy-mode scripts, so a call without a
 * receiver initializes the global object, like upstream.
 */
export function gameConstructor<I extends object, A extends unknown[]>(
  impl: abstract new (...args: never[]) => I,
  init: (this: I, ...args: A) => unknown,
  opts: GameConstructorOptions,
): GameConstructor<I, A> {
  const ctor = function (this: unknown, ...args: A): unknown {
    return Reflect.apply(init, opts.strict ? this : sloppyThis(this), args);
  } as unknown as GameConstructor<I, A>;
  Object.defineProperty(ctor, 'name', { value: opts.name, configurable: true });
  Object.defineProperty(ctor, 'length', { value: opts.length, configurable: true });
  const proto: unknown = impl.prototype;
  Object.defineProperty(ctor, 'prototype', { value: proto, writable: true });
  const named = new Set(opts.namedMethods ?? []);
  if (typeof proto === 'object' && proto !== null) {
    makeMethodsEnumerable(proto, false);
    anonymizeMethods(proto, named);
    Object.defineProperty(proto, 'constructor', {
      value: ctor,
      writable: true,
      enumerable: opts.enumerableConstructor ?? true,
      configurable: true,
    });
  }
  for (const key of Reflect.ownKeys(impl)) {
    if (key === 'prototype' || key === 'length' || key === 'name') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(impl, key);
    if (descriptor) {
      Object.defineProperty(
        ctor,
        key,
        'value' in descriptor ? { ...descriptor, enumerable: true } : descriptor,
      );
    }
  }
  anonymizeMethods(ctor, named);
  return ctor;
}

/**
 * Upstream methods are anonymous function expressions (`X.prototype.fn = register.wrapFn(function
 * (…) {…})`), so their `name` is `''` unless the source names them.
 */
function anonymizeMethods(target: object, named: ReadonlySet<string>): void {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (key === 'constructor' || key === 'prototype' || named.has(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    const value: unknown = descriptor?.value;
    if (typeof value === 'function' && value.name === key) {
      Object.defineProperty(value, 'name', { value: '', configurable: true });
    }
  }
}

/** `Object.defineProperty(globals, name, {enumerable: true, value})` (read-only, non-configurable). */
export function exposeGlobal(name: string, value: unknown): void {
  Object.defineProperty(scope().globals, name, { enumerable: true, value });
}
