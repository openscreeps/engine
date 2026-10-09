/*
 * Game.market (screeps/engine `src/game/market.js`).
 *
 * Upstream market.js is sloppy-mode code operating on player-supplied values: `this` is coerced with
 * `sloppyThis`, keys and operands go through the JS-semantics helpers, and `_.filter` / `_.find` /
 * `_.any` follow lodash 3 callback semantics (functions, `_.matches` objects, `_.property` paths).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { calcTerminalEnergyCost } from '../../utils/calc.ts';
import { jsAdd, jsConcat, jsGt, jsLt, jsMul, jsSub, toNumber } from '../../utils/js.ts';
import { isObject, size } from '../../utils/lodash.ts';
import { getProp } from '../../utils/tables.ts';
import { contains, jsSetSloppy, sloppyThis } from './compat.ts';
import { calcRoomsDistanceLoose } from './map.ts';
import { scope } from './scope.ts';

export interface GameMarket {
  readonly credits: number;
  readonly incomingTransactions: Record<string, unknown>[];
  readonly outgoingTransactions: Record<string, unknown>[];
  readonly orders: Record<string, unknown>;
  calcTransactionCost(amount: unknown, roomName1: unknown, roomName2: unknown): number;
  getAllOrders(filter?: unknown): unknown[];
  getHistory(resourceType?: unknown): unknown;
  getOrderById(id: unknown): unknown;
  createOrder(
    type: unknown,
    resourceType?: unknown,
    price?: unknown,
    totalAmount?: unknown,
    roomName?: unknown,
  ): number;
  cancelOrder(orderId: unknown): number;
  deal(orderId: unknown, amount: unknown, targetRoomName?: unknown): number;
  changeOrderPrice(orderId: unknown, newPrice: unknown): number;
  extendOrder(orderId: unknown, addAmount: unknown): number;
}

/** Identity wrapper standing in for upstream `register.wrapFn`: keeps function expressions anonymous. */
function wrapFn<F>(fn: F): F {
  return fn;
}

// lodash 3.10 collection helpers (`_.filter`, `_.find`, `_.any` with `_.callback` predicates).

const MAX_SAFE_INTEGER = 9007199254740991;
const reIsDeepProp = /\.|\[(?:[^[\]]*|(["'])(?:(?!\1)[^\n\\]|\\.)*?\1)\]/;
const reIsPlainProp = /^\w*$/;
const rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\n\\]|\\.)*?)\2)\]/g;
const reEscapeChar = /\\(\\)?/g;
const reIsUint = /^\d+$/;
const typedArrayTags = new Set([
  '[object Float32Array]',
  '[object Float64Array]',
  '[object Int8Array]',
  '[object Int16Array]',
  '[object Int32Array]',
  '[object Uint8Array]',
  '[object Uint8ClampedArray]',
  '[object Uint16Array]',
  '[object Uint32Array]',
]);

type Predicate = (value: unknown, key: string | number, collection: object) => unknown;

function objectTag(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function isObjectLike(value: unknown): value is object {
  return !!value && typeof value == 'object';
}

function isLength(value: unknown): value is number {
  return typeof value == 'number' && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
}

function isArrayLike(value: unknown): boolean {
  return value != null && isLength(getProp(value, 'length'));
}

function isIndex(value: string, length: number): boolean {
  const index = reIsUint.test(value) ? +value : -1;
  return index > -1 && index % 1 == 0 && index < length;
}

function isArguments(value: unknown): boolean {
  return (
    isObjectLike(value) &&
    isArrayLike(value) &&
    Object.prototype.hasOwnProperty.call(value, 'callee') &&
    !Object.prototype.propertyIsEnumerable.call(value, 'callee')
  );
}

function isTypedArray(value: unknown): boolean {
  return (
    isObjectLike(value) &&
    isLength(getProp(value, 'length')) &&
    typedArrayTags.has(objectTag(value))
  );
}

/** lodash 3 `keysIn`. */
function keysIn(object: object): string[] {
  let length = getProp(object, 'length');
  length =
    (length && isLength(length) && (Array.isArray(object) || isArguments(object)) && length) || 0;
  const count = Number(length);
  const ctor = getProp(object, 'constructor');
  const isProto = typeof ctor == 'function' && getProp(ctor, 'prototype') === object;
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    result.push(String(index));
  }
  const skipIndexes = count > 0;
  for (const key in object) {
    if (
      !(skipIndexes && isIndex(key, count)) &&
      !(key == 'constructor' && (isProto || !Object.prototype.hasOwnProperty.call(object, key)))
    ) {
      result.push(key);
    }
  }
  return result;
}

/** lodash 3 `shimKeys`. */
function shimKeys(object: object): string[] {
  const props = keysIn(object);
  const propsLength = props.length;
  const length = propsLength && getProp(object, 'length');
  const allowIndexes =
    !!length && isLength(length) && (Array.isArray(object) || isArguments(object));
  const result: string[] = [];
  for (const key of props) {
    if (
      (allowIndexes && isIndex(key, length)) ||
      Object.prototype.hasOwnProperty.call(object, key)
    ) {
      result.push(key);
    }
  }
  return result;
}

/** lodash 3 `_.keys`. */
function lodashKeys(object: unknown): string[] {
  const ctor = object == null ? undefined : getProp(object, 'constructor');
  if (
    (typeof ctor == 'function' && getProp(ctor, 'prototype') === object) ||
    (typeof object != 'function' && isArrayLike(object))
  ) {
    return shimKeys(Object(object) as object);
  }
  return isObject(object) ? Object.keys(object) : [];
}

/** lodash 3 `baseEach`: index loop for array-likes, own keys otherwise; stops when `iteratee` returns `false`. */
function baseEach(
  collection: unknown,
  iteratee: (value: unknown, key: string | number, collection: object) => boolean,
): void {
  const length = collection ? getProp(collection, 'length') : 0;
  if (!isLength(length)) {
    if (collection == null) {
      return;
    }
    const iterable = Object(collection) as object;
    for (const key of lodashKeys(collection)) {
      if (!iteratee(getProp(iterable, key), key, iterable)) {
        return;
      }
    }
    return;
  }
  const iterable = Object(collection) as object;
  for (let index = 0; index < length; index++) {
    if (!iteratee(getProp(iterable, index), index, iterable)) {
      return;
    }
  }
}

/** lodash 3 `baseIsEqual` in loose (partial) mode, as used by `_.matches`. */
function baseIsEqualLoose(
  value: unknown,
  other: unknown,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  if (value === other) {
    return true;
  }
  if (value == null || other == null || (!isObject(value) && !isObjectLike(other))) {
    return value !== value && other !== other;
  }
  let objIsArr = Array.isArray(value);
  const othIsArr = Array.isArray(other);
  let objTag = '[object Array]';
  let othTag = '[object Array]';
  if (!objIsArr) {
    objTag = objectTag(value);
    if (objTag == '[object Arguments]') {
      objTag = '[object Object]';
    } else if (objTag != '[object Object]') {
      objIsArr = isTypedArray(value);
    }
  }
  if (!othIsArr) {
    othTag = objectTag(other);
    if (othTag == '[object Arguments]') {
      othTag = '[object Object]';
    } else if (othTag != '[object Object]') {
      // lodash computes `othIsArr` here; only the `length` read of the probe is observable.
      isTypedArray(other);
    }
  }
  const objIsObj = objTag == '[object Object]';
  const isSameTag = objTag == othTag;
  if (isSameTag && !(objIsArr || objIsObj)) {
    return equalByTag(value, other, objTag);
  }
  if (!isSameTag) {
    return false;
  }
  let length = stackA.length;
  while (length--) {
    if (stackA[length] == value) {
      return stackB[length] == other;
    }
  }
  stackA.push(value);
  stackB.push(other);
  const result = objIsArr
    ? equalArrays(value, other, stackA, stackB)
    : equalObjects(value, other, stackA, stackB);
  stackA.pop();
  stackB.pop();
  return result;
}

function equalByTag(object: unknown, other: unknown, tag: string): boolean {
  switch (tag) {
    case '[object Boolean]':
    case '[object Date]':
      return toNumber(object) == toNumber(other);
    case '[object Error]':
      return (
        getProp(object, 'name') == getProp(other, 'name') &&
        getProp(object, 'message') == getProp(other, 'message')
      );
    case '[object Number]':
      // lodash compares with loose equality and unary plus (`+x` is ToNumber).
      return object != toNumber(object) ? other != toNumber(other) : object == toNumber(other);
    case '[object RegExp]':
    case '[object String]':
      return object == jsConcat(other);
  }
  return false;
}

function equalArrays(
  array: unknown,
  other: unknown,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  const arrLength = Number(getProp(array, 'length'));
  const othLength = Number(getProp(other, 'length'));
  if (arrLength != othLength && !(othLength > arrLength)) {
    return false;
  }
  for (let index = 0; index < arrLength; index++) {
    const arrValue = getProp(array, index);
    let found = false;
    for (let othIndex = 0; othIndex < othLength; othIndex++) {
      const othValue = getProp(other, othIndex);
      if (arrValue === othValue || baseIsEqualLoose(arrValue, othValue, stackA, stackB)) {
        found = true;
        break;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

function equalObjects(
  object: object,
  other: object,
  stackA: unknown[],
  stackB: unknown[],
): boolean {
  const objProps = lodashKeys(object);
  lodashKeys(other);
  let index = objProps.length;
  while (index--) {
    const key = objProps[index];
    if (key === undefined || !(key in other)) {
      return false;
    }
  }
  for (const key of objProps) {
    if (!baseIsEqualLoose(getProp(object, key), getProp(other, key), stackA, stackB)) {
      return false;
    }
  }
  return true;
}

/** lodash 3 `baseMatches`. */
function baseMatches(source: object): Predicate {
  const matchData = lodashKeys(Object(source)).map((key) => {
    const value = getProp(source, key);
    return { key, value, strict: value === value && !isObject(value) };
  });
  const single = matchData.length == 1 ? matchData[0] : undefined;
  if (single?.strict) {
    return (object) => {
      if (object == null) {
        return false;
      }
      return (
        getProp(object, single.key) === single.value &&
        (single.value !== undefined || single.key in Object(object))
      );
    };
  }
  return (object) => {
    if (object == null) {
      return !matchData.length;
    }
    const target = Object(object) as object;
    let index = matchData.length;
    while (index--) {
      const data = matchData[index];
      if (
        data &&
        (data.strict ? data.value !== getProp(target, data.key) : !(data.key in target))
      ) {
        return false;
      }
    }
    for (const data of matchData) {
      const objValue = getProp(target, data.key);
      if (data.strict) {
        if (objValue === undefined && !(data.key in target)) {
          return false;
        }
      } else if (!baseIsEqualLoose(data.value, objValue, [], [])) {
        return false;
      }
    }
    return true;
  };
}

/** lodash 3 `toPath`. */
function toPath(value: unknown): string[] {
  const result: string[] = [];
  const text = value == null ? '' : jsConcat(value);
  text.replace(
    rePropName,
    (
      match: string,
      num: string | undefined,
      quote: string | undefined,
      str: string | undefined,
    ) => {
      result.push(quote ? (str ?? '').replace(reEscapeChar, '$1') : num || match);
      return match;
    },
  );
  return result;
}

/** lodash 3 `_.property`. */
function baseProperty(path: unknown): Predicate {
  const isKey =
    (typeof path == 'string' && reIsPlainProp.test(path)) ||
    typeof path == 'number' ||
    // Boundary: `RegExp.prototype.test` performs ToString on any value.
    (!Array.isArray(path) && !reIsDeepProp.test(path as string));
  if (isKey) {
    // Boundary: the key is converted by the property lookup itself.
    return (object) => (object == null ? undefined : getProp(object, path as PropertyKey));
  }
  const pathKey = jsConcat(path);
  const steps = toPath(path);
  return (object) => {
    if (object == null) {
      return undefined;
    }
    const keys = pathKey in Object(object) ? [pathKey] : steps;
    let current: unknown = object;
    let index = 0;
    while (current != null && index < keys.length) {
      current = getProp(current, keys[index++] ?? '');
    }
    return index && index == keys.length ? current : undefined;
  };
}

/** lodash 3 `baseCallback(func, undefined, 3)`. */
function baseCallback(func: unknown): Predicate {
  if (typeof func == 'function') {
    return (value, key, collection) => {
      const result: unknown = Reflect.apply(func, undefined, [value, key, collection]);
      return result;
    };
  }
  if (func == null) {
    return (value) => value;
  }
  if (typeof func == 'object') {
    return baseMatches(func);
  }
  return baseProperty(func);
}

/** `_.filter(collection, predicate)`. */
function lodashFilter(collection: unknown, predicate: unknown): unknown[] {
  const test = baseCallback(predicate);
  const result: unknown[] = [];
  baseEach(collection, (value, key, iterable) => {
    if (test(value, key, iterable)) {
      result.push(value);
    }
    return true;
  });
  return result;
}

/** `_.find(collection, predicate)`. */
function lodashFind(collection: unknown, predicate: unknown): unknown {
  const test = baseCallback(predicate);
  let result: unknown;
  baseEach(collection, (value, key, iterable) => {
    if (test(value, key, iterable)) {
      result = value;
      return false;
    }
    return true;
  });
  return result;
}

/** `_.any(collection, predicate)`. */
function lodashAny(collection: unknown, predicate: unknown): boolean {
  const test = baseCallback(predicate);
  let result = false;
  baseEach(collection, (value, key, iterable) => {
    result = !!test(value, key, iterable);
    return !result;
  });
  return result;
}

function isMarketResource(resourceType: unknown): boolean {
  return contains(C.RESOURCES_ALL, resourceType) || contains(C.INTERSHARD_RESOURCES, resourceType);
}

/** `JSON.parse(JSON.stringify(value))` on any value (throws a SyntaxError for unserializable values). */
function jsonClone(value: unknown): unknown {
  // Boundary: `JSON.stringify` yields `undefined` for functions/undefined, which `JSON.parse` rejects.
  const result: unknown = JSON.parse(JSON.stringify(value));
  return result;
}

/** Sloppy-mode `target.price /= 1000`. */
function dividePrice(target: unknown): void {
  // Boundary: native `/` applies ToNumeric to the untrusted price (BigInt mixing throws like upstream).
  jsSetSloppy(target, 'price', (getProp(target, 'price') as number) / 1000);
}

/** Sloppy-mode `this.<name>(...args)` (`TypeError: this.<name> is not a function` otherwise). */
function callMethod(self: object, name: string, args: unknown[]): unknown {
  const fn = getProp(self, name);
  if (typeof fn !== 'function') {
    throw new TypeError(`this.${name} is not a function`);
  }
  const result: unknown = Reflect.apply(fn, self, args);
  return result;
}

export function makeMarket(): GameMarket {
  const { runtimeData, intents } = scope();

  // Per-market (per-tick) state, upstream closure variables.
  let ordersCreatedDuringTick = 0;
  const cachedOrders: Record<string, unknown> = {};
  const cachedHistory: Record<string, unknown> = {};
  let incomingTransactions: Record<string, unknown>[] | undefined;
  let outgoingTransactions: Record<string, unknown>[] | undefined;
  let orders: Record<string, unknown> | undefined;

  function getOrders(resourceTypeArg: unknown): unknown {
    // Boundary: keys are converted by each property access, like upstream `cachedOrders[resourceType]`.
    let resourceType = resourceTypeArg as PropertyKey;
    if (!resourceType) {
      resourceType = 'all';
    }
    if (!getProp(cachedOrders, resourceType)) {
      if (resourceType != 'all' && !isMarketResource(resourceType)) {
        return {};
      }
      jsSetSloppy(
        cachedOrders,
        resourceType,
        JSON.parse(JSON.stringify(getProp(runtimeData.market.orders, resourceType)) || '{}'),
      );
      const cached = getProp(cachedOrders, resourceType);
      for (const i in cached as object) {
        dividePrice(getProp(getProp(cachedOrders, resourceType), i));
      }
    }
    return getProp(cachedOrders, resourceType);
  }

  function mapTransactions(transactions: unknown): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    baseEach(transactions || [], (doc) => {
      const i: Record<string, unknown> = { ...(doc as object) };
      i.transactionId = jsConcat(i._id);
      delete i._id;
      i.sender = i.sender
        ? { username: getProp(getProp(runtimeData.users, i.sender as PropertyKey), 'username') }
        : undefined;
      i.recipient = i.recipient
        ? { username: getProp(getProp(runtimeData.users, i.recipient as PropertyKey), 'username') }
        : undefined;
      result.push(i);
      return true;
    });
    return result;
  }

  const market = {
    calcTransactionCost: wrapFn(function (
      amount: unknown,
      roomName1: unknown,
      roomName2: unknown,
    ): number {
      const distance = calcRoomsDistanceLoose(roomName1, roomName2, true, runtimeData.worldSize);
      // Boundary: upstream multiplies the untrusted amount natively inside calcTerminalEnergyCost.
      return calcTerminalEnergyCost(amount as number, distance);
    }),

    getAllOrders: wrapFn(function (filter?: unknown): unknown[] {
      const result = getOrders(filter && getProp(filter, 'resourceType'));
      return lodashFilter(result, filter);
    }),

    getHistory: wrapFn(function (resourceTypeArg?: unknown): unknown {
      // Boundary: keys are converted by each property access, like upstream `cachedHistory[resourceType]`.
      let resourceType = resourceTypeArg as PropertyKey;
      if (!resourceType) {
        resourceType = 'all';
      }

      if (!getProp(cachedHistory, resourceType)) {
        if (resourceType != 'all' && !isMarketResource(resourceType)) {
          return {};
        }
        jsSetSloppy(
          cachedHistory,
          resourceType,
          jsonClone(getProp(runtimeData.market.history, resourceType) || {}),
        );
      }
      return getProp(cachedHistory, resourceType);
    }),

    getOrderById: wrapFn(function (this: unknown, id: unknown): unknown {
      const self = sloppyThis(this);
      // Boundary: the key is converted by each property access.
      const key = id as PropertyKey;
      if (getProp(getProp(self, 'orders'), key)) {
        return jsonClone(getProp(getProp(self, 'orders'), key));
      }
      const order = getProp(runtimeData.market.orders.all, key);
      if (order) {
        const result = jsonClone(order);
        dividePrice(result);
        return result;
      }
      return null;
    }),

    createOrder: wrapFn(function (
      this: unknown,
      typeArg: unknown,
      resourceTypeArg?: unknown,
      priceArg?: unknown,
      totalAmountArg?: unknown,
      roomNameArg?: unknown,
    ): number {
      const self = sloppyThis(this);
      let type = typeArg;
      let resourceType = resourceTypeArg;
      let rawPrice = priceArg;
      let rawTotalAmount = totalAmountArg;
      let roomName = roomNameArg;
      if (isObject(typeArg)) {
        type = getProp(typeArg, 'type');
        resourceType = getProp(typeArg, 'resourceType');
        rawPrice = getProp(typeArg, 'price');
        rawTotalAmount = getProp(typeArg, 'totalAmount');
        roomName = getProp(typeArg, 'roomName');
      }
      if (!isMarketResource(resourceType)) {
        return C.ERR_INVALID_ARGS;
      }
      // Boundary: loose equality on the untrusted order type, like upstream.
      if (type != C.ORDER_BUY && type != C.ORDER_SELL) {
        return C.ERR_INVALID_ARGS;
      }
      // Boundary: parseFloat/parseInt apply ToString themselves.
      const price = parseFloat(rawPrice as string);
      const totalAmount = parseInt(rawTotalAmount as string);
      if (!price || price <= 0 || !totalAmount) {
        return C.ERR_INVALID_ARGS;
      }
      if (jsGt(price * totalAmount * C.MARKET_FEE, getProp(self, 'credits'))) {
        return C.ERR_NOT_ENOUGH_RESOURCES;
      }
      if (
        !contains(C.INTERSHARD_RESOURCES, resourceType) &&
        (!roomName || !lodashAny(runtimeData.userObjects, { type: 'terminal', room: roomName }))
      ) {
        return C.ERR_NOT_OWNER;
      }
      if (size(getProp(self, 'orders')) + ordersCreatedDuringTick >= C.MARKET_MAX_ORDERS) {
        return C.ERR_FULL;
      }
      ordersCreatedDuringTick++;
      intents.pushByName('global', 'createOrder', {
        type,
        resourceType,
        price,
        totalAmount,
        roomName,
      });
      return C.OK;
    }),

    cancelOrder: wrapFn(function (this: unknown, orderId: unknown): number {
      const self = sloppyThis(this);
      // Boundary: the key is converted by the property access.
      if (!getProp(getProp(self, 'orders'), orderId as PropertyKey)) {
        return C.ERR_INVALID_ARGS;
      }
      intents.pushByName('global', 'cancelOrder', { orderId }, 50);
      return C.OK;
    }),

    deal: wrapFn(function (
      this: unknown,
      orderId: unknown,
      amountArg: unknown,
      targetRoomName?: unknown,
    ): number {
      const self = sloppyThis(this);
      // Boundary: the key is converted by the property access.
      const order = getProp(runtimeData.market.orders.all, orderId as PropertyKey);
      if (!order) {
        return C.ERR_INVALID_ARGS;
      }
      // Boundary: parseInt applies ToString itself.
      const amount = parseInt(amountArg as string);
      if (!amount || amount < 0) {
        return C.ERR_INVALID_ARGS;
      }
      if (contains(C.INTERSHARD_RESOURCES, getProp(order, 'resourceType'))) {
        if (
          getProp(order, 'type') == C.ORDER_BUY &&
          jsLt(
            getProp(runtimeData.user.resources, getProp(order, 'resourceType') as PropertyKey) || 0,
            amount,
          )
        ) {
          return C.ERR_NOT_ENOUGH_RESOURCES;
        }
      } else {
        if (!targetRoomName) {
          return C.ERR_INVALID_ARGS;
        }
        const terminal = lodashFind(runtimeData.userObjects, {
            type: 'terminal',
            room: targetRoomName,
          }),
          transferCost = callMethod(self, 'calcTransactionCost', [
            amount,
            targetRoomName,
            getProp(order, 'roomName'),
          ]);
        if (!terminal) {
          return C.ERR_NOT_OWNER;
        }
        const store = getProp(terminal, 'store');
        if (!store || jsLt(getProp(store, C.RESOURCE_ENERGY), transferCost)) {
          return C.ERR_NOT_ENOUGH_RESOURCES;
        }
        if (jsGt(getProp(terminal, 'cooldownTime'), runtimeData.time)) {
          return C.ERR_TIRED;
        }
        if (getProp(order, 'type') == C.ORDER_BUY) {
          const resourceType = getProp(order, 'resourceType');
          if (
            (resourceType != C.RESOURCE_ENERGY &&
              (!getProp(store, resourceType as PropertyKey) ||
                jsLt(getProp(store, resourceType as PropertyKey), amount))) ||
            (resourceType == C.RESOURCE_ENERGY &&
              jsLt(getProp(store, C.RESOURCE_ENERGY), jsAdd(amount, transferCost)))
          ) {
            return C.ERR_NOT_ENOUGH_RESOURCES;
          }
        }
      }

      if (
        getProp(order, 'type') == C.ORDER_SELL &&
        jsLt(runtimeData.user.money || 0, jsMul(amount, getProp(order, 'price')))
      ) {
        return C.ERR_NOT_ENOUGH_RESOURCES;
      }

      if (!intents.pushByName('global', 'deal', { orderId, targetRoomName, amount }, 10)) {
        return C.ERR_FULL;
      }
      return C.OK;
    }),

    changeOrderPrice: wrapFn(function (
      this: unknown,
      orderId: unknown,
      newPriceArg: unknown,
    ): number {
      const self = sloppyThis(this);
      // Boundary: the key is converted by the property access.
      const order = getProp(getProp(self, 'orders'), orderId as PropertyKey);
      if (!order) {
        return C.ERR_INVALID_ARGS;
      }
      // Boundary: parseFloat applies ToString itself.
      const newPrice = parseFloat(newPriceArg as string);
      if (!newPrice || newPrice <= 0) {
        return C.ERR_INVALID_ARGS;
      }
      if (
        jsGt(newPrice, getProp(order, 'price')) &&
        jsGt(
          jsMul(
            jsMul(jsSub(newPrice, getProp(order, 'price')), getProp(order, 'remainingAmount')),
            C.MARKET_FEE,
          ),
          getProp(self, 'credits'),
        )
      ) {
        return C.ERR_NOT_ENOUGH_RESOURCES;
      }

      intents.pushByName(
        'global',
        'changeOrderPrice',
        {
          orderId,
          newPrice,
        },
        50,
      );
      return C.OK;
    }),

    extendOrder: wrapFn(function (this: unknown, orderId: unknown, addAmountArg: unknown): number {
      const self = sloppyThis(this);
      // Boundary: the key is converted by the property access.
      const order = getProp(getProp(self, 'orders'), orderId as PropertyKey);
      if (!order) {
        return C.ERR_INVALID_ARGS;
      }
      // Boundary: parseInt applies ToString itself.
      const addAmount = parseInt(addAmountArg as string);
      if (!addAmount || addAmount <= 0) {
        return C.ERR_INVALID_ARGS;
      }
      if (
        jsGt(
          jsMul(jsMul(getProp(order, 'price'), addAmount), C.MARKET_FEE),
          getProp(self, 'credits'),
        )
      ) {
        return C.ERR_NOT_ENOUGH_RESOURCES;
      }

      intents.pushByName(
        'global',
        'extendOrder',
        {
          orderId,
          addAmount,
        },
        50,
      );
      return C.OK;
    }),
  };

  Object.defineProperties(market, {
    credits: {
      enumerable: true,
      get(): number {
        return (runtimeData.user.money || 0) / 1000;
      },
    },

    incomingTransactions: {
      enumerable: true,
      get(): Record<string, unknown>[] {
        incomingTransactions ??= mapTransactions(runtimeData.transactions.incoming);
        return incomingTransactions;
      },
    },

    outgoingTransactions: {
      enumerable: true,
      get(): Record<string, unknown>[] {
        outgoingTransactions ??= mapTransactions(runtimeData.transactions.outgoing);
        return outgoingTransactions;
      },
    },

    orders: {
      enumerable: true,
      get(): Record<string, unknown> {
        if (!orders) {
          const mapped: unknown[] = [];
          baseEach(runtimeData.market.myOrders, (doc) => {
            const i: Record<string, unknown> = { ...(doc as object) };
            i.id = jsConcat(i._id);
            delete i._id;
            delete i.user;
            dividePrice(i);
            mapped.push(i);
            return true;
          });
          // `.indexBy('id')`
          const indexed: Record<string, unknown> = {};
          for (const value of mapped) {
            jsSetSloppy(indexed, getProp(value, 'id') as PropertyKey, value);
          }
          orders = indexed;
        }
        return orders;
      },
    },
  });

  // The accessors above complete the `GameMarket` shape (enumerable, non-configurable like upstream).
  return market as typeof market &
    Pick<GameMarket, 'credits' | 'incomingTransactions' | 'outgoingTransactions' | 'orders'>;
}
