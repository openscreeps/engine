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

import {
  bindWorldConstants,
  defaultConstants,
  runWithConstants,
  type Constants,
} from '../constants.ts';
import { hasShardAccess } from './global/account.ts';
import type { PathFinder } from '../utils/pathfinder.ts';
import { calcWorldSize } from '../utils/rooms.ts';
import type { StoredUserIntents } from '../utils/system.ts';
import type { ProcessorPool, RoomProcessor } from '../workers/processor-pool.ts';
import { applyBulkOps, Bulk, type BulkWriteObserver } from './bulk.ts';
import { processGlobal } from './global.ts';
import { processRoom, type RoomProcessResult } from './processor.ts';
import {
  createPathFinder,
  createRoomScope,
  errorMessage,
  readRoomJob,
  roomRngSeed,
  type RoomJob,
  type RoomJobEnv,
  type RoomJobOutcome,
} from './room-job.ts';
import type {
  GlobalScope,
  GlobalUserIntents,
  ObjectIntentSet,
  RoomIntentSet,
  RoomIntentsDoc,
  RoomUserIntents,
  SimulationEnv,
  SimulationHooks,
} from './scope.ts';
import {
  bumpRoomObjectWrite,
  syncRoomObjectWriteOrder,
  type FlagDoc,
  type NotificationDoc,
  type RoomObject,
  type UserDoc,
  type WorldState,
} from './state.ts';
import { cloneDeep, jsonClone, merge, SeededRandom, type PlainRecord } from './support.ts';

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
  /**
   * Copy by default. A serialized server may explicitly share its canonical world with the
   * simulation; it must not mutate that world during a tick and must refresh changed terrain.
   */
  stateOwnership?: 'copy' | 'shared';
  /** Wall clock in milliseconds, used wherever upstream calls `Date.now()`. Defaults to `Date.now`. */
  now?: () => number;
  /** Mirrors the upstream `config.ptr` flag. */
  ptr?: boolean;
  /** Collect room history snapshots (upstream `history.saveTick`) in tick results. */
  recordHistory?: boolean;
  /**
   * Processor event hooks (upstream `driver.config` events for server mods). With `processors`, room
   * hooks run inside the processor processes and come from the pool's setup module instead.
   */
  hooks?: SimulationHooks;
  /**
   * Concurrent room processing in supervised processor processes (upstream `processors_cnt`),
   * used by `tickAsync`. Rooms are processed from independent stage-start snapshots with private
   * random streams, and their writes are applied in queue order once all rooms finished, so
   * cross-room effects within one tick and random draws differ from the deterministic default.
   */
  processors?: ProcessorPool;
  /**
   * This world's constants (`createConstants()` changed by server mods; upstream
   * `config.common.constants`), read by reference during every tick. Defaults to the upstream values.
   */
  constants?: Constants;
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

/** Player intents of a tick sorted into upstream storage documents (`driver.saveUserIntents`). */
interface TickPlan {
  gameTime: number;
  /** Rooms in queue order; the processor pops the most recently added room first. */
  roomsQueue: string[];
  roomIntents: Map<string, RoomIntentsDoc>;
  globalIntents: GlobalUserIntents[];
  notify: Array<[userId: string, notify: NonNullable<StoredUserIntents['notify']>]>;
}

/** A tick whose rooms were read for concurrent processing, awaiting their outcomes. */
interface ConcurrentStage {
  plan: TickPlan;
  /** Wall clock of the room stage. */
  now: number;
  worldSize: number;
  /** Rooms in processing order: the index of their job, or why they cannot be processed. */
  rooms: Array<{ roomName: string; job?: number; error?: string }>;
  jobs: Array<{ job: RoomJob; rngSeed: number }>;
  env: RoomJobEnv;
}

/**
 * Read-stage flag lookup in Object.values order, rebuilt lazily after structural flag writes.
 * Documents stay live; readRoomJob still JSON-clones each one. A new lookup each stage also sees
 * direct host changes between ticks. Sequential mod hooks use uncached reads instead, since they
 * can capture and mutate the world without going through a bulk writer.
 */
class RoomFlagLookup implements BulkWriteObserver {
  readonly #world: Readonly<WorldState>;
  readonly #empty: readonly FlagDoc[] = [];
  #byRoom: Map<string, FlagDoc[]> | undefined;

  constructor(world: Readonly<WorldState>) {
    this.#world = world;
  }

  get(roomName: string): readonly FlagDoc[] {
    if (!this.#byRoom) {
      this.#byRoom = new Map();
      for (const flag of Object.values(this.#world.flags)) {
        let flags = this.#byRoom.get(flag.room);
        if (!flags) {
          flags = [];
          this.#byRoom.set(flag.room, flags);
        }
        flags.push(flag);
      }
    }
    return this.#byRoom.get(roomName) ?? this.#empty;
  }

  write(_id: string, doc: PlainRecord): void {
    // Applied updates preserve document identity and key order. If the document is still in its
    // indexed room, its new data is already visible through the live reference. Inserts (including
    // replacements of existing ids) and room moves need a rebuild to recover enumeration order.
    if (
      this.#byRoom &&
      !this.#byRoom.get(doc.room as string)?.includes(doc as unknown as FlagDoc)
    ) {
      this.invalidate();
    }
  }

  remove(): void {
    this.invalidate();
  }

  invalidate(): void {
    this.#byRoom = undefined;
  }
}

export class Simulation {
  readonly #world: WorldState;
  readonly #now: () => number;
  readonly #ptr: boolean;
  readonly #recordHistory: boolean;
  readonly #random: SeededRandom;
  #pathFinder!: PathFinder;
  readonly #hooks: SimulationHooks;
  readonly #processor: RoomProcessor | undefined;
  /** Incremented whenever pathfinding terrain is rebuilt (processor processes reload it). */
  #terrainVersion = 0;
  readonly #constants: Constants;
  /** Object ids of each room for the running tick (stale entries are filtered on use). */
  readonly #objectsByRoom = new Map<string, Set<string>>();

  constructor(state: WorldState, options: SimulationOptions = {}) {
    this.#world = options.stateOwnership === 'shared' ? state : cloneDeep(state);
    this.#now = options.now ?? Date.now;
    this.#ptr = options.ptr ?? false;
    this.#recordHistory = options.recordHistory ?? false;
    this.#hooks = options.hooks ?? {};
    this.#constants = options.constants ?? defaultConstants;
    bindWorldConstants(this.#world, this.#constants);
    this.#random = new SeededRandom(this.#world.rngState);
    if (options.processors && Object.keys(this.#hooks).length > 0) {
      throw new TypeError(
        'Simulation hooks cannot be combined with processors: give the ProcessorPool a setup module that returns them',
      );
    }
    this.#processor = options.processors?.openProcessor();
    this.refreshTerrain();
  }

  /** Live read-only view of the world. Do not mutate; use `snapshot()` for a detached copy. */
  get state(): Readonly<WorldState> {
    return this.#world;
  }

  /** This world's constants object (shared by reference, not a copy). */
  get constants(): Constants {
    return this.#constants;
  }

  snapshot(): WorldState {
    return cloneDeep(this.#world);
  }

  /** Rebuild pathfinding terrain after a host adds, removes, or edits rooms in a shared world. */
  refreshTerrain(): void {
    this.#pathFinder = createPathFinder(this.#world.terrain);
    this.#terrainVersion++;
  }

  /** Processes one tick in this process, in the deterministic room order. */
  tick(intents: TickIntents, manualIntents: ManualIntents = {}): TickResult {
    return runWithConstants(this.#constants, () => this.#tick(intents, manualIntents));
  }

  /**
   * Processes one tick like `tick`, with the rooms processed concurrently by the configured
   * `processors`. The world is not modified until every room finished; a processor process failure
   * is retried once and otherwise reported as an error of the room, which is then skipped. Rejects,
   * leaving the world unchanged, only when the processor pool is closed.
   */
  async tickAsync(intents: TickIntents, manualIntents: ManualIntents = {}): Promise<TickResult> {
    const processor = this.#processor;
    if (!processor) {
      return this.tick(intents, manualIntents);
    }
    const stage = runWithConstants(this.#constants, () =>
      this.#prepareConcurrentRooms(intents, manualIntents),
    );
    const outcomes = await processor.process({
      terrainVersion: this.#terrainVersion,
      terrain: this.#world.terrain,
      constants: this.#constants,
      env: stage.env,
      jobs: stage.jobs,
    });
    return runWithConstants(this.#constants, () => this.#commitConcurrentRooms(stage, outcomes));
  }

  #env(worldSize: number): SimulationEnv {
    const world = this.#world;
    return {
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
  }

  /** Player intents (upstream driver.saveUserIntents) without writing the world. */
  #plan(intents: TickIntents, manualIntents: ManualIntents): TickPlan {
    const world = this.#world;
    const roomsQueue: string[] = [...world.activeRooms];
    // Preserve existing queue duplicates; only newly requested rooms are deduplicated.
    const queuedRooms = new Set(roomsQueue);
    const roomIntents = new Map<string, RoomIntentsDoc>();
    const globalIntents: GlobalUserIntents[] = [];
    const notify: TickPlan['notify'] = [];
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
        if (!queuedRooms.has(roomName)) {
          roomsQueue.push(roomName);
          queuedRooms.add(roomName);
        }
      }
      if (userIntents.notify) {
        notify.push([userId, userIntents.notify]);
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
      if (!queuedRooms.has(roomName)) {
        roomsQueue.push(roomName);
        queuedRooms.add(roomName);
      }
    }
    return { gameTime: world.gameTime, roomsQueue, roomIntents, globalIntents, notify };
  }

  /**
   * Saves `notify` intents, refreshes restricted shard access and consumes the active rooms set
   * (upstream getAllRoomsNames), as the room stage starts.
   */
  #startRoomStage(plan: TickPlan, now: () => number): void {
    const world = this.#world;
    for (const [userId, notify] of plan.notify) {
      this.#saveNotifyIntents(userId, notify);
    }
    // Restricted shards: keep the upstream `shardAccess` flag (read by claim/reserve/upgrade) in sync
    // with the access expiry; other shards leave the flag to the embedder.
    if (world.restrictedShard) {
      const time = now();
      for (const user of Object.values(world.users)) {
        user.shardAccess = hasShardAccess(user, time);
      }
    }
    world.activeRooms = [];
  }

  /** Global stage, then the game time advances. */
  #finishTick(
    plan: TickPlan,
    env: SimulationEnv,
    result: Omit<TickResult, 'gameTime'>,
  ): TickResult {
    const world = this.#world;
    const globalError = this.#processGlobal(env, plan.globalIntents);
    if (globalError !== undefined) {
      result.errors.push({ stage: 'global', message: globalError });
    }
    world.gameTime = plan.gameTime + 1;
    world.rngState = this.#random.state;
    return { gameTime: plan.gameTime, ...result };
  }

  #tick(intents: TickIntents, manualIntents: ManualIntents): TickResult {
    const world = this.#world;
    // A shared-state host may advance the same generator between ticks (world maintenance).
    this.#random.state = world.rngState;
    const roomStats: RoomStats = {};
    const history: Record<string, Record<string, unknown>> = {};
    const env = this.#env(calcWorldSize(Object.values(world.rooms)));
    const plan = this.#plan(intents, manualIntents);
    this.#startRoomStage(plan, () => this.#now());
    this.#indexRoomObjects();
    const roomFlags = new RoomFlagLookup(world);

    // Upstream the main loop adds the active rooms set to the storage rooms queue, from which the
    // processor pops the most recently added room first (screeps/storage lib/queue.js `queueFetch`).
    const errors: SimulationError[] = [];
    const processedRooms: string[] = [];
    for (let i = plan.roomsQueue.length - 1; i >= 0; i--) {
      const roomName = plan.roomsQueue[i] as string;
      const error = this.#processRoom(
        roomName,
        env,
        plan.roomIntents.get(roomName),
        roomFlags,
        roomStats,
        history,
      );
      if (error !== undefined) {
        errors.push({ stage: 'room', room: roomName, message: error });
      } else {
        processedRooms.push(roomName);
      }
    }
    return this.#finishTick(plan, env, { processedRooms, history, roomStats, errors });
  }

  /**
   * Reads every queued room from the stage-start world (upstream processors fetch rooms
   * concurrently). Unrecorded host writes get a temporary order; no world changes precede success.
   */
  #prepareConcurrentRooms(intents: TickIntents, manualIntents: ManualIntents): ConcurrentStage {
    const world = this.#world;
    let readWorld = world;
    const seqs = world.roomObjectWriteSeq ?? {};
    for (const id in world.roomObjects) {
      if (Object.hasOwn(world.roomObjects, id) && !Object.hasOwn(seqs, id)) {
        readWorld = { ...world, roomObjectWriteSeq: { ...seqs } };
        syncRoomObjectWriteOrder(readWorld);
        break;
      }
    }
    const plan = this.#plan(intents, manualIntents);
    this.#indexRoomObjects(false);
    const now = this.#now();
    const worldSize = calcWorldSize(Object.values(world.rooms));
    const rooms: ConcurrentStage['rooms'] = [];
    const jobs: ConcurrentStage['jobs'] = [];
    const roomFlags = new RoomFlagLookup(readWorld);
    for (let i = plan.roomsQueue.length - 1; i >= 0; i--) {
      const roomName = plan.roomsQueue[i] as string;
      const job = readRoomJob(
        readWorld,
        roomName,
        this.#objectsByRoom.get(roomName),
        plan.roomIntents.get(roomName),
        roomFlags.get(roomName),
      );
      if (typeof job === 'string') {
        rooms.push({ roomName, error: job });
        continue;
      }
      if (world.restrictedShard) {
        // The flag refreshed at stage start (see `#startRoomStage`).
        for (const user of Object.values(job.users)) {
          user.shardAccess = hasShardAccess(user, now);
        }
      }
      rooms.push({ roomName, job: jobs.length });
      jobs.push({ job, rngSeed: roomRngSeed(world.rngState, plan.gameTime, roomName) });
    }
    return {
      plan,
      now,
      worldSize,
      rooms,
      jobs,
      env: {
        config: { ptr: this.#ptr },
        shardName: world.shardName,
        worldSize,
        now,
        recordHistory: this.#recordHistory,
      },
    };
  }

  /** Applies the processed rooms in queue order, then runs the global stage. */
  #commitConcurrentRooms(stage: ConcurrentStage, outcomes: readonly RoomJobOutcome[]): TickResult {
    const world = this.#world;
    syncRoomObjectWriteOrder(world);
    this.#random.state = world.rngState;
    const roomStats: RoomStats = {};
    const history: Record<string, Record<string, unknown>> = {};
    const env = this.#env(stage.worldSize);
    this.#startRoomStage(stage.plan, () => stage.now);
    const errors: SimulationError[] = [];
    const processedRooms: string[] = [];
    for (const room of stage.rooms) {
      const outcome = room.job === undefined ? undefined : outcomes[room.job];
      const error =
        outcome === undefined
          ? (room.error ?? `Room ${room.roomName} was not processed`)
          : this.#applyRoomOutcome(room.roomName, outcome, env, roomStats, history);
      if (error !== undefined) {
        errors.push({ stage: 'room', room: room.roomName, message: error });
      } else {
        processedRooms.push(room.roomName);
      }
    }
    return this.#finishTick(stage.plan, env, { processedRooms, history, roomStats, errors });
  }

  /** Applies a concurrently processed room exactly as `#processRoom` applies its own writes. */
  #applyRoomOutcome(
    roomName: string,
    outcome: RoomJobOutcome,
    env: SimulationEnv,
    roomStats: RoomStats,
    history: Record<string, Record<string, unknown>>,
  ): string | undefined {
    const world = this.#world;
    const statsForRoom = (roomStats[roomName] ??= {});
    for (const [userId, userStats] of Object.entries(outcome.stats)) {
      const target = (statsForRoom[userId] ??= {});
      for (const [name, amount] of Object.entries(userStats)) {
        target[name] = (target[name] ?? 0) + amount;
      }
    }
    for (const effect of outcome.effects) {
      if (effect.type === 'notify') {
        this.#sendNotification(effect.userId, effect.message);
      } else {
        env.activateRoom(effect.roomName);
      }
    }
    const writes = outcome.writes;
    if (!writes) {
      return outcome.error ?? `Room ${roomName} produced no result`;
    }
    world.mapViews[roomName] = writes.mapView;
    applyBulkOps(
      world.roomObjects,
      writes.objects,
      () => this.#genId(world.roomObjects),
      this.#roomObjectsObserver(),
    );
    applyBulkOps(world.users, writes.users, () => this.#genId(world.users));
    applyBulkOps(world.flags, writes.flags, () => this.#genId(world.flags));
    applyBulkOps(world.userPowerCreeps, writes.usersPowerCreeps, () =>
      this.#genId(world.userPowerCreeps),
    );
    world.roomEventLogs[roomName] = writes.eventLog;
    if (writes.activateRoom) {
      env.activateRoom(roomName);
      if (writes.history) {
        history[roomName] = writes.history;
      }
    }
    const storedRoomInfo = world.rooms[roomName];
    if (writes.roomInfo && storedRoomInfo) {
      Object.assign(storedRoomInfo, writes.roomInfo);
    }
    return undefined;
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

  /**
   * Synchronizes the room object write order with host changes (`syncRoomObjectWriteOrder`) and
   * groups object ids by room for this tick.
   */
  #indexRoomObjects(normalize = true): void {
    const world = this.#world;
    if (normalize) syncRoomObjectWriteOrder(world);
    this.#objectsByRoom.clear();
    for (const id of Object.keys(world.roomObjects)) {
      const room = world.roomObjects[id]?.room;
      if (room !== undefined) {
        this.#roomIds(room).add(id);
      }
    }
  }

  #roomIds(room: string): Set<string> {
    let ids = this.#objectsByRoom.get(room);
    if (!ids) {
      ids = new Set();
      this.#objectsByRoom.set(room, ids);
    }
    return ids;
  }

  /**
   * Write observer of `rooms.objects`. Every applied update or insert makes the object the most
   * recently written one (upstream LokiJS repositions it at the front of its `room` index range).
   * Objects written into another room (e.g. a launched nuke) join that room's processing this tick.
   */
  #roomObjectsObserver(): BulkWriteObserver {
    const world = this.#world;
    const seqs = (world.roomObjectWriteSeq ??= {});
    return {
      write: (id, doc) => {
        bumpRoomObjectWrite(world, seqs, id);
        if (typeof doc.room === 'string') {
          this.#roomIds(doc.room).add(id);
        }
      },
      remove: (id) => {
        Reflect.deleteProperty(seqs, id);
      },
    };
  }

  #roomObjectsBulk(): Bulk<RoomObject> {
    const world = this.#world;
    return new Bulk(
      world.roomObjects,
      () => this.#genId(world.roomObjects),
      this.#roomObjectsObserver(),
    );
  }

  #processRoom(
    roomName: string,
    env: SimulationEnv,
    intents: RoomIntentsDoc | undefined,
    roomFlags: RoomFlagLookup,
    roomStats: RoomStats,
    history: Record<string, Record<string, unknown>>,
  ): string | undefined {
    const world = this.#world;
    const hasHooks =
      'processObject' in this.#hooks ||
      'preProcessObjectIntents' in this.#hooks ||
      'processObjectIntents' in this.#hooks ||
      'postProcessObject' in this.#hooks ||
      'processRoom' in this.#hooks ||
      'strongholdDestroyed' in this.#hooks;
    if (hasHooks) {
      // Discard a previously built lookup even if a hook removes itself during this room.
      roomFlags.invalidate();
    }
    const job: RoomJob | string = readRoomJob(
      world,
      roomName,
      this.#objectsByRoom.get(roomName),
      intents,
      hasHooks ? undefined : roomFlags.get(roomName),
    );
    if (typeof job === 'string') {
      return job;
    }
    const scope = createRoomScope(
      job,
      env,
      {
        bulk: this.#roomObjectsBulk(),
        bulkUsers: this.#bulk(world.users),
        bulkUsersPowerCreeps: this.#bulk(world.userPowerCreeps),
        bulkFlags: new Bulk(world.flags, () => this.#genId(world.flags), roomFlags),
      },
      (roomStats[roomName] ??= {}),
    );

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

    const storedRoomInfo = world.rooms[roomName];
    if (result.roomInfoChanged && storedRoomInfo) {
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
      bulkObjects: this.#roomObjectsBulk(),
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
