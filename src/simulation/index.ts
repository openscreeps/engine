/*
 * In-process Screeps world simulation: one `Simulation` instance owns one independent world.
 *
 * `tick(intents)` reproduces one iteration of the upstream main loop after the player scripts ran
 * (screeps/engine `main.js`): all active rooms are processed (`processor.js`), the global stage runs
 * (`processor/global.js`), and the game time is incremented. Persistence follows @screeps/driver
 * and @screeps/storage semantics, applied to the in-memory `WorldState`.
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { hasShardAccess } from './global/account.ts';
import { PathFinder } from '../utils/pathfinder.ts';
import { calcWorldSize } from '../utils/rooms.ts';
import type { StoredUserIntents } from '../utils/system.ts';
import { Bulk } from './bulk.ts';
import { processGlobal } from './global.ts';
import { Movement } from './movement.ts';
import { processRoom, type RoomProcessResult } from './processor.ts';
import type {
  GlobalScope,
  GlobalUserIntents,
  ObjectIntentSet,
  RoomIntentSet,
  RoomIntentsDoc,
  RoomScope,
  RoomUserIntents,
  ScopeFlag,
  SimulationEnv,
  SimulationHooks,
} from './scope.ts';
import type { NotificationDoc, RoomObject, UserDoc, WorldState } from './state.ts';
import { cloneDeep, jsonClone, merge, SeededRandom } from './support.ts';

export * from './state.ts';
export type {
  GlobalIntentSet,
  GlobalScope,
  GlobalUserIntents,
  IntentArgs,
  ObjectIntentSet,
  RoomIntentSet,
  RoomScope,
  SimulationConfig,
  SimulationEnv,
  SimulationHooks,
  HookObjectIntents,
} from './scope.ts';
export { Bulk } from './bulk.ts';

/** Intents of all players for one tick: user id -> stored intents (output of `storeIntents`). */
export type TickIntents = Readonly<Record<string, StoredUserIntents>>;

/**
 * Server-issued intents (upstream `rooms.intents` `objectsManual`, written by the backend, e.g.
 * `genEnergy` for the sim room): room name -> user id -> object id or `room` -> intents. They are
 * merged over the player's own intents for the same objects.
 */
export type ManualIntents = Readonly<
  Record<
    string,
    Readonly<Record<string, Readonly<Record<string, ObjectIntentSet & RoomIntentSet>>>>
  >
>;

export interface SimulationOptions {
  /** Wall clock in milliseconds, used wherever upstream calls `Date.now()`. Defaults to `Date.now`. */
  now?: () => number;
  /** Mirrors the upstream `config.ptr` flag. */
  ptr?: boolean;
  /** Collect room history snapshots (upstream `history.saveTick`) in tick results. */
  recordHistory?: boolean;
  /** Processor event hooks (upstream `driver.config` events for server mods). */
  hooks?: SimulationHooks;
}

export interface SimulationError {
  stage: 'room' | 'global';
  room?: string;
  message: string;
}

/** Room statistics increments (upstream `getRoomStatsUpdater`): room -> user -> stat -> amount. */
export type RoomStats = Record<string, Record<string, Record<string, number>>>;

export interface TickResult {
  /** Game time that was processed; the world is at `gameTime + 1` afterwards. */
  gameTime: number;
  processedRooms: string[];
  /** Room history snapshots of active rooms (only with `recordHistory`). */
  history: Record<string, Record<string, unknown>>;
  roomStats: RoomStats;
  /** Errors that aborted the processing of a room or of the global stage (upstream logs them). */
  errors: SimulationError[];
}

/** Deep copy of intent payloads into the mutable shape processors work on. */
function cloneIntents(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export class Simulation {
  readonly #world: WorldState;
  readonly #now: () => number;
  readonly #ptr: boolean;
  readonly #recordHistory: boolean;
  readonly #random: SeededRandom;
  readonly #pathFinder: PathFinder;
  readonly #hooks: SimulationHooks;

  constructor(state: WorldState, options: SimulationOptions = {}) {
    this.#world = cloneDeep(state);
    this.#now = options.now ?? Date.now;
    this.#ptr = options.ptr ?? false;
    this.#recordHistory = options.recordHistory ?? false;
    this.#hooks = options.hooks ?? {};
    this.#random = new SeededRandom(this.#world.rngState);
    const terrain = this.#world.terrain;
    // only map-coordinate rooms can be addressed by the path finder (not e.g. the `sim` room)
    this.#pathFinder = new PathFinder(
      Object.keys(terrain)
        .filter((room) => /^[WE]\d+[NS]\d+$/.test(room))
        .map((room) => ({ room, terrain: terrain[room] as string })),
    );
  }

  /** Live read-only view of the world. Do not mutate; use `snapshot()` for a detached copy. */
  get state(): Readonly<WorldState> {
    return this.#world;
  }

  snapshot(): WorldState {
    return cloneDeep(this.#world);
  }

  tick(intents: TickIntents, manualIntents: ManualIntents = {}): TickResult {
    const world = this.#world;
    const gameTime = world.gameTime;
    const errors: SimulationError[] = [];
    const roomStats: RoomStats = {};
    const history: Record<string, Record<string, unknown>> = {};
    const worldSize = calcWorldSize(Object.values(world.rooms));

    const env: SimulationEnv = {
      config: { ptr: this.#ptr },
      shardName: world.shardName,
      worldSize,
      pathFinder: this.#pathFinder,
      now: () => this.#now(),
      random: () => this.#random.next(),
      sendNotification: (userId, message) => {
        this.#sendNotification(userId, message);
      },
      activateRoom: (roomName) => {
        if (!world.activeRooms.includes(roomName)) {
          world.activeRooms.push(roomName);
        }
      },
      hooks: this.#hooks,
    };

    // Player intents (upstream driver.saveUserIntents).
    const roomsQueue: string[] = [...world.activeRooms];
    const roomIntents = new Map<string, RoomIntentsDoc>();
    const globalIntents: GlobalUserIntents[] = [];
    for (const userId of Object.keys(intents)) {
      const userIntents = intents[userId];
      if (!userIntents) {
        continue;
      }
      for (const roomName of Object.keys(userIntents.rooms)) {
        let doc = roomIntents.get(roomName);
        if (!doc) {
          doc = { users: {} };
          roomIntents.set(roomName, doc);
        }
        const objects = cloneIntents(userIntents.rooms[roomName]) as NonNullable<
          RoomUserIntents['objects']
        >;
        const existing = doc.users[userId];
        if (existing?.objects) {
          merge(existing.objects, objects);
        } else {
          doc.users[userId] = { objects };
        }
        if (!roomsQueue.includes(roomName)) {
          roomsQueue.push(roomName);
        }
      }
      if (userIntents.notify) {
        this.#saveNotifyIntents(userId, userIntents.notify);
      }
      if (userIntents.global) {
        globalIntents.push({
          user: userId,
          intents: cloneIntents(userIntents.global) as GlobalUserIntents['intents'],
        });
      }
    }
    for (const roomName of Object.keys(manualIntents)) {
      const byUser = manualIntents[roomName] ?? {};
      let doc = roomIntents.get(roomName);
      if (!doc) {
        doc = { users: {} };
        roomIntents.set(roomName, doc);
      }
      for (const userId of Object.keys(byUser)) {
        const objectsManual = cloneIntents(byUser[userId]) as NonNullable<
          RoomUserIntents['objectsManual']
        >;
        const existing = doc.users[userId];
        if (existing) {
          existing.objectsManual = objectsManual;
        } else {
          doc.users[userId] = { objectsManual };
        }
      }
      if (!roomsQueue.includes(roomName)) {
        roomsQueue.push(roomName);
      }
    }

    // Restricted shards: keep the upstream `shardAccess` flag (read by claim/reserve/upgrade) in sync
    // with the access expiry; other shards leave the flag to the embedder.
    if (world.restrictedShard) {
      const now = this.#now();
      for (const user of Object.values(world.users)) {
        user.shardAccess = hasShardAccess(user, now);
      }
    }

    // Rooms queue (upstream getAllRoomsNames consumes the active rooms set).
    world.activeRooms = [];
    const objectsByRoom = new Map<string, string[]>();
    for (const id of Object.keys(world.roomObjects)) {
      const room = world.roomObjects[id]?.room;
      if (room === undefined) {
        continue;
      }
      let list = objectsByRoom.get(room);
      if (!list) {
        list = [];
        objectsByRoom.set(room, list);
      }
      list.push(id);
    }

    const processedRooms: string[] = [];
    for (const roomName of roomsQueue) {
      const error = this.#processRoom(
        roomName,
        env,
        roomIntents.get(roomName),
        objectsByRoom,
        roomStats,
        history,
      );
      if (error !== undefined) {
        errors.push({ stage: 'room', room: roomName, message: error });
      } else {
        processedRooms.push(roomName);
      }
    }

    const globalError = this.#processGlobal(env, globalIntents);
    if (globalError !== undefined) {
      errors.push({ stage: 'global', message: globalError });
    }

    world.gameTime = gameTime + 1;
    world.rngState = this.#random.state;

    return { gameTime, processedRooms, history, roomStats, errors };
  }

  #genId(collection: Readonly<Record<string, unknown>>): string {
    for (;;) {
      this.#world.idCounter++;
      // 24 hex digits like upstream ObjectId-style ids (player code validates the length)
      const id = this.#world.idCounter.toString(16).padStart(24, '0');
      if (!Object.prototype.hasOwnProperty.call(collection, id)) {
        return id;
      }
    }
  }

  #bulk<T extends { _id: string }>(collection: Record<string, T>): Bulk<T> {
    return new Bulk(collection, () => this.#genId(collection));
  }

  #processRoom(
    roomName: string,
    env: SimulationEnv,
    intents: RoomIntentsDoc | undefined,
    objectsByRoom: ReadonlyMap<string, readonly string[]>,
    roomStats: RoomStats,
    history: Record<string, Record<string, unknown>>,
  ): string | undefined {
    const world = this.#world;
    const roomTerrain = world.terrain[roomName];
    const storedRoomInfo = world.rooms[roomName];
    if (roomTerrain === undefined) {
      return `Room ${roomName} has no terrain`;
    }
    if (!storedRoomInfo) {
      return `Room ${roomName} does not exist`;
    }

    const roomObjects: Record<string, RoomObject> = {};
    const users: Record<string, UserDoc> = {};
    for (const id of objectsByRoom.get(roomName) ?? []) {
      const doc = world.roomObjects[id];
      if (!doc || doc.room !== roomName) {
        continue;
      }
      roomObjects[id] = jsonClone(doc);
      if (doc.user) {
        const user = world.users[doc.user];
        if (user && !users[doc.user]) {
          users[doc.user] = jsonClone(user);
        }
      }
    }
    const flags: ScopeFlag[] = Object.values(world.flags)
      .filter((flag) => flag.room === roomName)
      .map((flag) => jsonClone(flag));

    const statsForRoom = (roomStats[roomName] ??= {});
    const scope: RoomScope = {
      env,
      roomName,
      roomObjects,
      roomTerrain,
      bulk: this.#bulk(world.roomObjects),
      bulkUsers: this.#bulk(world.users),
      bulkUsersPowerCreeps: this.#bulk(world.userPowerCreeps),
      bulkFlags: this.#bulk(world.flags),
      stats: {
        inc(name, userId, amount) {
          const userStats = (statsForRoom[String(userId)] ??= {});
          userStats[name] = (userStats[name] ?? 0) + amount;
        },
      },
      flags,
      gameTime: world.gameTime,
      roomInfo: jsonClone(storedRoomInfo),
      users,
      eventLog: [],
      roomController: undefined,
      energyAvailable: 0,
      movement: new Movement(roomObjects, roomTerrain),
    };

    let result: RoomProcessResult;
    try {
      result = processRoom(scope, intents, this.#recordHistory);
    } catch (error) {
      return errorMessage(error);
    }

    world.mapViews[roomName] = jsonClone(result.mapView);
    scope.bulk.execute();
    scope.bulkUsers.execute();
    scope.bulkFlags.execute();
    scope.bulkUsersPowerCreeps.execute();
    world.roomEventLogs[roomName] = jsonClone(scope.eventLog);

    if (result.activateRoom) {
      env.activateRoom(roomName);
      if (result.history) {
        history[roomName] = result.history;
      }
    }

    if (result.roomInfoChanged) {
      Object.assign(storedRoomInfo, jsonClone(scope.roomInfo));
    }
    return undefined;
  }

  #processGlobal(env: SimulationEnv, userIntents: GlobalUserIntents[]): string | undefined {
    const world = this.#world;
    const now = this.#now();

    const interRoomCreeps: RoomObject[] = [];
    const roomObjectsByType: Partial<Record<string, RoomObject[]>> = {};
    for (const id of Object.keys(world.roomObjects)) {
      const object = world.roomObjects[id];
      if (!object) {
        continue;
      }
      if ((object.type === 'creep' || object.type === 'powerCreep') && object.interRoom != null) {
        interRoomCreeps.push(jsonClone(object));
      }
      if (
        object.type === 'terminal' ||
        object.type === 'powerSpawn' ||
        object.type === 'powerCreep'
      ) {
        (roomObjectsByType[object.type] ??= []).push(jsonClone(object));
      }
    }

    const accessibleRooms = new Set<string>();
    for (const roomName of Object.keys(world.rooms)) {
      const room = world.rooms[roomName];
      if (room && room.status === 'normal' && (!room.openTime || room.openTime < now)) {
        accessibleRooms.add(room._id);
      }
    }

    const orders = Object.values(world.marketOrders).map((order) => jsonClone(order));
    const userPowerCreeps = Object.values(world.userPowerCreeps).map((creep) => jsonClone(creep));
    const involvedUsers = new Set<string>();
    for (const item of [...orders, ...userPowerCreeps, ...userIntents]) {
      if (item.user) {
        involvedUsers.add(item.user);
      }
    }
    const usersById: Record<string, UserDoc> = {};
    for (const userId of involvedUsers) {
      const user = world.users[userId];
      if (user) {
        usersById[userId] = jsonClone(user);
      }
    }

    const scope: GlobalScope = {
      env,
      gameTime: world.gameTime,
      shardName: world.shardName,
      restrictedShard: world.restrictedShard,
      userIntents,
      usersById,
      roomObjectsByType,
      userPowerCreeps,
      orders,
      bulkObjects: this.#bulk(world.roomObjects),
      bulkUsers: this.#bulk(world.users),
      bulkUsersPowerCreeps: this.#bulk(world.userPowerCreeps),
      bulkTransactions: this.#bulk(world.transactions),
      bulkUsersMoney: this.#bulk(world.usersMoney),
      bulkUsersResources: this.#bulk(world.usersResources),
      bulkMarketOrders: this.#bulk(world.marketOrders),
      bulkMarketIntershardOrders: this.#bulk(world.marketOrders),
    };

    try {
      processGlobal(scope, interRoomCreeps, accessibleRooms);
    } catch (error) {
      return errorMessage(error);
    }

    scope.bulkObjects.execute();
    scope.bulkUsers.execute();
    scope.bulkMarketOrders.execute();
    scope.bulkMarketIntershardOrders.execute();
    scope.bulkUsersMoney.execute();
    scope.bulkTransactions.execute();
    scope.bulkUsersResources.execute();
    scope.bulkUsersPowerCreeps.execute();
    return undefined;
  }

  /** Upstream `driver.sendNotification`: upsert a `msg` notification grouped by message. */
  #sendNotification(userId: string, message: string): void {
    const notifications = this.#world.notifications;
    const now = this.#now();
    let found = false;
    for (const doc of Object.values(notifications)) {
      if (doc.user === userId && doc.message === message && doc.date <= now && doc.type === 'msg') {
        doc.date = now;
        doc.count = (doc.count || 0) + 1;
        found = true;
      }
    }
    if (!found) {
      const doc: NotificationDoc = {
        _id: this.#genId(notifications),
        user: userId,
        message,
        date: now,
        type: 'msg',
        count: 1,
      };
      notifications[doc._id] = doc;
    }
  }

  /** Upstream `driver.saveUserIntents` handling of `notify` intents. */
  #saveNotifyIntents(userId: string, notify: NonNullable<StoredUserIntents['notify']>): void {
    const notifications = this.#world.notifications;
    for (const intent of notify.slice(0, 20)) {
      let groupInterval = intent.groupInterval;
      if (groupInterval < 0) {
        groupInterval = 0;
      }
      if (groupInterval > 1440) {
        groupInterval = 1440;
      }
      groupInterval = Math.floor(groupInterval * 60 * 1000);
      const now = this.#now();
      const date = groupInterval ? Math.ceil(now / groupInterval) * groupInterval : now;
      const message = intent.message.substring(0, 500);

      let found = false;
      for (const doc of Object.values(notifications)) {
        if (
          doc.user === userId &&
          doc.message === message &&
          doc.date === date &&
          doc.type === 'msg'
        ) {
          doc.count = (doc.count || 0) + 1;
          found = true;
        }
      }
      if (!found) {
        const doc: NotificationDoc = {
          _id: this.#genId(notifications),
          user: userId,
          message,
          date,
          type: 'msg',
          count: 1,
        };
        notifications[doc._id] = doc;
      }
    }
  }
}
