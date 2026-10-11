/*
 * One room's processing as a self-contained job. The deterministic `Simulation` reads a job when it
 * reaches the room and executes it with bulks writing straight into the world. Concurrent processor
 * processes (upstream `engine_processorN`) execute jobs read from the stage-start world and record
 * their storage writes, notifications and activations, which the world owner applies afterwards.
 *
 * Portions derived from screeps/engine `processor.js`, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { PathFinder } from '../utils/pathfinder.ts';
import { Bulk, type BulkOp } from './bulk.ts';
import { Movement } from './movement.ts';
import { processRoom, type RoomProcessResult } from './processor.ts';
import type {
  RoomIntentsDoc,
  RoomScope,
  ScopeFlag,
  SimulationConfig,
  SimulationEnv,
  SimulationHooks,
} from './scope.ts';
import type {
  EventLogEntry,
  FlagDoc,
  MapView,
  PowerCreepDoc,
  RoomInfo,
  RoomObject,
  UserDoc,
  WorldState,
} from './state.ts';
import { jsonClone, SeededRandom } from './support.ts';

/** Everything the processing of one room reads (upstream processor room data fetch). */
export interface RoomJob {
  roomName: string;
  gameTime: number;
  roomTerrain: string;
  /** Working copies of the room's objects, most recently written first (storage query order). */
  roomObjects: Record<string, RoomObject>;
  /** Working copies of the owners of the room's objects. */
  users: Record<string, UserDoc>;
  flags: ScopeFlag[];
  roomInfo: RoomInfo;
  intents: RoomIntentsDoc | undefined;
}

/** Storage writers of a room scope. */
export interface RoomWriters {
  bulk: Bulk<RoomObject>;
  bulkUsers: Bulk<UserDoc>;
  bulkUsersPowerCreeps: Bulk<PowerCreepDoc>;
  bulkFlags: Bulk<FlagDoc>;
}

/** Statistics increments of one room: user -> stat -> amount. */
export type RoomStatsEntry = Record<string, Record<string, number>>;

/** Pathfinding over every room terrain of a world (rooms with non-map names are skipped). */
export function createPathFinder(terrain: Readonly<Record<string, string>>): PathFinder {
  return new PathFinder(
    Object.entries(terrain)
      .filter(([room]) => /^[WE]\d+[NS]\d+$/.test(room))
      .map(([room, roomTerrain]) => ({ room, terrain: roomTerrain })),
  );
}

/**
 * Reads the job of `roomName` from the world; `objectIds` must contain the ids of the room's
 * objects (stale ids are skipped). Returns an error message for rooms that cannot be processed.
 */
export function readRoomJob(
  world: Readonly<WorldState>,
  roomName: string,
  objectIds: Iterable<string> | undefined,
  intents: RoomIntentsDoc | undefined,
): RoomJob | string {
  const roomTerrain = world.terrain[roomName];
  const storedRoomInfo = world.rooms[roomName];
  if (roomTerrain === undefined) {
    return `Room ${roomName} has no terrain`;
  }
  if (!storedRoomInfo) {
    return `Room ${roomName} does not exist`;
  }

  // Storage query order: most recently written first.
  const seqs = world.roomObjectWriteSeq ?? {};
  const ids = [...(objectIds ?? [])].filter((id) => world.roomObjects[id]?.room === roomName);
  ids.sort((a, b) => (seqs[b] ?? 0) - (seqs[a] ?? 0));
  const roomObjects: Record<string, RoomObject> = {};
  const users: Record<string, UserDoc> = {};
  for (const id of ids) {
    const doc = world.roomObjects[id] as RoomObject;
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
  return {
    roomName,
    gameTime: world.gameTime,
    roomTerrain,
    roomObjects,
    users,
    flags,
    roomInfo: jsonClone(storedRoomInfo),
    intents,
  };
}

/** The processing scope of a job; `stats` receives the room's statistics increments. */
export function createRoomScope(
  job: RoomJob,
  env: SimulationEnv,
  writers: RoomWriters,
  stats: RoomStatsEntry,
): RoomScope {
  return {
    env,
    roomName: job.roomName,
    roomObjects: job.roomObjects,
    roomTerrain: job.roomTerrain,
    ...writers,
    stats: {
      inc(name, userId, amount) {
        const userStats = (stats[String(userId)] ??= {});
        userStats[name] = (userStats[name] ?? 0) + amount;
      },
    },
    flags: job.flags,
    gameTime: job.gameTime,
    roomInfo: job.roomInfo,
    users: job.users,
    eventLog: [],
    roomController: undefined,
    energyAvailable: 0,
    movement: new Movement(job.roomObjects, job.roomTerrain),
  };
}

/** Tick-wide inputs of a concurrently processed room. */
export interface RoomJobEnv {
  config: SimulationConfig;
  shardName: string;
  worldSize: number;
  /** Wall clock of the room stage (every `Date.now()` of the stage reads it). */
  now: number;
  recordHistory: boolean;
}

/** Side effects a room requests from the world owner, in call order. */
export type RoomJobEffect =
  { type: 'notify'; userId: string; message: string } | { type: 'activate'; roomName: string };

/** Results of a successfully processed room. */
export interface RoomJobWrites {
  mapView: MapView;
  eventLog: EventLogEntry[];
  activateRoom: boolean;
  history: Record<string, unknown> | undefined;
  /** The changed room document, when processing changed it. */
  roomInfo: RoomInfo | undefined;
  objects: BulkOp[];
  users: BulkOp[];
  flags: BulkOp[];
  usersPowerCreeps: BulkOp[];
}

/**
 * Outcome of a concurrently processed room. Effects and statistics recorded before a processing
 * error still apply (they are immediate upstream); storage writes only apply without an error.
 */
export interface RoomJobOutcome {
  effects: RoomJobEffect[];
  stats: RoomStatsEntry;
  writes?: RoomJobWrites;
  error?: string;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function recordingBulk<T extends { _id: string }>(): Bulk<T> {
  return new Bulk<T>({}, () => {
    throw new Error('Recorded room writes receive ids when the world owner applies them');
  });
}

/**
 * Processes a job against its own snapshot with a private random stream, recording every write
 * instead of applying it (the upstream processor processes' storage requests).
 */
export function executeRoomJob(
  job: RoomJob,
  jobEnv: RoomJobEnv,
  rngSeed: number,
  pathFinder: PathFinder,
  hooks: SimulationHooks,
): RoomJobOutcome {
  const effects: RoomJobEffect[] = [];
  const stats: RoomStatsEntry = {};
  const random = new SeededRandom(rngSeed);
  const env: SimulationEnv = {
    config: jobEnv.config,
    shardName: jobEnv.shardName,
    worldSize: jobEnv.worldSize,
    pathFinder,
    now: () => jobEnv.now,
    random: () => random.next(),
    sendNotification: (userId, message) => {
      effects.push({ type: 'notify', userId, message });
    },
    activateRoom: (roomName) => {
      effects.push({ type: 'activate', roomName });
    },
    hooks,
  };
  const writers: RoomWriters = {
    bulk: recordingBulk(),
    bulkUsers: recordingBulk(),
    bulkUsersPowerCreeps: recordingBulk(),
    bulkFlags: recordingBulk(),
  };
  const scope = createRoomScope(job, env, writers, stats);
  let result: RoomProcessResult;
  try {
    result = processRoom(scope, job.intents, jobEnv.recordHistory);
  } catch (error) {
    return { effects, stats, error: errorMessage(error) };
  }
  return {
    effects,
    stats,
    writes: {
      mapView: jsonClone(result.mapView),
      eventLog: jsonClone(scope.eventLog),
      activateRoom: result.activateRoom,
      history: result.history,
      roomInfo: result.roomInfoChanged ? jsonClone(scope.roomInfo) : undefined,
      objects: writers.bulk.collect(),
      users: writers.bulkUsers.collect(),
      flags: writers.bulkFlags.collect(),
      usersPowerCreeps: writers.bulkUsersPowerCreeps.collect(),
    },
  };
}

/** Seed of a room's private random stream: mixes the world generator state, game time and room. */
export function roomRngSeed(rngState: number, gameTime: number, roomName: string): number {
  let hash = (rngState ^ Math.imul(gameTime, 0x9e3779b1)) >>> 0;
  for (let i = 0; i < roomName.length; i++) {
    hash = Math.imul(hash ^ roomName.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash;
}
