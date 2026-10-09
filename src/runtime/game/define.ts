/*
 * Property/class definition helpers reproducing the observable shape of the upstream prototype-based
 * game objects (screeps/engine `utils.defineGameObjectProperties` and `X.prototype.fn = ...`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { scope } from './scope.ts';

export interface GameObjectPropertyOptions {
    enumerable?: boolean;
    configurable?: boolean;
    canSet?: boolean;
}

/** Getter table for `defineGameObjectProperties`: data property → computation from the raw data. */
export type GameObjectPropertyGetters<T, D> = {
    [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]?: (data: D, id: string | undefined) => T[K];
};

function readId(target: object): string | undefined {
    const id: unknown = Reflect.get(target, 'id');
    return typeof id === 'string' ? id : undefined;
}

/**
 * Defines lazily cached data-backed accessors on a prototype. Each getter caches its value in the
 * instance property `_<name>` and recomputes while the cached value is falsy, exactly like upstream.
 * Also (re)assigns the enumerable `toJSON` that skips `_`-prefixed keys, `toJSON` and `toString`.
 */
export function defineGameObjectProperties<T extends object, D>(
    proto: T,
    dataFn: (id: string | undefined) => D,
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
        descriptors[name] = {
            configurable: !!opts.configurable,
            enumerable,
            get(this: object): unknown {
                let value: unknown = Reflect.get(this, cacheKey);
                if (!value) {
                    const id = readId(this);
                    value = Reflect.apply(compute, undefined, [dataFn(id), id]);
                    Reflect.set(this, cacheKey, value);
                }
                return value;
            },
            set: opts.canSet
                ? function (this: object, value: unknown): void {
                      Reflect.set(this, cacheKey, value);
                  }
                : undefined,
        };
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
export function finalizeClass(ctor: abstract new (...args: never[]) => object, opts: FinalizeClassOptions = {}): void {
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

/** `Object.defineProperty(globals, name, {enumerable: true, value})` (read-only, non-configurable). */
export function exposeGlobal(name: string, value: unknown): void {
    Object.defineProperty(scope().globals, name, { enumerable: true, value });
}
