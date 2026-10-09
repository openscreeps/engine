/*
 * Per-room processing scope shared by every room processor module (the `scope` object of
 * upstream `processor.js`), plus the instance-scoped environment replacing the global driver.
 *
 * Portions derived from screeps/engine, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { PathFinder } from '../utils/pathfinder.ts';
import type { IntentName, SanitizedIntent } from '../utils/system.ts';
import type { Bulk } from './bulk.ts';
import type { Movement } from './movement.ts';
import type {
  EventLogEntry,
  FlagDoc,
  MapView,
  MarketOrder,
  MoneyLogDoc,
  PowerCreepDoc,
  ResourceLogDoc,
  RoomInfo,
  RoomObject,
  TransactionDoc,
  UserDoc,
} from './state.ts';

/**
 * Intent payload as seen by processors: sanitized fields, any of which may be missing (NPC intents).
 * Intents without fields (e.g. `suicide`) carry an empty record.
 */
export type IntentArgs<N extends IntentName> = [keyof SanitizedIntent<N>] extends [never]
  ? Readonly<Record<string, never>>
  : { [K in keyof SanitizedIntent<N>]?: SanitizedIntent<N>[K] | undefined };

/** Intents addressed to one object. */
export type ObjectIntentSet = { [N in IntentName]?: IntentArgs<N> | undefined };

export interface GenEnergyIntent {
  roomName?: string | undefined;
}

/** Intents addressed to the `room` pseudo object (arrays, like upstream). */
export type RoomIntentSet = { [N in IntentName]?: Array<IntentArgs<N>> | undefined } & {
  genEnergy?: GenEnergyIntent | undefined;
};

/** Upstream `rooms.intents` document payload for one user. */
export interface RoomUserIntents {
  objects?: Record<string, ObjectIntentSet & RoomIntentSet>;
  objectsManual?: Record<string, ObjectIntentSet & RoomIntentSet>;
}

export interface RoomIntentsDoc {
  users: Record<string, RoomUserIntents>;
}

export interface SimulationConfig {
  /** Mirrors `config.ptr` of the upstream engine (cheaper construction/levels on PTR). */
  ptr: boolean;
}

/**
 * Intents of one object as handed to hooks: the built-in intents plus any custom (mod) intent
 * types sanitized by `storeIntents(..., customIntentTypes)`, which only hooks can process.
 */
export type HookObjectIntents = ObjectIntentSet & RoomIntentSet & Readonly<Record<string, unknown>>;

/**
 * Typed replacement for the processor events upstream emits on `driver.config` (server mods).
 * Hooks belong to one `Simulation` instance; they receive the live room scope and may mutate it
 * exactly like upstream listeners could.
 */
export interface SimulationHooks {
  /** `processObject`: each room object, after its action log is reset, before NPC pre-ticks. */
  processObject?(object: RoomObject, scope: RoomScope): void;
  /** `preProcessObjectIntents`: before the intents of one object (the object may not exist). */
  preProcessObjectIntents?(
    object: RoomObject | undefined,
    userId: string,
    intents: HookObjectIntents,
    scope: RoomScope,
  ): void;
  /** `processObjectIntents`: after the built-in intents of one object were processed. */
  processObjectIntents?(
    object: RoomObject,
    userId: string,
    intents: HookObjectIntents,
    scope: RoomScope,
  ): void;
  /** `postProcessObject`: after each object's tick and map view entry. */
  postProcessObject?(object: RoomObject, scope: RoomScope, mapView: MapView): void;
  /** `processRoom`: after all objects of the room were ticked, before writes are executed. */
  processRoom?(scope: RoomScope): void;
  /** `strongholdDestroyed`: an invader core was destroyed and filled with its loot. */
  strongholdDestroyed?(object: RoomObject, scope: RoomScope): void;
}

/** Instance-scoped replacement for the upstream `driver` singleton. */
export interface SimulationEnv {
  readonly config: SimulationConfig;
  readonly shardName: string;
  readonly worldSize: number;
  readonly pathFinder: PathFinder;
  /** Wall-clock milliseconds (`Date.now()` upstream). */
  now(): number;
  /** Seeded replacement for `Math.random()`. */
  random(): number;
  sendNotification(userId: string, message: string): void;
  activateRoom(roomName: string): void;
  readonly hooks: SimulationHooks;
}

export interface RoomStatsUpdater {
  inc(name: string, userId: string | null | undefined, amount: number): void;
}

/** Flag document as manipulated during room intent processing. */
export interface ScopeFlag {
  _id?: string;
  user: string;
  room: string;
  data?: string;
  _parsed?: string[][];
  _modified?: boolean;
}

export type GlobalIntentSet = { [N in IntentName]?: Array<IntentArgs<N>> | undefined };

/** Upstream `users.intents` document: global intents of one user for one tick. */
export interface GlobalUserIntents {
  user: string;
  intents: GlobalIntentSet;
}

/** Scope of the global (inter-room) processing stage. */
export interface GlobalScope {
  readonly env: SimulationEnv;
  gameTime: number;
  shardName: string;
  userIntents: GlobalUserIntents[];
  usersById: Record<string, UserDoc>;
  roomObjectsByType: Partial<Record<string, RoomObject[]>>;
  userPowerCreeps: PowerCreepDoc[];
  orders: MarketOrder[];
  bulkObjects: Bulk<RoomObject>;
  bulkUsers: Bulk<UserDoc>;
  bulkUsersPowerCreeps: Bulk<PowerCreepDoc>;
  bulkTransactions: Bulk<TransactionDoc>;
  bulkUsersMoney: Bulk<MoneyLogDoc>;
  bulkUsersResources: Bulk<ResourceLogDoc>;
  bulkMarketOrders: Bulk<MarketOrder>;
  bulkMarketIntershardOrders: Bulk<MarketOrder>;
}

export interface RoomScope {
  readonly env: SimulationEnv;
  readonly roomName: string;
  roomObjects: Record<string, RoomObject>;
  roomTerrain: string;
  bulk: Bulk<RoomObject>;
  bulkUsers: Bulk<UserDoc>;
  bulkUsersPowerCreeps: Bulk<PowerCreepDoc>;
  bulkFlags: Bulk<FlagDoc>;
  stats: RoomStatsUpdater;
  flags: ScopeFlag[];
  gameTime: number;
  roomInfo: RoomInfo;
  users: Record<string, UserDoc>;
  eventLog: EventLogEntry[];
  roomController: RoomObject | undefined;
  energyAvailable: number;
  movement: Movement;
}
