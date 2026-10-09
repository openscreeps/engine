/*
 * Store, the resource container view of objects with a `store` (screeps/engine `src/game/store.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import type { ResourceType } from '../../simulation/state.ts';
import { capacityForResource } from '../../utils/index.ts';
import { sum } from './compat.ts';
import { exposeGlobal } from './define.ts';
import { scope } from './scope.ts';

/** Raw data a store is built from (a raw room object, a power creep document or a stub). */
export interface StoreSource {
    readonly store?: Readonly<Record<string, number | undefined>> | null | undefined;
    readonly storeCapacity?: number | null | undefined;
    readonly storeCapacityResource?: Readonly<Record<string, number | null | undefined>> | null | undefined;
}

export interface StoreMethods {
    getCapacity(resource?: unknown): number | null;
    getUsedCapacity(resource?: unknown): number | null;
    getFreeCapacity(resource?: unknown): number | null;
    toString(): string;
}

/** Every known resource reads as its amount (0 when absent) through the proxy. */
export type StoreContents = { readonly [K in ResourceType]: number };

/** A `Store` instance (the proxy returned by the constructor). */
export type Store = StoreMethods & StoreContents;

export interface StoreConstructor {
    new (object: StoreSource): Store;
    readonly prototype: object;
}

const resourcesAll: readonly string[] = C.RESOURCES_ALL;

function ensureSum(target: object, store: Readonly<Record<string, number | undefined>>): number {
    const cached: unknown = Reflect.get(target, '_sum');
    if (typeof cached === 'number') {
        return cached;
    }
    const value = sum(store);
    Object.defineProperty(target, '_sum', { value });
    return value;
}

class StoreImpl {
    constructor(object: StoreSource) {
        const store = object.store;
        if (store === undefined || store === null) {
            throw new TypeError('Cannot convert undefined or null to object');
        }
        for (const [resourceType, resourceAmount] of Object.entries(store)) {
            if (resourceAmount) {
                Reflect.set(this, resourceType, resourceAmount);
            }
        }

        const getCapacity = (resource: unknown): number | null => {
            if (!resource) {
                return object.storeCapacityResource ? null : object.storeCapacity || null;
            }
            return capacityForResource(object, String(resource)) || null;
        };
        const getUsedCapacity = (self: object, resource: unknown): number | null => {
            if (!resource) {
                if (!!object.storeCapacityResource && capacityForResource(object, String(resource)) === 0) {
                    return null;
                }
                return ensureSum(self, store);
            }
            return (
                store[String(resource)] ||
                (!!object.storeCapacityResource && capacityForResource(object, String(resource)) === 0 ? null : 0)
            );
        };

        Object.defineProperties(this, {
            getCapacity: {
                value: function getCapacity(resource?: unknown): number | null {
                    return getCapacity(resource);
                },
            },
            getUsedCapacity: {
                value: function getUsedCapacity(this: object, resource?: unknown): number | null {
                    return getUsedCapacity(this, resource);
                },
            },
            getFreeCapacity: {
                value: function getFreeCapacity(this: object, resource?: unknown): number | null {
                    if (capacityForResource(object, String(resource)) === 0) {
                        return null;
                    }
                    if (!object.storeCapacity) {
                        // null operands coerce to 0 like upstream arithmetic
                        return (getCapacity(resource) ?? 0) - (getUsedCapacity(this, resource) ?? 0);
                    }
                    const capacity = getCapacity(resource);
                    if (!capacity) {
                        return null;
                    }
                    if (object.storeCapacityResource) {
                        return capacity - (getUsedCapacity(this, resource) ?? 0);
                    }
                    return capacity - ensureSum(this, store);
                },
            },
            toString: {
                value: function toString(): string {
                    return `[store]`;
                },
            },
        });

        return new Proxy(this, {
            get(target, name): unknown {
                const value: unknown = Reflect.get(target, name);
                if (value !== undefined) {
                    return value;
                }
                if (typeof name === 'string' && resourcesAll.includes(name)) {
                    return 0;
                }
                return undefined;
            },
        });
    }
}

// The constructor returns the proxy; the instance type is described by `Store`.
export const Store = StoreImpl as unknown as StoreConstructor;

export function make(): void {
    if (scope().globals.Store) {
        return;
    }
    exposeGlobal('Store', Store);
}
