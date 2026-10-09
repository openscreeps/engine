/*
 * Store, the resource container view of objects with a `store` (screeps/engine `src/game/store.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import type { ResourceType } from '../../simulation/state.ts';
import { capacityForResource } from '../../utils/index.ts';
import { jsSub } from '../../utils/js.ts';
import { collectionValues, sum } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { jsSetSloppy, sloppyThis } from './compat.ts';
import { exposeGlobal, gameConstructor, type GameConstructor } from './define.ts';
import { scope } from './scope.ts';

/** Raw data a store is built from (a raw room object, a power creep document or a stub). */
export interface StoreSource {
  readonly store?: Readonly<Record<string, number | null | undefined>> | null | undefined;
  readonly storeCapacity?: number | null | undefined;
  readonly storeCapacityResource?:
    Readonly<Record<string, number | null | undefined>> | null | undefined;
}

/** Valid resource keys (or none) give numbers; other keys may read inherited properties like upstream. */
export interface StoreMethods {
  getCapacity(resource?: ResourceType | null): number | null;
  getCapacity(resource: unknown): unknown;
  getUsedCapacity(resource?: ResourceType | null): number | null;
  getUsedCapacity(resource: unknown): unknown;
  getFreeCapacity(resource?: ResourceType | null): number | null;
  getFreeCapacity(resource: unknown): unknown;
  toString(): string;
}

/** Every known resource reads as its amount (0 when absent) through the proxy. */
export type StoreContents = { readonly [K in ResourceType]: number };

/** A `Store` instance (the proxy returned by the constructor). */
export type Store = StoreMethods & StoreContents;

const resourcesAll: readonly string[] = C.RESOURCES_ALL;

/** Upstream `if(this._sum === undefined) Object.defineProperty(this, '_sum', ...)`; returns `this._sum`. */
function cachedSum(self: object, object: StoreSource): unknown {
  if (getProp(self, '_sum') === undefined) {
    Object.defineProperty(self, '_sum', { value: sum(collectionValues(object.store)) });
  }
  return getProp(self, '_sum');
}

/** Upstream `this.<name>(resource)` on the (sloppy-mode) receiver. */
function callOwn(
  self: object,
  name: 'getCapacity' | 'getUsedCapacity',
  resource: unknown,
): unknown {
  const method = getProp(self, name);
  if (typeof method !== 'function') {
    throw new TypeError(`this.${name} is not a function`);
  }
  const result: unknown = Reflect.apply(method, self, [resource]);
  return result;
}

/**
 * Prototype carrier: upstream keeps the default `Store.prototype`; every member below is an own,
 * non-enumerable property defined by the constructor body.
 */
class StoreImpl {
  declare readonly getCapacity: StoreMethods['getCapacity'];
  declare readonly getUsedCapacity: StoreMethods['getUsedCapacity'];
  declare readonly getFreeCapacity: StoreMethods['getFreeCapacity'];
}

/**
 * Upstream `register.wrapFn(function(object) {…})`: initializes the receiver and returns a proxy over
 * it, so `new Store(o)` yields the proxy.
 */
function initStore(this: StoreImpl, object: StoreSource): object {
  const store = object.store;
  if (store === undefined || store === null) {
    throw new TypeError('Cannot convert undefined or null to object');
  }
  for (const [resourceType, resourceAmount] of Object.entries(store)) {
    if (resourceAmount) {
      jsSetSloppy(this, resourceType, resourceAmount);
    }
  }

  Object.defineProperties(this, {
    getCapacity: {
      value: function getCapacity(resource?: unknown): unknown {
        if (!resource) {
          return object.storeCapacityResource ? null : object.storeCapacity || null;
        }
        return capacityForResource(object, resource) || null;
      },
    },
    getUsedCapacity: {
      value: function getUsedCapacity(this: unknown, resource?: unknown): unknown {
        const self = sloppyThis(this);
        if (!resource) {
          if (!!object.storeCapacityResource && capacityForResource(object, resource) === 0) {
            return null;
          }
          return cachedSum(self, object);
        }
        return (
          getProp(object.store, resource as PropertyKey) ||
          (!!object.storeCapacityResource && capacityForResource(object, resource) === 0 ? null : 0)
        );
      },
    },
    getFreeCapacity: {
      value: function getFreeCapacity(this: unknown, resource?: unknown): unknown {
        const self = sloppyThis(this);
        if (capacityForResource(object, resource) === 0) {
          return null;
        }

        if (!object.storeCapacity) {
          return jsSub(
            callOwn(self, 'getCapacity', resource),
            callOwn(self, 'getUsedCapacity', resource),
          );
        }

        const capacity = callOwn(self, 'getCapacity', resource);
        if (!capacity) {
          return null;
        }

        if (object.storeCapacityResource) {
          return jsSub(capacity, callOwn(self, 'getUsedCapacity', resource));
        }

        return jsSub(capacity, cachedSum(self, object));
      },
    },
    toString: {
      value: function toString(): string {
        return `[store]`;
      },
    },
  });

  return new Proxy(this, {
    get(proxyTarget, name): unknown {
      if (Reflect.get(proxyTarget, name) !== undefined) {
        return Reflect.get(proxyTarget, name);
      }
      if (typeof name === 'string' && resourcesAll.includes(name)) {
        return 0;
      }
      return undefined;
    },
  });
}

// The init returns the proxy, whose resource reads are typed by `Store` (a subtype of `StoreImpl`).
export const Store = gameConstructor(StoreImpl, initStore, {
  name: '',
  length: 1,
  enumerableConstructor: false,
}) as GameConstructor<Store, [object: StoreSource]>;

export function make(): void {
  if (scope().globals.Store) {
    return;
  }
  exposeGlobal('Store', Store);
}
