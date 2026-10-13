import type { RoomStats } from '../../src/simulation/index.ts';
import type { RoomObject, WorldState } from '../../src/simulation/state.ts';
import type { IntentSchemas, StoredUserIntents } from '../../src/utils/system.ts';
import type { ObservedWorld, ProcessingOrder, RawIntents } from './types.ts';

export type CollectionField =
  | 'rooms'
  | 'roomObjects'
  | 'flags'
  | 'users'
  | 'userPowerCreeps'
  | 'marketOrders'
  | 'transactions'
  | 'usersMoney'
  | 'usersResources'
  | 'notifications'
  | 'marketStats';
export type StorageDocument = { _id: string; $loki?: number; meta?: unknown } & Record<
  string,
  unknown
>;
export interface Collection<T> {
  find: (query: Record<string, unknown>) => Promise<T[]>;
  insert: (documents: unknown[]) => Promise<unknown>;
}
export type StorageDatabase = Record<string, Collection<StorageDocument>> & {
  'rooms.objects': Collection<RoomObject & { $loki?: number; meta?: unknown }>;
  'market.orders': Collection<WorldState['marketOrders'][string]>;
  'users.power_creeps': Collection<WorldState['userPowerCreeps'][string]>;
};
export interface StorageEnv {
  keys: Record<
    | 'GAMETIME'
    | 'MAIN_LOOP_MIN_DURATION'
    | 'TERRAIN_DATA'
    | 'ACTIVE_ROOMS'
    | 'ROOM_EVENT_LOG'
    | 'MAP_VIEW'
    | 'ROOM_HISTORY',
    string
  >;
  set: (key: string, value: unknown) => Promise<unknown>;
  get: (key: string) => Promise<unknown>;
  sadd: (key: string, values: string[]) => Promise<unknown>;
  smembers: (key: string) => Promise<string[] | null>;
  hmset: (key: string, value: Record<string, string>) => Promise<unknown>;
  hget: (key: string, field: string) => Promise<string | null>;
}
export interface Common {
  storage: { _connect: () => Promise<void>; db: StorageDatabase; env: StorageEnv };
}
export interface StatsUpdater {
  inc: (name: string, userId: string, amount: number) => void;
}
export interface Driver {
  getRoomStatsUpdater: (room: string) => StatsUpdater;
  getGameTime: () => Promise<number>;
  saveUserIntents: (userId: string, intents: StoredUserIntents) => Promise<void>;
  config: {
    customIntentTypes: IntentSchemas;
    mainLoopCustomStage?: () => Promise<void>;
    on: {
      (event: 'processorLoopStage', listener: (stage: string, roomId: string) => void): void;
      (event: 'processObject', listener: (object: RoomObject) => void): void;
    };
  };
  queue: {
    create: (
      name: string,
      mode: 'read',
    ) => { fetch: () => Promise<string>; markDone: (userId: string) => Promise<void> };
  };
}
export interface UpstreamUtils {
  storeIntents: (
    userId: string,
    flat: RawIntents,
    runtimeData: {
      userObjects: Record<string, RoomObject>;
      roomObjects: Record<string, RoomObject>;
    },
    customIntentTypes: IntentSchemas,
  ) => StoredUserIntents;
}
export interface ModuleInternals {
  _resolveFilename: (
    request: string,
    parent: NodeJS.Module | null | undefined,
    isMain?: boolean,
    options?: { paths: string[] },
  ) => string;
}
export interface TickCapture {
  savedUsers: string[];
  processedRooms: string[];
  objectOrder: ProcessingOrder;
  roomStats: RoomStats;
  roomErrors: Array<{ room: string; message: string }>;
  loopErrors: string[];
}
export type SnapshotWorld = Pick<
  ObservedWorld,
  CollectionField | 'gameTime' | 'activeRooms' | 'roomEventLogs' | 'mapViews' | 'rngState'
>;
