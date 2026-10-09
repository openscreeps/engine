/*
 * Builds per-user runtime data from the world state (screeps/driver `lib/runtime/data.js`, plus the
 * accessible-room and room-status lists maintained by driver `index.js`).
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type {
  FlagDoc,
  MarketOrder,
  PowerCreepDoc,
  TransactionDoc,
  WorldState,
} from '../../simulation/state.ts';
import { calcWorldSize } from '../../utils/index.ts';
import type {
  CodeModules,
  ConsoleCommand,
  ForeignMemorySegment,
  RawRoomObject,
  RoomInfo,
  RoomStatusData,
  RuntimeAccountData,
  RuntimeData,
  CustomObjectPrototype,
  MarketHistoryEntry,
  RuntimeMarketOrder,
  RuntimeUser,
  RuntimeUserInfo,
} from '../game/runtime-data.ts';

/** World-wide lookups shared by every player run of one tick. */
export interface WorldIndex {
  objectsByUser: Record<string, RawRoomObject[]>;
  objectsByRoom: Record<string, RawRoomObject[]>;
  flagsByUser: Record<string, FlagDoc[]>;
  powerCreepsByUser: Record<string, PowerCreepDoc[]>;
  ordersByUser: Record<string, MarketOrder[]>;
  transactionsBySender: Record<string, TransactionDoc[]>;
  transactionsByRecipient: Record<string, TransactionDoc[]>;
  activeOrders: Record<string, Record<string, RuntimeMarketOrder>>;
  /** `market.stats` grouped by resource type plus `all` (driver `getCachedMarketHistory`). */
  marketHistory: Record<string, MarketHistoryEntry[]>;
  accessibleRooms: string;
  roomStatusData: RoomStatusData;
  worldSize: number;
}

function push<T>(index: Record<string, T[]>, key: string, value: T): void {
  (index[key] ??= []).push(value);
}

function latestTransactions(index: Record<string, TransactionDoc[]>): void {
  for (const [key, list] of Object.entries(index)) {
    index[key] = list.sort((a, b) => b.time - a.time).slice(0, 100);
  }
}

export function buildWorldIndex(world: Readonly<WorldState>, now: number): WorldIndex {
  const objectsByUser: Record<string, RawRoomObject[]> = {};
  const objectsByRoom: Record<string, RawRoomObject[]> = {};
  for (const object of Object.values(world.roomObjects)) {
    if (object.user) {
      push(objectsByUser, object.user, object);
    }
    push(objectsByRoom, object.room, object);
  }

  const flagsByUser: Record<string, FlagDoc[]> = {};
  for (const flag of Object.values(world.flags)) {
    push(flagsByUser, flag.user, flag);
  }

  const powerCreepsByUser: Record<string, PowerCreepDoc[]> = {};
  for (const powerCreep of Object.values(world.userPowerCreeps)) {
    push(powerCreepsByUser, powerCreep.user, powerCreep);
  }

  const ordersByUser: Record<string, MarketOrder[]> = {};
  const allOrders: Record<string, RuntimeMarketOrder> = {};
  const activeOrders: Record<string, Record<string, RuntimeMarketOrder>> = { all: allOrders };
  for (const order of Object.values(world.marketOrders)) {
    if (order.user) {
      push(ordersByUser, order.user, order);
    }
    if (order.active) {
      const { _id, ...rest } = order;
      const view: RuntimeMarketOrder = { ...rest, id: _id };
      (activeOrders[order.resourceType] ??= {})[view.id] = view;
      allOrders[view.id] = view;
    }
  }

  const transactionsBySender: Record<string, TransactionDoc[]> = {};
  const transactionsByRecipient: Record<string, TransactionDoc[]> = {};
  for (const transaction of Object.values(world.transactions)) {
    if (transaction.sender) {
      push(transactionsBySender, transaction.sender, transaction);
    }
    if (transaction.recipient) {
      push(transactionsByRecipient, transaction.recipient, transaction);
    }
  }
  latestTransactions(transactionsBySender);
  latestTransactions(transactionsByRecipient);

  const allHistory: MarketHistoryEntry[] = [];
  const marketHistory: Record<string, MarketHistoryEntry[]> = { all: allHistory };
  for (const stats of Object.values(world.marketStats)) {
    // Driver `getCachedMarketHistory` deletes `_id` and keeps every other field.
    const entry: MarketHistoryEntry & { _id?: string } = { ...stats };
    delete entry._id;
    (marketHistory[entry.resourceType] ??= []).push(entry);
    allHistory.push(entry);
  }

  const rooms = Object.values(world.rooms);
  const accessible = rooms
    .filter((room) => room.status == 'normal' && (!room.openTime || room.openTime < now))
    .map((room) => room._id);

  const roomStatusData: RoomStatusData = { novice: {}, respawn: {}, closed: {} };
  for (const room of rooms) {
    if (room.novice && room.novice > now) {
      roomStatusData.novice[room._id] = room.novice;
    } else if (room.respawnArea && room.respawnArea > now) {
      roomStatusData.respawn[room._id] = room.respawnArea;
    } else if (room.openTime && room.openTime > now) {
      roomStatusData.closed[room._id] = room.openTime;
    } else if (room.status == 'out of borders') {
      // Upstream stores `Infinity`, which JSON turns into `null`.
      roomStatusData.closed[room._id] = null;
    }
  }

  return {
    objectsByUser,
    objectsByRoom,
    flagsByUser,
    powerCreepsByUser,
    ordersByUser,
    transactionsBySender,
    transactionsByRecipient,
    activeOrders,
    marketHistory,
    accessibleRooms: JSON.stringify(accessible),
    roomStatusData,
    worldSize: calcWorldSize(rooms),
  };
}

/** Foreign segment selection persisted per user (`users.activeForeignSegment`). */
export interface ForeignSegmentSelection {
  username: string;
  userId?: string;
  id?: number;
}

/** Runtime-owned per-user state consumed when building runtime data. */
export interface UserRuntimeInput {
  modules: CodeModules;
  codeTimestamp: number;
  memory: string;
  consoleCommands: ConsoleCommand[];
  activeSegments: number[];
  segments: Record<number, string>;
  activeForeignSegment: ForeignSegmentSelection | undefined;
  customObjectPrototypes: CustomObjectPrototype[];
  account: RuntimeAccountData;
}

/** Another user's published segments, for foreign segment reads. */
export type PublicSegmentLookup = (
  userId: string,
) => { publicSegments: string | undefined; segments: Record<number, string> } | undefined;

function unescapeModuleName(key: string): string {
  return key
    .replace(/\$DOT\$/g, '.')
    .replace(/\$SLASH\$/g, '/')
    .replace(/\$BACKSLASH\$/g, '\\');
}

function userInfo(world: Readonly<WorldState>, userId: string): RuntimeUserInfo | undefined {
  const user = world.users[userId];
  if (!user) {
    return undefined;
  }
  const info: RuntimeUserInfo = { _id: user._id, username: user.username ?? '' };
  if (user.badge !== undefined) {
    info.badge = user.badge;
  }
  return info;
}

/**
 * Per-user runtime data, or `undefined` when the user owns no objects (upstream marks such users
 * inactive and skips them). `cpu`/`cpuBucket` are supplied by the caller.
 */
export function buildRuntimeData(
  world: Readonly<WorldState>,
  index: WorldIndex,
  userId: string,
  input: UserRuntimeInput,
  cpu: number,
  cpuBucket: number,
  publicSegments: PublicSegmentLookup,
): RuntimeData | undefined {
  const ownObjects = index.objectsByUser[userId];
  const userDoc = world.users[userId];
  if (!ownObjects?.length || !userDoc) {
    return undefined;
  }

  const userIdsHash: Record<string, true> = { [userId]: true };
  const roomIdsHash: Record<string, true> = {};
  const userObjects: Record<string, RawRoomObject> = {};
  for (const object of ownObjects) {
    userObjects[object._id] = object;
    if (object.type == 'flag' || object.type == 'constructionSite') {
      continue;
    }
    roomIdsHash[object.room] = true;
    if (object.type == 'observer' && object.observeRoom) {
      roomIdsHash[object.observeRoom] = true;
    }
    if (object.type == 'controller' && object.sign) {
      userIdsHash[object.sign.user] = true;
    }
  }
  const roomIds = Object.keys(roomIdsHash);

  const rooms: Record<string, RoomInfo> = {};
  const roomObjects: Record<string, RawRoomObject> = {};
  const roomEventLog: Record<string, string | undefined> = {};
  for (const roomName of roomIds) {
    const room = world.rooms[roomName];
    if (room) {
      rooms[roomName] = room;
    }
    for (const object of index.objectsByRoom[roomName] ?? []) {
      if (object.user == userId) {
        continue;
      }
      roomObjects[object._id] = object;
      if (object.user) {
        userIdsHash[object.user] = true;
      }
      if (object.type == 'controller' && object.reservation) {
        userIdsHash[object.reservation.user] = true;
      }
      if (object.type == 'controller' && object.sign) {
        userIdsHash[object.sign.user] = true;
      }
    }
    const log = world.roomEventLogs[roomName];
    roomEventLog[roomName] = log === undefined ? undefined : JSON.stringify(log);
  }
  Object.assign(roomObjects, userObjects);

  const outgoing = index.transactionsBySender[userId] ?? [];
  const incoming = index.transactionsByRecipient[userId] ?? [];
  for (const transaction of outgoing) {
    if (transaction.recipient) {
      userIdsHash[transaction.recipient] = true;
    }
  }
  for (const transaction of incoming) {
    if (transaction.sender) {
      userIdsHash[transaction.sender] = true;
    }
  }

  const users: Record<string, RuntimeUserInfo> = {};
  for (const id of Object.keys(userIdsHash)) {
    const info = userInfo(world, id);
    if (info) {
      users[id] = info;
    }
  }

  const userCode: CodeModules = {};
  for (const [key, module] of Object.entries(input.modules)) {
    userCode[unescapeModuleName(key)] = module;
  }

  const userPowerCreeps: Record<string, PowerCreepDoc> = {};
  for (const powerCreep of index.powerCreepsByUser[userId] ?? []) {
    userPowerCreeps[powerCreep._id] = powerCreep;
  }

  const user: RuntimeUser = {
    ...userDoc,
    username: userDoc.username ?? '',
    rooms: userDoc.rooms ?? [],
  };

  const data: RuntimeData = {
    userObjects,
    user,
    userCode,
    userCodeTimestamp: input.codeTimestamp,
    userMemory: { data: input.memory, userId },
    consoleCommands: input.consoleCommands,
    time: world.gameTime,
    rooms,
    roomObjects,
    flags: index.flagsByUser[userId] ?? [],
    accessibleRooms: index.accessibleRooms,
    roomStatusData: index.roomStatusData,
    transactions: { outgoing, incoming },
    cpu,
    cpuBucket,
    roomEventLog,
    userPowerCreeps,
    users,
    market: {
      orders: index.activeOrders,
      history: index.marketHistory,
      myOrders: index.ordersByUser[userId] ?? [],
    },
    shardName: world.shardName,
    worldSize: index.worldSize,
    customObjectPrototypes: input.customObjectPrototypes,
    account: input.account,
  };

  if (input.activeSegments.length > 0) {
    const memorySegments: Record<number, string> = {};
    for (const id of input.activeSegments) {
      memorySegments[id] = input.segments[id] ?? '';
    }
    data.memorySegments = memorySegments;
  }

  const foreign = input.activeForeignSegment;
  if (foreign?.userId !== undefined && foreign.id !== undefined) {
    const published = publicSegments(foreign.userId);
    if (published?.publicSegments?.split(',').includes(String(foreign.id))) {
      const segment: ForeignMemorySegment = {
        username: foreign.username,
        id: foreign.id,
        data: published.segments[foreign.id] ?? null,
      };
      data.foreignMemorySegment = segment;
    }
  }

  return data;
}
