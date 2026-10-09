// Port of screeps/engine `processor/global-intents/market.js`. Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).

import * as C from '../../constants.ts';
import { calcResources, calcRoomsDistance, calcTerminalEnergyCost } from '../../utils/index.ts';
import type { Bulk } from '../bulk.ts';
import type { GlobalScope, IntentArgs } from '../scope.ts';
import type { Effect, MarketOrder, RoomObject, Store, TransactionDoc, UserDoc } from '../state.ts';
import { contains, shuffle } from '../support.ts';

type DealIntent = IntentArgs<'deal'> & { user?: string };
type TransactionExtra = Partial<Pick<TransactionDoc, 'description' | 'order'>>;
/** Upstream guards `userIntents`/`orders` against absence, so they are optional here. */
type MarketScope = Omit<GlobalScope, 'userIntents' | 'orders'> & {
  userIntents?: GlobalScope['userIntents'] | undefined;
  orders?: GlobalScope['orders'] | undefined;
};

function findOperateTerminal(effects: Effect[] | null | undefined): Effect | undefined {
  return effects ? effects.find((e) => e.power === C.PWR_OPERATE_TERMINAL) : undefined;
}

function operateTerminalRatio(effect: Effect): number {
  return C.POWER_INFO[C.PWR_OPERATE_TERMINAL].effect[(effect.level as number) - 1] as number;
}

function isIntershard(resourceType: unknown): boolean {
  return contains(C.INTERSHARD_RESOURCES, resourceType);
}

function indexBy<T>(list: readonly T[] | undefined, key: (item: T) => unknown): Record<string, T> {
  const result: Record<string, T> = {};
  if (list) {
    for (const item of list) {
      result[String(key(item))] = item;
    }
  }
  return result;
}

export function processMarketIntents(scope: MarketScope): void {
  const {
    orders,
    userIntents,
    usersById,
    gameTime,
    roomObjectsByType,
    bulkObjects,
    bulkUsers,
    bulkTransactions,
    bulkUsersMoney,
    bulkUsersResources,
    bulkMarketOrders,
    bulkMarketIntershardOrders,
    env,
  } = scope;

  const terminals = roomObjectsByType.terminal;
  const terminalsByRoom = indexBy(terminals, (t) => t.room);
  const distance = (a: string | undefined, b: string | undefined): number =>
    calcRoomsDistance(a as string, b as string, true, env.worldSize);
  const ordersBulk = (resourceType: unknown): Bulk<MarketOrder> =>
    isIntershard(resourceType) ? bulkMarketIntershardOrders : bulkMarketOrders;

  function executeTransfer(
    fromTerminal: RoomObject | undefined,
    toTerminal: RoomObject | undefined,
    resourceType: string,
    amountArg: number,
    transferFeeTerminal: RoomObject | undefined,
    additionalFields: TransactionExtra,
  ): boolean {
    let amount = amountArg;
    if (!fromTerminal || !toTerminal || !transferFeeTerminal) {
      return false;
    }
    if (
      fromTerminal.user &&
      (!fromTerminal.store ||
        !fromTerminal.store[resourceType] ||
        fromTerminal.store[resourceType] < amount)
    ) {
      return false;
    }
    if (toTerminal.user) {
      const targetResourceTotal = calcResources(toTerminal);
      const freeSpace = Math.max(0, (toTerminal.storeCapacity as number) - targetResourceTotal);
      amount = Math.min(amount, freeSpace);
    }
    if (!(amount > 0)) {
      return false;
    }

    const range = distance(fromTerminal.room, toTerminal.room);
    let transferCost = calcTerminalEnergyCost(amount, range);

    const effect = findOperateTerminal(transferFeeTerminal.effects);
    if (effect && effect.endTime > gameTime) {
      transferCost = Math.ceil(transferCost * operateTerminalRatio(effect));
    }

    const fromStore = fromTerminal.store as Store;
    const toStore = toTerminal.store as Store;
    if (
      (transferFeeTerminal === fromTerminal &&
        ((resourceType != C.RESOURCE_ENERGY && (fromStore.energy as number) < transferCost) ||
          (resourceType == C.RESOURCE_ENERGY &&
            (fromStore.energy as number) < amount + transferCost))) ||
      (transferFeeTerminal === toTerminal && (toStore.energy as number) < transferCost)
    ) {
      return false;
    }

    if (toTerminal.user) {
      toTerminal.store = toTerminal.store || {};
      toTerminal.store[resourceType] = (toTerminal.store[resourceType] || 0) + amount;
      bulkObjects.update(toTerminal, { store: { [resourceType]: toTerminal.store[resourceType] } });
    }

    bulkObjects.update(fromTerminal, {
      store: { [resourceType]: ((fromTerminal.store as Store)[resourceType] as number) - amount },
    });
    bulkObjects.update(transferFeeTerminal, {
      store: { energy: ((transferFeeTerminal.store as Store).energy as number) - transferCost },
    });

    const transaction: Omit<TransactionDoc, '_id'> = {
      time: gameTime,
      sender: fromTerminal.user ? fromTerminal.user : undefined,
      recipient: toTerminal.user ? toTerminal.user : undefined,
      resourceType,
      amount,
      from: fromTerminal.room,
      to: toTerminal.room,
    };
    bulkTransactions.insert(Object.assign(transaction, additionalFields));

    return true;
  }

  (terminals ?? [])
    .filter((i) => !!i.send)
    .forEach((terminal) => {
      const intent = terminal.send as NonNullable<RoomObject['send']>;

      bulkObjects.update(terminal, { send: null });

      if ((terminal.cooldownTime as number) > gameTime) {
        return;
      }
      const target = terminalsByRoom[intent.targetRoomName];
      if (!target || !target.user) {
        return;
      }

      let cooldown: number = C.TERMINAL_COOLDOWN;
      const effect = findOperateTerminal(terminal.effects);
      if (effect && effect.endTime > gameTime) {
        cooldown = Math.round(cooldown * operateTerminalRatio(effect));
      }

      if (
        executeTransfer(terminal, target, intent.resourceType, intent.amount, terminal, {
          description: intent.description ? intent.description.replace(/</g, '&lt;') : undefined,
        })
      ) {
        bulkObjects.update(terminal, { cooldownTime: gameTime + cooldown });
      }
    });

  const ordersById = indexBy(orders, (o) => o._id);
  const terminalDeals: DealIntent[] = [];
  let directDeals: DealIntent[] = [];

  const nowTimestamp = env.now();

  if (userIntents) {
    userIntents.forEach((iUserIntents) => {
      const user = usersById[iUserIntents.user] as UserDoc;

      const createOrder = iUserIntents.intents.createOrder;
      if (createOrder) {
        createOrder.forEach((intent) => {
          if (!intent.price || !intent.totalAmount) {
            return;
          }
          if (
            !contains(C.RESOURCES_ALL, intent.resourceType) &&
            !isIntershard(intent.resourceType)
          ) {
            return;
          }
          if (
            !isIntershard(intent.resourceType) &&
            (!terminalsByRoom[intent.roomName as string] ||
              terminalsByRoom[intent.roomName as string]?.user != iUserIntents.user)
          ) {
            return;
          }
          if (intent.price <= 0 || intent.totalAmount <= 0) {
            return;
          }

          const fee = Math.ceil(intent.price * intent.totalAmount * C.MARKET_FEE);

          if ((user.money as number) < fee) {
            return;
          }

          bulkUsers.inc(user, 'money', -fee);

          // `_.extend(defaults, intent)`: intent keys (sanitizer order) overwrite defaults,
          // including the raw `intent.type` over the normalized one.
          const order: Omit<MarketOrder, '_id'> = {
            createdTimestamp: nowTimestamp,
            user: iUserIntents.user,
            active: false,
            type: intent.type == C.ORDER_SELL ? C.ORDER_SELL : C.ORDER_BUY,
            amount: 0,
            remainingAmount: intent.totalAmount,
            resourceType: intent.resourceType as string,
            price: intent.price,
          };
          if ('type' in intent) {
            order.type = intent.type as string;
          }
          if ('totalAmount' in intent) {
            order.totalAmount = intent.totalAmount;
          }
          if ('roomName' in intent) {
            order.roomName = intent.roomName as string;
          }

          let bulk = bulkMarketIntershardOrders;
          if (!isIntershard(intent.resourceType)) {
            bulk = bulkMarketOrders;
            order.created = gameTime;
          }

          bulk.insert(order);

          intent.price /= 1000;

          bulkUsersMoney.insert({
            date: env.now(),
            tick: gameTime,
            user: iUserIntents.user,
            type: 'market.fee',
            balance: (user.money as number) / 1000,
            change: -fee / 1000,
            market: {
              order: intent,
            },
          });
        });
      }

      const changeOrderPrice = iUserIntents.intents.changeOrderPrice;
      if (changeOrderPrice) {
        changeOrderPrice.forEach((intent) => {
          const order = ordersById[intent.orderId as string];
          if (!order || order.user != iUserIntents.user) {
            return;
          }

          if (!intent.newPrice || intent.newPrice <= 0) {
            return;
          }

          if (intent.newPrice != order.price) {
            order._skip = true;
          }

          if (intent.newPrice > order.price) {
            const fee = Math.ceil(
              (intent.newPrice - order.price) * order.remainingAmount * C.MARKET_FEE,
            );

            if ((user.money as number) < fee) {
              return;
            }

            bulkUsers.inc(user, 'money', -fee);

            bulkUsersMoney.insert({
              date: env.now(),
              tick: gameTime,
              user: iUserIntents.user,
              type: 'market.fee',
              balance: (user.money as number) / 1000,
              change: -fee / 1000,
              market: {
                changeOrderPrice: {
                  orderId: intent.orderId as string,
                  oldPrice: order.price / 1000,
                  newPrice: intent.newPrice / 1000,
                },
              },
            });
          }

          ordersBulk(order.resourceType).inc(order, 'price', intent.newPrice - order.price);
        });
      }

      const extendOrder = iUserIntents.intents.extendOrder;
      if (extendOrder) {
        extendOrder.forEach((intent) => {
          const order = ordersById[intent.orderId as string];
          if (!order || order.user != iUserIntents.user) {
            return;
          }
          if (!intent.addAmount || intent.addAmount <= 0) {
            return;
          }

          const fee = Math.ceil(order.price * intent.addAmount * C.MARKET_FEE);

          if ((user.money as number) < fee) {
            return;
          }

          bulkUsers.inc(user, 'money', -fee);

          bulkUsersMoney.insert({
            date: env.now(),
            tick: gameTime,
            user: iUserIntents.user,
            type: 'market.fee',
            balance: (user.money as number) / 1000,
            change: -fee / 1000,
            market: {
              extendOrder: {
                orderId: intent.orderId as string,
                addAmount: intent.addAmount,
              },
            },
          });

          const bulk = ordersBulk(order.resourceType);
          bulk.inc(order, 'remainingAmount', intent.addAmount);
          bulk.inc(order, 'totalAmount', intent.addAmount);
        });
      }

      const cancelOrder = iUserIntents.intents.cancelOrder;
      if (cancelOrder) {
        cancelOrder.forEach((intent) => {
          const order = ordersById[intent.orderId as string];
          if (order && order.user == iUserIntents.user) {
            order.remainingAmount = 0;
            order._cancelled = true;
          }
        });
      }

      const deal = iUserIntents.intents.deal;
      if (deal) {
        deal.forEach((dealIntent) => {
          const intent: DealIntent = dealIntent;
          intent.user = iUserIntents.user;

          const order = ordersById[intent.orderId as string];
          if (!order || order._skip) {
            return;
          }
          if ((intent.amount as number) <= 0) {
            return;
          }
          if (isIntershard(order.resourceType)) {
            directDeals.push(intent);
            return;
          }
          const target = terminalsByRoom[intent.targetRoomName as string];
          if (!target || target.user != iUserIntents.user) {
            return;
          }

          terminalDeals.push(intent);
        });
      }
    });
  }

  const dealOrder = (deal: DealIntent): MarketOrder =>
    ordersById[deal.orderId as string] as MarketOrder;

  terminalDeals.sort(
    (a, b) =>
      distance(a.targetRoomName, dealOrder(a).roomName) -
      distance(b.targetRoomName, dealOrder(b).roomName),
  );

  terminalDeals.forEach((deal) => {
    const order = dealOrder(deal);
    const orderTerminal = terminalsByRoom[order.roomName as string];
    const targetTerminal = terminalsByRoom[deal.targetRoomName as string];
    let buyer: RoomObject;
    let seller: RoomObject;

    if (!orderTerminal || !targetTerminal) {
      return;
    }
    if ((targetTerminal.cooldownTime as number) > gameTime) {
      return;
    }
    orderTerminal.store = orderTerminal.store || {};
    targetTerminal.store = targetTerminal.store || {};

    if (order.type == C.ORDER_SELL) {
      buyer = targetTerminal;
      seller = orderTerminal;
    } else {
      seller = targetTerminal;
      buyer = orderTerminal;
    }

    let amount = Math.min(deal.amount as number, order.remainingAmount);
    if (seller.user) {
      amount = Math.min(amount, (seller.store as Store)[order.resourceType] || 0);
    }
    if (buyer.user) {
      const targetResourceTotal = calcResources(buyer);
      const targetFreeSpace = Math.max(0, (buyer.storeCapacity as number) - targetResourceTotal);
      amount = Math.min(amount, targetFreeSpace);
    }
    if (!(amount > 0)) {
      return;
    }

    let dealCost = amount * order.price;

    if (buyer.user) {
      dealCost = Math.min(dealCost, (usersById[buyer.user] as UserDoc).money || 0);
      amount = Math.floor(dealCost / order.price);
      dealCost = amount * order.price;
      if (!amount) {
        return;
      }
    }

    if (
      executeTransfer(seller, buyer, order.resourceType, amount, targetTerminal, {
        order: {
          id: order._id,
          type: order.type,
          price: order.price / 1000,
        },
      })
    ) {
      if (seller.user) {
        const sellerUser = usersById[seller.user] as UserDoc;
        bulkUsers.inc(sellerUser, 'money', dealCost);
        bulkUsersMoney.insert({
          date: env.now(),
          tick: gameTime,
          user: seller.user,
          type: 'market.sell',
          balance: (sellerUser.money as number) / 1000,
          change: dealCost / 1000,
          market: {
            resourceType: order.resourceType,
            roomName: order.roomName as string,
            targetRoomName: deal.targetRoomName as string,
            price: order.price / 1000,
            npc: !buyer.user,
            owner: order.user as string,
            dealer: deal.user as string,
            amount,
          },
        });
      }
      if (buyer.user) {
        const buyerUser = usersById[buyer.user] as UserDoc;
        bulkUsers.inc(buyerUser, 'money', -dealCost);
        bulkUsersMoney.insert({
          date: env.now(),
          tick: gameTime,
          user: buyer.user,
          type: 'market.buy',
          balance: (buyerUser.money as number) / 1000,
          change: -dealCost / 1000,
          market: {
            resourceType: order.resourceType,
            roomName: order.roomName as string,
            targetRoomName: deal.targetRoomName as string,
            price: order.price / 1000,
            npc: !seller.user,
            owner: order.user as string,
            dealer: deal.user as string,
            amount,
          },
        });
      }
      bulkMarketOrders.update(order, {
        amount: order.amount - amount,
        remainingAmount: order.remainingAmount - amount,
      });
      let cooldown: number = C.TERMINAL_COOLDOWN;
      const effect = findOperateTerminal(targetTerminal.effects);
      if (effect && effect.endTime > gameTime) {
        cooldown = Math.round(cooldown * operateTerminalRatio(effect));
      }
      bulkObjects.update(targetTerminal, { cooldownTime: gameTime + cooldown });
    }
  });

  directDeals = shuffle(directDeals, () => env.random());

  directDeals.forEach((deal) => {
    const order = dealOrder(deal);
    let buyer: UserDoc | undefined;
    let seller: UserDoc | undefined;

    if (order.type == C.ORDER_SELL) {
      buyer = usersById[deal.user as string];
      seller = usersById[order.user as string];
    } else {
      seller = usersById[deal.user as string];
      buyer = usersById[order.user as string];
    }

    if (!seller || !buyer) {
      return;
    }

    seller.resources = seller.resources || {};
    buyer.resources = buyer.resources || {};

    const amount = Math.min(
      deal.amount as number,
      order.amount,
      order.remainingAmount,
      seller.resources[order.resourceType] || 0,
    );
    if (!amount || amount < 0) {
      return;
    }

    const dealCost = amount * order.price;

    // Upstream checks `buyer.user`, which a users document never has, so this guard is inert.
    const buyerRecord = buyer as UserDoc & { user?: unknown };
    if (buyerRecord.user && (!buyer.money || buyer.money < dealCost)) {
      return;
    }

    const resourceKey = `resources.${order.resourceType}` as const;

    bulkUsers.inc(seller, 'money', dealCost);
    bulkUsers.inc(seller, resourceKey, -amount);
    seller.resources[order.resourceType] =
      (seller.resources[order.resourceType] as number) - amount;

    bulkUsersMoney.insert({
      date: env.now(),
      tick: gameTime,
      user: seller._id,
      type: 'market.sell',
      balance: (seller.money as number) / 1000,
      change: dealCost / 1000,
      market: {
        resourceType: order.resourceType,
        price: order.price / 1000,
        amount,
      },
    });
    bulkUsersResources.insert({
      date: env.now(),
      resourceType: order.resourceType,
      user: seller._id,
      change: -amount,
      balance: seller.resources[order.resourceType] as number,
      marketOrderId: order._id,
      market: {
        orderId: order._id,
        anotherUser: buyer._id,
      },
    });

    bulkUsers.inc(buyer, 'money', -dealCost);
    bulkUsers.inc(buyer, resourceKey, amount);
    buyer.money = (buyer.money as number) - dealCost;

    bulkUsersMoney.insert({
      date: env.now(),
      tick: gameTime,
      user: buyer._id,
      type: 'market.buy',
      balance: buyer.money / 1000,
      change: -dealCost / 1000,
      market: {
        resourceType: order.resourceType,
        price: order.price / 1000,
        amount,
      },
    });
    const bulk = ordersBulk(order.resourceType);
    bulk.inc(order, 'amount', -amount);
    bulk.inc(order, 'remainingAmount', -amount);
    bulkUsersResources.insert({
      date: env.now(),
      resourceType: order.resourceType,
      user: buyer._id,
      change: amount,
      balance: buyer.resources[order.resourceType] as number,
      market: {
        orderId: order._id,
        anotherUser: seller._id,
      },
    });
  });

  if (orders) {
    orders.forEach((order) => {
      const bulk = ordersBulk(order.resourceType);

      if (order._cancelled) {
        bulk.remove(order._id);
        return;
      }

      if (
        order.user &&
        nowTimestamp - (order.createdTimestamp as number) > C.MARKET_ORDER_LIFE_TIME
      ) {
        const remainingFee = order.remainingAmount * order.price * C.MARKET_FEE;
        if (remainingFee > 0) {
          const user = usersById[order.user] as UserDoc;
          bulkUsers.inc(user, 'money', remainingFee);
          bulkUsersMoney.insert({
            date: env.now(),
            tick: gameTime,
            user: user._id,
            type: 'market.fee',
            balance: (user.money as number) / 1000,
            change: remainingFee / 1000,
            market: {
              order: {
                orderId: order._id,
                type: order.type,
                resourceType: order.resourceType,
                price: order.price / 1000,
                remainingAmount: order.remainingAmount,
                roomName: order.roomName,
              },
            },
          });
        }

        bulk.remove(order._id);
        return;
      }

      if (!order.user) {
        return;
      }

      const terminal = terminalsByRoom[order.roomName as string];

      if (order.type == C.ORDER_SELL) {
        let availableResourceAmount = isIntershard(order.resourceType)
          ? ((usersById[order.user] as UserDoc).resources || {})[order.resourceType] || 0
          : terminal && terminal.user == order.user
            ? (terminal.store as Store)[order.resourceType] || 0
            : 0;

        availableResourceAmount = Math.min(availableResourceAmount, order.remainingAmount);

        if (order.active) {
          if (!availableResourceAmount || availableResourceAmount < 0) {
            bulk.update(order, { active: false, amount: 0 });
            return;
          }
          if (order.amount != availableResourceAmount) {
            bulk.update(order, { amount: availableResourceAmount });
          }
        } else {
          if (availableResourceAmount > 0) {
            bulk.update(order, {
              active: true,
              amount: availableResourceAmount,
            });
          }
        }
      }

      if (order.type == C.ORDER_BUY) {
        const user = usersById[order.user] as UserDoc;
        const userMoney = user.money || 0;
        const isOwner =
          isIntershard(order.resourceType) || (!!terminal && terminal.user == order.user);

        let newAmount = Math.min(Math.floor(userMoney / order.price), order.remainingAmount);
        if (terminal && terminal.user) {
          const targetResourceTotal = calcResources(terminal);
          const targetFreeSpace = Math.max(
            0,
            (terminal.storeCapacity as number) - targetResourceTotal,
          );
          newAmount = Math.min(newAmount, targetFreeSpace);
        }

        const newActive = isOwner && newAmount > 0;

        if (order.amount != newAmount || order.active != newActive) {
          bulk.update(order, { amount: newAmount, active: newActive });
        }
      }
    });
  }
}
