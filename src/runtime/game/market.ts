/*
 * Game.market (screeps/engine `src/game/market.js`).
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../constants.ts';
import { calcRoomsDistance, calcTerminalEnergyCost } from '../../utils/index.ts';
import { contains, isObject, size } from './compat.ts';
import { readProperty, roomNameString } from './map.ts';
import type { MarketHistoryEntry, MarketOrder, RuntimeMarketOrder, TransactionDoc } from './runtime-data.ts';
import { scope } from './scope.ts';

/** A player's own order as exposed by `Game.market.orders` (price in credits). */
export interface GameMarketOwnOrder extends Omit<MarketOrder, '_id' | 'user'> {
    id: string;
}

export interface GameTransaction extends Omit<TransactionDoc, '_id' | 'sender' | 'recipient'> {
    transactionId: string;
    sender: { username: string } | undefined;
    recipient: { username: string } | undefined;
}

export interface GameMarket {
    readonly credits: number;
    readonly incomingTransactions: GameTransaction[];
    readonly outgoingTransactions: GameTransaction[];
    readonly orders: Record<string, GameMarketOwnOrder>;
    calcTransactionCost(amount: unknown, roomName1: unknown, roomName2: unknown): number;
    getAllOrders(filter?: unknown): RuntimeMarketOrder[];
    getHistory(resourceType?: unknown): MarketHistoryEntry[] | Record<string, never>;
    getOrderById(this: GameMarket, id: unknown): RuntimeMarketOrder | GameMarketOwnOrder | null;
    createOrder(
        this: GameMarket,
        type: unknown,
        resourceType?: unknown,
        price?: unknown,
        totalAmount?: unknown,
        roomName?: unknown,
    ): number;
    cancelOrder(this: GameMarket, orderId: unknown): number;
    deal(this: GameMarket, orderId: unknown, amount: unknown, targetRoomName?: unknown): number;
    changeOrderPrice(this: GameMarket, orderId: unknown, newPrice: unknown): number;
    extendOrder(this: GameMarket, orderId: unknown, addAmount: unknown): number;
}

// Per-tick state (upstream closure variables of `market.make`), reset by `make()`.
let ordersCreatedDuringTick = 0;
let cachedOrders: Record<string, Record<string, RuntimeMarketOrder>> = {};
let cachedHistory: Record<string, MarketHistoryEntry[] | Record<string, never>> = {};
let incomingTransactions: GameTransaction[] | undefined;
let outgoingTransactions: GameTransaction[] | undefined;
let ownOrders: Record<string, GameMarketOwnOrder> | undefined;

export function make(): void {
    ordersCreatedDuringTick = 0;
    cachedOrders = {};
    cachedHistory = {};
    incomingTransactions = undefined;
    outgoingTransactions = undefined;
    ownOrders = undefined;
}

function isMarketResource(resourceType: unknown): boolean {
    return contains(C.RESOURCES_ALL, resourceType) || contains(C.INTERSHARD_RESOURCES, resourceType);
}

/** JSON round trip of runtime data (`JSON.parse(JSON.stringify(value))`). */
function jsonClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function getOrders(resourceTypeArg: unknown): Record<string, RuntimeMarketOrder> {
    const resourceType = resourceTypeArg ? String(resourceTypeArg) : 'all';
    let orders = cachedOrders[resourceType];
    if (!orders) {
        if (resourceType != 'all' && !isMarketResource(resourceTypeArg)) {
            return {};
        }
        const source = scope().runtimeData.market.orders[resourceType];
        orders = source ? jsonClone(source) : {};
        for (const i in orders) {
            const order = orders[i];
            if (order) {
                order.price /= 1000;
            }
        }
        cachedOrders[resourceType] = orders;
    }
    return orders;
}

// lodash 3 `_.filter` callback semantics (`_.callback` without `thisArg`).

const rePropName = /[^.[\]]+|\[(?:(-?\d+(?:\.\d+)?)|(["'])((?:(?!\2)[^\n\\]|\\.)*?)\2)\]/g;
const reEscapeChar = /\\(\\)?/g;

function toPath(value: string): string[] {
    const result: string[] = [];
    value.replace(rePropName, (match: string, num: string | undefined, quote: string | undefined, str: string | undefined) => {
        result.push(quote ? (str ?? '').replace(reEscapeChar, '$1') : (num ?? match));
        return match;
    });
    return result;
}

function propertyMatcher(key: unknown): (value: unknown) => unknown {
    if (typeof key !== 'string' || !/[.[\]]/.test(key)) {
        const name = String(key);
        return (value) => (value == null ? undefined : readProperty(value, name));
    }
    const path = toPath(key);
    return (value) => {
        if (value == null) {
            return undefined;
        }
        const steps = key in Object(value) ? [key] : path;
        let current: unknown = value;
        for (const step of steps) {
            if (current == null) {
                return undefined;
            }
            current = readProperty(current, step);
        }
        return current;
    };
}

/** lodash 3 `baseIsEqual` with `isLoose` (partial) comparison for plain data. */
function isLooseEqual(source: unknown, other: unknown): boolean {
    if (source === other) {
        return true;
    }
    if (source == null || other == null || (!isObject(source) && !isObject(other))) {
        return source !== source && other !== other;
    }
    if (Array.isArray(source)) {
        if (!Array.isArray(other) || (source.length != other.length && !(other.length > source.length))) {
            return false;
        }
        return source.every((value: unknown) => other.some((otherValue: unknown) => isLooseEqual(value, otherValue)));
    }
    if (!isObject(source) || !isObject(other) || Array.isArray(other)) {
        return false;
    }
    if (Object.prototype.toString.call(source) !== Object.prototype.toString.call(other)) {
        return false;
    }
    for (const key of Object.keys(source)) {
        if (!(key in other) || !isLooseEqual(readProperty(source, key), readProperty(other, key))) {
            return false;
        }
    }
    return true;
}

function matchesMatcher(source: object): (value: unknown) => boolean {
    const keys = Object.keys(source);
    return (value) => {
        if (value == null) {
            return !keys.length;
        }
        const object: object = Object(value) as object;
        for (const key of keys) {
            const srcValue = readProperty(source, key);
            const objValue = readProperty(object, key);
            if (srcValue === srcValue && !isObject(srcValue)) {
                if (objValue !== srcValue || (srcValue === undefined && !(key in object))) {
                    return false;
                }
            } else if (!isLooseEqual(srcValue, objValue)) {
                return false;
            }
        }
        return true;
    };
}

function lodashFilter<T>(collection: Record<string, T>, predicate: unknown): T[] {
    let test: (value: T, key: string) => unknown;
    if (typeof predicate === 'function') {
        // Boundary: player predicate called like lodash `predicate(value, index, collection)`.
        const callback = predicate as (value: T, key: string, collection: Record<string, T>) => unknown;
        test = (value, key) => callback(value, key, collection);
    } else if (predicate == null) {
        test = (value) => value;
    } else if (isObject(predicate)) {
        test = matchesMatcher(predicate);
    } else {
        test = propertyMatcher(predicate);
    }
    const result: T[] = [];
    for (const key of Object.keys(collection)) {
        const value = collection[key];
        if (value !== undefined && test(value, key)) {
            result.push(value);
        }
    }
    return result;
}

function transactionUser(userId: string | undefined): { username: string } | undefined {
    if (!userId) {
        return undefined;
    }
    const user = scope().runtimeData.users[userId];
    if (!user) {
        throw new TypeError("Cannot read properties of undefined (reading 'username')");
    }
    return { username: user.username };
}

function mapTransactions(transactions: TransactionDoc[] | undefined): GameTransaction[] {
    return (transactions || []).map(({ _id, ...rest }) => ({
        ...rest,
        transactionId: String(_id),
        sender: transactionUser(rest.sender),
        recipient: transactionUser(rest.recipient),
    }));
}

export function makeMarket(): GameMarket {
    const { runtimeData, intents } = scope();

    const market = {
        calcTransactionCost(amount: unknown, roomName1: unknown, roomName2: unknown): number {
            const distance = calcRoomsDistance(roomNameString(roomName1), roomNameString(roomName2), true, runtimeData.worldSize);
            return calcTerminalEnergyCost(Number(amount), distance);
        },

        getAllOrders(filter?: unknown): RuntimeMarketOrder[] {
            const orders = getOrders(filter && readProperty(filter, 'resourceType'));
            return lodashFilter(orders, filter);
        },

        getHistory(resourceTypeArg?: unknown): MarketHistoryEntry[] | Record<string, never> {
            const resourceType = resourceTypeArg ? String(resourceTypeArg) : 'all';

            let history = cachedHistory[resourceType];
            if (!history) {
                if (resourceType != 'all' && !isMarketResource(resourceTypeArg)) {
                    return {};
                }
                history = jsonClone<MarketHistoryEntry[] | Record<string, never>>(runtimeData.market.history[resourceType] || {});
                cachedHistory[resourceType] = history;
            }
            return history;
        },

        getOrderById(this: GameMarket, id: unknown): RuntimeMarketOrder | GameMarketOwnOrder | null {
            const key = String(id);
            const own = this.orders[key];
            if (own) {
                return jsonClone(own);
            }
            const order = readProperty(runtimeData.market.orders.all, key) as RuntimeMarketOrder | undefined;
            if (order) {
                const result = jsonClone(order);
                result.price /= 1000;
                return result;
            }
            return null;
        },

        createOrder(
            this: GameMarket,
            typeArg: unknown,
            resourceTypeArg?: unknown,
            priceArg?: unknown,
            totalAmountArg?: unknown,
            roomNameArg?: unknown,
        ): number {
            let type = typeArg;
            let resourceType = resourceTypeArg;
            let rawPrice = priceArg;
            let rawTotalAmount = totalAmountArg;
            let roomName = roomNameArg;
            if (isObject(typeArg)) {
                type = readProperty(typeArg, 'type');
                resourceType = readProperty(typeArg, 'resourceType');
                rawPrice = readProperty(typeArg, 'price');
                rawTotalAmount = readProperty(typeArg, 'totalAmount');
                roomName = readProperty(typeArg, 'roomName');
            }
            if (!isMarketResource(resourceType)) {
                return C.ERR_INVALID_ARGS;
            }
            if (type != C.ORDER_BUY && type != C.ORDER_SELL) {
                return C.ERR_INVALID_ARGS;
            }
            const price = parseFloat(String(rawPrice));
            const totalAmount = parseInt(String(rawTotalAmount));
            if (!price || price <= 0 || !totalAmount) {
                return C.ERR_INVALID_ARGS;
            }
            if (price * totalAmount * C.MARKET_FEE > this.credits) {
                return C.ERR_NOT_ENOUGH_RESOURCES;
            }
            if (
                !contains(C.INTERSHARD_RESOURCES, resourceType) &&
                (!roomName || !Object.values(runtimeData.userObjects).some((i) => i.type === 'terminal' && i.room === roomName))
            ) {
                return C.ERR_NOT_OWNER;
            }
            if (size(this.orders) + ordersCreatedDuringTick >= C.MARKET_MAX_ORDERS) {
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
        },

        cancelOrder(this: GameMarket, orderId: unknown): number {
            if (!this.orders[String(orderId)]) {
                return C.ERR_INVALID_ARGS;
            }
            intents.pushByName('global', 'cancelOrder', { orderId }, 50);
            return C.OK;
        },

        deal(this: GameMarket, orderId: unknown, amountArg: unknown, targetRoomName?: unknown): number {
            const order = readProperty(runtimeData.market.orders.all, String(orderId)) as RuntimeMarketOrder | undefined;
            if (!order) {
                return C.ERR_INVALID_ARGS;
            }
            const amount = parseInt(String(amountArg));
            if (!amount || amount < 0) {
                return C.ERR_INVALID_ARGS;
            }
            if (contains(C.INTERSHARD_RESOURCES, order.resourceType)) {
                if (order.type == C.ORDER_BUY) {
                    const owned = Number(readProperty(runtimeData.user.resources, order.resourceType)) || 0;
                    if (owned < amount) {
                        return C.ERR_NOT_ENOUGH_RESOURCES;
                    }
                }
            } else {
                if (!targetRoomName) {
                    return C.ERR_INVALID_ARGS;
                }
                const terminal = Object.values(runtimeData.userObjects).find(
                        (i) => i.type === 'terminal' && i.room === targetRoomName,
                    ),
                    transferCost = this.calcTransactionCost(amount, targetRoomName, order.roomName);
                if (!terminal) {
                    return C.ERR_NOT_OWNER;
                }
                const store = terminal.store;
                // Comparisons with a missing amount are false in JS (`undefined < n`).
                const storedEnergy = store?.[C.RESOURCE_ENERGY] ?? NaN;
                if (!store || storedEnergy < transferCost) {
                    return C.ERR_NOT_ENOUGH_RESOURCES;
                }
                if ((terminal.cooldownTime ?? NaN) > runtimeData.time) {
                    return C.ERR_TIRED;
                }
                if (order.type == C.ORDER_BUY) {
                    const stored = store[order.resourceType];
                    if (
                        (order.resourceType != C.RESOURCE_ENERGY && (!stored || stored < amount)) ||
                        (order.resourceType == C.RESOURCE_ENERGY && storedEnergy < amount + transferCost)
                    ) {
                        return C.ERR_NOT_ENOUGH_RESOURCES;
                    }
                }
            }

            if (order.type == C.ORDER_SELL && (runtimeData.user.money || 0) < amount * order.price) {
                return C.ERR_NOT_ENOUGH_RESOURCES;
            }

            if (!intents.pushByName('global', 'deal', { orderId, targetRoomName, amount }, 10)) {
                return C.ERR_FULL;
            }
            return C.OK;
        },

        changeOrderPrice(this: GameMarket, orderId: unknown, newPriceArg: unknown): number {
            const order = this.orders[String(orderId)];
            if (!order) {
                return C.ERR_INVALID_ARGS;
            }
            const newPrice = parseFloat(String(newPriceArg));
            if (!newPrice || newPrice <= 0) {
                return C.ERR_INVALID_ARGS;
            }
            if (newPrice > order.price && (newPrice - order.price) * order.remainingAmount * C.MARKET_FEE > this.credits) {
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
        },

        extendOrder(this: GameMarket, orderId: unknown, addAmountArg: unknown): number {
            const order = this.orders[String(orderId)];
            if (!order) {
                return C.ERR_INVALID_ARGS;
            }
            const addAmount = parseInt(String(addAmountArg));
            if (!addAmount || addAmount <= 0) {
                return C.ERR_INVALID_ARGS;
            }
            if (order.price * addAmount * C.MARKET_FEE > this.credits) {
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
        },
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
            get(): GameTransaction[] {
                incomingTransactions ??= mapTransactions(runtimeData.transactions.incoming);
                return incomingTransactions;
            },
        },

        outgoingTransactions: {
            enumerable: true,
            get(): GameTransaction[] {
                outgoingTransactions ??= mapTransactions(runtimeData.transactions.outgoing);
                return outgoingTransactions;
            },
        },

        orders: {
            enumerable: true,
            get(): Record<string, GameMarketOwnOrder> {
                if (!ownOrders) {
                    const indexed: Record<string, GameMarketOwnOrder> = {};
                    for (const { _id, user: _user, ...rest } of runtimeData.market.myOrders) {
                        const order: GameMarketOwnOrder = { ...rest, price: rest.price / 1000, id: String(_id) };
                        indexed[order.id] = order;
                    }
                    ownOrders = indexed;
                }
                return ownOrders;
            },
        },
    });

    // The accessors above complete the `GameMarket` shape (enumerable, non-configurable like upstream).
    return market as typeof market & Pick<GameMarket, 'credits' | 'incomingTransactions' | 'outgoingTransactions' | 'orders'>;
}
