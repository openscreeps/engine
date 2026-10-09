/*
 * Player runtime: persistent per-user code, memory, segments and CPU bucket, executed in per-user
 * isolated-vm isolates (screeps/driver `lib/runtime/make.js`, `user-vm.js`, `data.js` and engine
 * `runner.js`), plus the account-level APIs of the official game (`InterShardMemory`,
 * `Game.cpu.shardLimits`/`setShardLimits`/`unlock`/`generatePixel`, `Game.shard`).
 *
 * Portions derived from screeps/driver and screeps/engine, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../constants.ts';
import type { WorldState } from '../simulation/state.ts';
import { storeIntents, type IntentSchemas, type StoredUserIntents } from '../utils/index.ts';
import type { ConsoleMessage } from './game/console.ts';
import type { IntentList } from './game/intents.ts';
import type {
  CodeModules,
  ConsoleCommand,
  CustomObjectPrototype,
  CustomObjectPrototypeOptions,
  RuntimeAccountData,
  RuntimeData,
} from './game/runtime-data.ts';
import { getRuntimeBundle } from './host/bundle.ts';
import { InterShardStore, type InterShardSnapshot } from './host/inter-shard-store.ts';
import { createIsolatedVmSandbox } from './host/isolated-vm-sandbox.ts';
import {
  buildRuntimeData,
  buildWorldIndex,
  type ForeignSegmentSelection,
  type WorldIndex,
} from './host/runtime-data.ts';
import type { PlayerSandbox, TerrainPack } from './host/sandbox.ts';
import { parseSandboxResult } from './host/validate.ts';
import type { SandboxRunMessage } from './protocol.ts';

export type {
  CodeModules,
  ConsoleCommand,
  CustomObjectPrototype,
  CustomObjectPrototypeOptions,
} from './game/runtime-data.ts';
export type { ConsoleMessage } from './game/console.ts';
export {
  InterShardStore,
  type InterShardSnapshot,
  type ShardLimitsState,
} from './host/inter-shard-store.ts';

/** A server-mod object prototype; functions may be given as functions or as source text. */
export interface CustomObjectPrototypeConfig {
  objectType: string;
  name: string;
  opts?: {
    parent?: string;
    properties?: Record<string, string | ((...args: never[]) => unknown)>;
    prototypeExtender?: string | ((...args: never[]) => unknown);
    userOwned?: boolean;
    findConstant?: number;
    lookConstant?: string;
  };
}

export interface BotRuntimeOptions {
  /** Heap limit per player isolate in MB (upstream 256; terrain size is added). */
  memoryLimitMb?: number;
  /** Maximum CPU per tick including bucket (upstream `config.engine.cpuMaxPerTick`, 500). */
  cpuMaxPerTick?: number;
  /** Bucket capacity (upstream `config.engine.cpuBucketSize`, 10000). */
  cpuBucketSize?: number;
  /** Hard wall-clock limit per player run before the isolate is reset (upstream 5000 ms). */
  hardTimeoutMs?: number;
  /** Wall clock for room status checks and account APIs (default `Date.now`). */
  now?: () => number;
  /** `Game.shard.ptr` of this world (default `false`). */
  ptr?: boolean;
  /** Shared multi-shard account store; omit for a private single-shard store. */
  interShard?: InterShardStore;
  /** Server-mod object prototypes (driver `config.engine.registerCustomObjectPrototype`). */
  customObjectPrototypes?: readonly CustomObjectPrototypeConfig[];
  /** Server-mod intent schemas (driver `config.engine.customIntentTypes`). */
  customIntentTypes?: IntentSchemas;
  /**
   * Survival/simulation game descriptors by game id, exposed as `Room.survivalInfo` for rooms named
   * `<id>` or `survival_<id>` (upstream `runtimeData.games`; the private server never sets it).
   */
  games?: Record<string, unknown>;
  snapshot?: RuntimeSnapshot;
}

/** Persisted per-user runtime state. */
export interface RuntimeUserSnapshot {
  modules: CodeModules;
  branch: string;
  codeTimestamp: number;
  memory: string;
  segments: Record<number, string>;
  activeSegments: number[];
  publicSegments?: string;
  defaultPublicSegment?: number | null;
  activeForeignSegment?: ForeignSegmentSelection;
  /** CPU bucket (`users.cpuAvailable`); seeded from the world user document when absent. */
  cpuAvailable?: number;
  consoleCommands: ConsoleCommand[];
}

export interface RuntimeSnapshot {
  version: 1;
  lastCodeTimestamp: number;
  users: Record<string, RuntimeUserSnapshot>;
  interShard: InterShardSnapshot;
}

export interface UserRunResult {
  userId: string;
  /** Sanitized intents for the simulation (empty when the run failed). */
  intents: StoredUserIntents;
  console: { log: ConsoleMessage[]; results: string[]; error?: string };
  /** Room visuals keyed by room name (`map` for the map visual), newline separated JSON. */
  visual: Record<string, string>;
  /**
   * Host-measured clean-phase CPU: `used` is the driver's reported `usedTime` (clean time plus the
   * sandbox intent accumulator); `charged` is what was debited from the bucket (clean time plus 0.2
   * per counted intent, driver `make.js`).
   */
  cpu: { used: number; charged: number; limit: number; bucket: number };
  memorySize: number;
  /** Memory exceeded 2 MB and was not saved (upstream rejects the save silently). */
  memoryRejected: boolean;
  /** A new isolate (global reset) was created for this run. */
  reset: boolean;
  /** `Game.cpu.halt()` was called. */
  halted: boolean;
}

export interface TickRunResult {
  intents: Record<string, StoredUserIntents>;
  users: Record<string, UserRunResult>;
}

const MEMORY_LIMIT = 2 * 1024 * 1024;
const FREE_INTENTS: Record<string, true> = { say: true, pull: true };

/**
 * Driver `intentsCount`: `for (entity in list) for (name in list[entity])`, so every entry of a
 * top-level list (e.g. `notify`) counts once and object intents count per entry unless free.
 */
function intentsCount(intentsList: IntentList): number {
  let count = 0;
  for (const entity of Object.values(intentsList)) {
    if (Array.isArray(entity)) {
      count += entity.length;
      continue;
    }
    for (const [name, value] of Object.entries(entity)) {
      if (!FREE_INTENTS[name]) {
        count += Array.isArray(value) ? value.length : 1;
      }
    }
  }
  return count;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function emptyResult(
  userId: string,
  cpuLimit: number,
  bucket: number,
  error: string,
  reset: boolean,
  halted: boolean,
): UserRunResult {
  return {
    userId,
    intents: { rooms: {} },
    console: { log: [], results: [], error },
    visual: {},
    cpu: { used: 0, charged: 0, limit: cpuLimit, bucket },
    memorySize: 0,
    memoryRejected: false,
    reset,
    halted,
  };
}

/** Driver `registerCustomObjectPrototype`: functions are transported as source text. */
function normalizePrototype(config: CustomObjectPrototypeConfig): CustomObjectPrototype {
  if (!config.objectType) {
    throw new Error('No object type provided!');
  }
  if (!config.name) {
    throw new Error('No prototype name provided!');
  }
  const source = config.opts ?? {};
  const opts: CustomObjectPrototypeOptions = {};
  if (source.parent !== undefined) {
    opts.parent = source.parent;
  }
  const properties: Record<string, string> = {};
  for (const [key, fn] of Object.entries(source.properties ?? {})) {
    properties[key] = typeof fn === 'string' ? fn : fn.toString();
  }
  opts.properties = properties;
  if (source.prototypeExtender !== undefined) {
    opts.prototypeExtender =
      typeof source.prototypeExtender === 'string'
        ? source.prototypeExtender
        : source.prototypeExtender.toString();
  }
  if (source.userOwned !== undefined) {
    opts.userOwned = source.userOwned;
  }
  if (source.findConstant !== undefined) {
    opts.findConstant = source.findConstant;
  }
  if (source.lookConstant !== undefined) {
    opts.lookConstant = source.lookConstant;
  }
  return { objectType: config.objectType, name: config.name, opts };
}

/** Keeps only the first `allowed` entries of a global intent list (host-side validation). */
function limitGlobalIntents(
  intents: StoredUserIntents,
  name: 'generatePixel' | 'unlockCpu' | 'activateAccess',
  allowed: number,
): number {
  const list = intents.global?.[name];
  if (!list) {
    return 0;
  }
  if (list.length > allowed) {
    list.length = Math.max(0, allowed);
  }
  return list.length;
}

export class BotRuntime implements Disposable {
  readonly #memoryLimitMb: number;
  readonly #cpuMaxPerTick: number;
  readonly #cpuBucketSize: number;
  readonly #hardTimeoutMs: number;
  readonly #now: () => number;
  readonly #ptr: boolean;
  readonly #interShard: InterShardStore;
  readonly #customObjectPrototypes: CustomObjectPrototype[];
  readonly #customIntentTypes: IntentSchemas;
  readonly #games: Record<string, unknown> | undefined;
  readonly #users: Record<string, RuntimeUserSnapshot>;
  readonly #sandboxes: Record<string, PlayerSandbox> = {};
  /** Players with a run in flight; runs of one player are serialized through this chain. */
  readonly #running: Record<string, Promise<unknown>> = {};
  #lastCodeTimestamp: number;
  #terrain: TerrainPack | undefined;
  #terrainSignature: string | undefined;
  #disposed = false;

  constructor(options: BotRuntimeOptions = {}) {
    this.#memoryLimitMb = options.memoryLimitMb ?? 256;
    this.#cpuMaxPerTick = options.cpuMaxPerTick ?? 500;
    this.#cpuBucketSize = options.cpuBucketSize ?? 10000;
    this.#hardTimeoutMs = options.hardTimeoutMs ?? 5000;
    this.#now = options.now ?? Date.now;
    this.#ptr = options.ptr ?? false;
    this.#customObjectPrototypes = (options.customObjectPrototypes ?? []).map(normalizePrototype);
    this.#customIntentTypes = structuredClone(options.customIntentTypes ?? {});
    this.#games = options.games ? structuredClone(options.games) : undefined;
    const snapshot: RuntimeSnapshot | undefined = options.snapshot
      ? structuredClone(options.snapshot)
      : undefined;
    this.#users = snapshot?.users ?? {};
    this.#lastCodeTimestamp = snapshot?.lastCodeTimestamp ?? 0;
    this.#interShard = options.interShard ?? new InterShardStore(snapshot?.interShard);
  }

  #user(userId: string): RuntimeUserSnapshot {
    return (this.#users[userId] ??= {
      modules: {},
      branch: 'default',
      codeTimestamp: 0,
      memory: '',
      segments: {},
      activeSegments: [],
      consoleCommands: [],
    });
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new Error('BotRuntime is disposed');
    }
  }

  /** Player state may not change while one of the player's runs is in flight. */
  #assertIdle(userId: string): void {
    this.#assertActive();
    if (userId in this.#running) {
      throw new Error(`Player ${userId} is running; wait for the run to finish`);
    }
  }

  /** Replaces the player's code; the next run starts with a fresh isolate (global reset). */
  setCode(userId: string, modules: CodeModules, branch = 'default'): void {
    this.#assertIdle(userId);
    const user = this.#user(userId);
    user.modules = structuredClone(modules);
    user.branch = branch;
    this.#lastCodeTimestamp = Math.max(this.#now(), this.#lastCodeTimestamp + 1);
    user.codeTimestamp = this.#lastCodeTimestamp;
  }

  getCode(userId: string): { modules: CodeModules; branch: string } | undefined {
    const user = this.#users[userId];
    return user ? { modules: structuredClone(user.modules), branch: user.branch } : undefined;
  }

  getMemory(userId: string): string {
    return this.#users[userId]?.memory ?? '';
  }

  setMemory(userId: string, raw: string): void {
    this.#assertIdle(userId);
    this.#user(userId).memory = raw;
  }

  getSegment(userId: string, id: number): string | undefined {
    return this.#users[userId]?.segments[id];
  }

  setSegment(userId: string, id: number, data: string): void {
    this.#assertIdle(userId);
    if (!Number.isInteger(id) || id < 0 || id > 99) {
      throw new Error(`"${String(id)}" is not a valid segment ID`);
    }
    this.#user(userId).segments[id] = data;
  }

  /** Release a removed server account's isolate and all of its local persistent runtime data. */
  removeUser(userId: string): void {
    this.#assertIdle(userId);
    this.#clear(userId);
    Reflect.deleteProperty(this.#users, userId);
  }

  /** Invalidate terrain after a host edits existing rooms without changing their names. */
  refreshTerrain(): void {
    this.#assertActive();
    for (const userId in this.#running) this.#assertIdle(userId);
    this.#terrainSignature = undefined;
  }

  /** Queues a console expression evaluated after the next main loop (`users.console`). */
  enqueueConsoleCommand(userId: string, expression: string, hidden = false): void {
    this.#assertIdle(userId);
    const command: ConsoleCommand = { expression };
    if (hidden) {
      command.hidden = true;
    }
    this.#user(userId).consoleCommands.push(command);
  }

  snapshot(): RuntimeSnapshot {
    return structuredClone({
      version: 1,
      lastCodeTimestamp: this.#lastCodeTimestamp,
      users: this.#users,
      interShard: this.#interShard.snapshot(),
    });
  }

  #terrainPack(world: Readonly<WorldState>): TerrainPack {
    const rooms = Object.keys(world.terrain);
    const signature = rooms.join(',');
    if (this.#terrain && signature === this.#terrainSignature) {
      return this.#terrain;
    }
    const view = new Uint8Array(rooms.length * 2500);
    const offsets: Record<string, number> = {};
    rooms.forEach((room, roomIndex) => {
      const terrain = world.terrain[room] ?? '';
      const offset = roomIndex * 2500;
      for (let i = 0; i < 2500; i++) {
        view[i + offset] = Number(terrain.charAt(i));
      }
      offsets[room] = offset;
    });
    this.#terrain = {
      version: (this.#terrain?.version ?? 0) + 1,
      buffer: view.buffer,
      roomOffsets: JSON.stringify(offsets),
      byteLength: view.byteLength,
    };
    this.#terrainSignature = signature;
    return this.#terrain;
  }

  async #sandbox(
    userId: string,
    codeTimestamp: number,
    terrain: TerrainPack,
  ): Promise<{ sandbox: PlayerSandbox; reset: boolean }> {
    const existing = this.#sandboxes[userId];
    if (existing) {
      if (existing.disposed) {
        this.#clear(userId);
        throw new Error(
          'Script execution has been terminated: your isolate disposed unexpectedly, restarting virtual machine',
        );
      }
      if (codeTimestamp <= existing.codeTimestamp) {
        await existing.loadTerrain(terrain);
        return { sandbox: existing, reset: false };
      }
      this.#clear(userId);
    }
    const bundle = await getRuntimeBundle();
    const sandbox = await createIsolatedVmSandbox({
      bundle,
      codeTimestamp,
      memoryLimitMb: this.#memoryLimitMb,
      terrain,
    });
    if (this.#disposed) {
      sandbox.dispose();
      throw new Error('BotRuntime is disposed');
    }
    this.#sandboxes[userId] = sandbox;
    return { sandbox, reset: true };
  }

  #clear(userId: string): void {
    this.#sandboxes[userId]?.dispose();
    Reflect.deleteProperty(this.#sandboxes, userId);
  }

  #publicSegments = (
    userId: string,
  ): { publicSegments: string | undefined; segments: Record<number, string> } | undefined => {
    const user = this.#users[userId];
    return user ? { publicSegments: user.publicSegments, segments: user.segments } : undefined;
  };

  /**
   * Runs one player against the current world state (upstream `driver.makeRuntime`). Runs of the
   * same player are serialized; failures of the player's code never reject.
   */
  runUser(
    world: Readonly<WorldState>,
    userId: string,
    index?: WorldIndex,
  ): Promise<UserRunResult | undefined> {
    this.#assertActive();
    const previous = this.#running[userId] ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.#runUserNow(world, userId, index ?? buildWorldIndex(world, this.#now())));
    this.#running[userId] = run;
    const release = (): void => {
      if (this.#running[userId] === run) {
        Reflect.deleteProperty(this.#running, userId);
      }
    };
    run.then(release, release);
    return run;
  }

  #accountData(
    world: Readonly<WorldState>,
    userId: string,
    cpu: number | undefined,
    now: number,
  ): RuntimeAccountData {
    const shard = world.shardName;
    const userDoc = world.users[userId];
    if (cpu !== undefined && this.#interShard.explicitLimit(userId, shard) === undefined) {
      this.#interShard.reportShardCpu(userId, shard, cpu);
    }
    const limits = this.#interShard.getShardLimits(userId);
    return {
      ptr: this.#ptr,
      shardLimits: limits.limits,
      shardLimitsCooldownTime: limits.cooldownTime,
      cpuUnlockedTime: userDoc?.cpuUnlockedTime ?? undefined,
      cpuSubscription: userDoc?.cpuSubscription ?? false,
      now,
      interShardLocal: this.#interShard.getData(shard, userId),
      interShardRemote: this.#interShard.getRemoteData(shard, userId),
      interShardSegment: this.#interShard.getSegment(userId),
      restrictedShard: world.restrictedShard,
      shardAccessTime: userDoc?.shardAccessTime ?? undefined,
      shardAccessUnlimited: userDoc?.shardAccessUnlimited ?? false,
    };
  }

  async #runUserNow(
    world: Readonly<WorldState>,
    userId: string,
    worldIndex: WorldIndex,
  ): Promise<UserRunResult | undefined> {
    if (this.#disposed) {
      throw new Error('BotRuntime is disposed');
    }
    const state = this.#users[userId];
    const userDoc = world.users[userId];
    if (!state || !userDoc) {
      return undefined;
    }
    const now = this.#now();
    const shard = world.shardName;
    const explicitCpu = this.#interShard.explicitLimit(userId, shard);
    // Upstream treats a missing/zero `users.cpu` as unlimited; an explicit shard allocation made
    // with `setShardLimits` (including 0) is always a finite budget.
    const limited = explicitCpu !== undefined || !!userDoc.cpu;
    const shardCpu = explicitCpu ?? userDoc.cpu ?? 0;

    // Upstream `getUserData`: bucket accounting and empty-bucket skip.
    let cpu = Infinity;
    let cpuBucket = Infinity;
    state.cpuAvailable ??= userDoc.cpuAvailable ?? 0;
    if (limited) {
      if (state.cpuAvailable < 0) {
        state.cpuAvailable =
          state.cpuAvailable < -shardCpu * 2 ? -shardCpu * 2 : state.cpuAvailable + shardCpu;
        return emptyResult(
          userId,
          0,
          state.cpuAvailable,
          'Script execution has been terminated: CPU bucket is empty',
          false,
          false,
        );
      }
      cpuBucket = state.cpuAvailable;
      cpu = Math.min(cpuBucket + shardCpu, this.#cpuMaxPerTick);
      if (cpu <= 0) {
        // Only reachable with an explicit zero shard allocation and an empty bucket: upstream's
        // script timeout treats 0 as "no limit", so such a run must not start at all.
        return emptyResult(
          userId,
          cpu,
          cpuBucket,
          'Script execution has been terminated: CPU bucket is empty',
          false,
          false,
        );
      }
    }

    const data: RuntimeData | undefined = buildRuntimeData(
      world,
      worldIndex,
      userId,
      {
        modules: state.modules,
        codeTimestamp: state.codeTimestamp,
        memory: state.memory,
        consoleCommands: state.consoleCommands,
        activeSegments: state.activeSegments,
        segments: state.segments,
        activeForeignSegment: state.activeForeignSegment,
        customObjectPrototypes: this.#customObjectPrototypes,
        account: this.#accountData(world, userId, userDoc.cpu, now),
      },
      cpu,
      cpuBucket,
      this.#publicSegments,
    );
    if (!data) {
      return undefined;
    }
    if (this.#games) {
      data.games = this.#games;
    }
    if (explicitCpu !== undefined) {
      // `Game.cpu.limit` is the shard limit assigned with `setShardLimits`.
      data.user = { ...data.user, cpu: explicitCpu };
    }
    state.consoleCommands = [];

    const terrain = this.#terrainPack(world);
    let reset = false;
    let sandbox: PlayerSandbox | undefined;
    let message: SandboxRunMessage;
    let cpuTime: number;
    try {
      const acquired = await this.#sandbox(userId, state.codeTimestamp, terrain);
      sandbox = acquired.sandbox;
      reset = acquired.reset;
      // `cpu`/`cpuBucket` may be Infinity, which JSON cannot carry; they are passed separately.
      const payload = JSON.stringify({ ...data, cpu: 0, cpuBucket: 0 });
      const output = await this.#runWithHardTimeout(userId, sandbox, payload, cpu, cpuBucket);
      if (sandbox.haltRequested) {
        throw new Error('CPU halted');
      }
      const result = parseSandboxResult(output.result);
      if ('invalid' in result) {
        this.#clear(userId);
        return emptyResult(
          userId,
          cpu,
          cpuBucket,
          `Script execution has been terminated: invalid runtime result (${result.invalid}), restarting virtual machine`,
          reset,
          false,
        );
      }
      if (result.type === 'fatal') {
        return emptyResult(userId, cpu, cpuBucket, result.error, reset, false);
      }
      message = result;
      cpuTime = output.cpuTime;
    } catch (error) {
      const halted = sandbox?.haltRequested ?? false;
      const text = halted ? 'CPU halted' : errorMessage(error);
      if (
        halted ||
        /Isolate is disposed/.test(text) ||
        /Isolate has exhausted v8 heap space/.test(text)
      ) {
        this.#clear(userId);
      }
      if (!halted && /Array buffer allocation failed/.test(text)) {
        this.#clear(userId);
        return emptyResult(
          userId,
          cpu,
          cpuBucket,
          'Script execution has been terminated: unable to allocate memory, restarting virtual machine',
          reset,
          false,
        );
      }
      return emptyResult(userId, cpu, cpuBucket, text, reset, halted);
    }

    let intents: StoredUserIntents;
    try {
      intents = storeIntents(
        message.intentsList,
        (objectId) => data.userObjects[objectId]?.room ?? data.roomObjects[objectId]?.room,
        this.#customIntentTypes,
      );
    } catch (error) {
      return emptyResult(userId, cpu, cpuBucket, errorMessage(error), reset, false);
    }
    // Bucket charge (driver make.js): clean time plus 0.2 per counted intent.
    const cpuUsed = Math.ceil(cpuTime + 0.2 * intentsCount(message.intentsList));
    // Reported usage (driver `usedTime`): clean time plus the sandbox's running intent accumulator.
    const reportedCpu = Math.ceil(cpuTime + message.intentsCpu);

    // Account intents are re-validated against host state (the sandbox is untrusted).
    const pixels = limitGlobalIntents(
      intents,
      'generatePixel',
      Number.isFinite(cpuBucket) ? Math.floor(cpuBucket / C.PIXEL_CPU_COST) : Infinity,
    );
    limitGlobalIntents(
      intents,
      'unlockCpu',
      userDoc.cpuSubscription ? 0 : (userDoc.resources?.[C.CPU_UNLOCK] ?? 0),
    );
    limitGlobalIntents(
      intents,
      'activateAccess',
      world.restrictedShard && !userDoc.shardAccessUnlimited
        ? (userDoc.resources?.[C.ACCESS_KEY] ?? 0)
        : 0,
    );

    if (message.activeSegments) {
      state.activeSegments = message.activeSegments;
    }
    if (message.defaultPublicSegment !== undefined) {
      state.defaultPublicSegment = message.defaultPublicSegment;
    }
    if (limited) {
      state.cpuAvailable = Math.min(
        state.cpuAvailable + shardCpu - cpuUsed - pixels * C.PIXEL_CPU_COST,
        this.#cpuBucketSize,
      );
    }
    if (message.activeForeignSegment !== undefined) {
      this.#applyForeignSegment(world, state, message.activeForeignSegment);
    }
    if (message.publicSegments !== undefined) {
      state.publicSegments = message.publicSegments;
    }
    if (message.interShardLocal !== undefined) {
      this.#interShard.setData(shard, userId, message.interShardLocal);
    }
    if (message.interShardSegment !== undefined) {
      this.#interShard.setSegment(userId, message.interShardSegment);
    }
    if (message.shardLimits !== undefined) {
      this.#applyShardLimits(userId, message.shardLimits, now);
    }

    const memoryRejected = message.memory.length > MEMORY_LIMIT;
    if (!memoryRejected) {
      state.memory = message.memory;
    }
    if (message.memorySegments) {
      for (const [key, value] of Object.entries(message.memorySegments)) {
        state.segments[Number(key)] = value;
      }
    }

    const result: UserRunResult = {
      userId,
      intents,
      console: { log: message.console.log, results: message.console.results },
      visual: message.visual ?? {},
      cpu: { used: reportedCpu, charged: cpuUsed, limit: cpu, bucket: state.cpuAvailable },
      memorySize: message.memory.length,
      memoryRejected,
      reset,
      halted: false,
    };
    if (message.error !== undefined) {
      result.console.error = message.error;
    }
    return result;
  }

  /** Applies a `setShardLimits` request after re-checking cooldown, shards and total. */
  #applyShardLimits(userId: string, requested: Record<string, number>, now: number): void {
    const current = this.#interShard.getShardLimits(userId);
    if (now < current.cooldownTime) {
      return;
    }
    const keys = Object.keys(current.limits);
    const total = (limits: Record<string, number>): number =>
      Object.values(limits).reduce((a, b) => a + b, 0);
    if (
      Object.keys(requested).length !== keys.length ||
      !keys.every((key) => key in requested) ||
      total(requested) !== total(current.limits)
    ) {
      return;
    }
    this.#interShard.setShardLimits(userId, requested, now);
  }

  async #runWithHardTimeout(
    userId: string,
    sandbox: PlayerSandbox,
    data: string,
    cpu: number,
    cpuBucket: number,
  ): Promise<{ result: unknown; cpuTime: number }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hardTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.#clear(userId);
        reject(new Error('Script execution timed out ungracefully, restarting virtual machine'));
      }, this.#hardTimeoutMs);
    });
    try {
      return await Promise.race([
        sandbox.run({ data, cpu, cpuBucket }, this.#hardTimeoutMs),
        hardTimeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #applyForeignSegment(
    world: Readonly<WorldState>,
    state: RuntimeUserSnapshot,
    requested: { username: unknown; id: number | undefined } | null,
  ): void {
    if (requested === null) {
      delete state.activeForeignSegment;
      return;
    }
    const username = String(requested.username);
    const current = state.activeForeignSegment;
    if (current && username == current.username && requested.id) {
      current.id = requested.id;
      return;
    }
    const selection: ForeignSegmentSelection = { username };
    if (requested.id !== undefined) {
      selection.id = requested.id;
    }
    const target = Object.values(world.users).find((user) => user.username === username);
    if (target) {
      selection.userId = target._id;
      const defaultSegment = this.#users[target._id]?.defaultPublicSegment;
      if (!selection.id && defaultSegment) {
        selection.id = defaultSegment;
      }
    }
    state.activeForeignSegment = selection;
  }

  /**
   * Runs every player that has code, in parallel isolates, against the same world state. One
   * player's failure (including runtime-host errors) is reported in its result and never prevents
   * the other players from running.
   */
  async runTick(world: Readonly<WorldState>): Promise<TickRunResult> {
    this.#assertActive();
    const index = buildWorldIndex(world, this.#now());
    // Driver `getAllUsers`: users with `active != 0` and a positive CPU allocation on this shard.
    const userIds = Object.keys(this.#users).filter((id) => {
      const userDoc = world.users[id];
      const shardCpu = this.#interShard.explicitLimit(id, world.shardName) ?? userDoc?.cpu;
      return (
        Object.keys(this.#users[id]?.modules ?? {}).length > 0 &&
        userDoc !== undefined &&
        userDoc.active !== 0 &&
        typeof shardCpu === 'number' &&
        shardCpu > 0
      );
    });
    const settled = await Promise.allSettled(userIds.map((id) => this.runUser(world, id, index)));
    const tick: TickRunResult = { intents: {}, users: {} };
    settled.forEach((outcome, i) => {
      const userId = userIds[i];
      if (userId === undefined) {
        return;
      }
      const result =
        outcome.status === 'fulfilled'
          ? outcome.value
          : emptyResult(
              userId,
              0,
              this.#users[userId]?.cpuAvailable ?? 0,
              errorMessage(outcome.reason),
              false,
              false,
            );
      if (result) {
        tick.users[userId] = result;
        tick.intents[userId] = result.intents;
      }
    });
    return tick;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const userId of Object.keys(this.#sandboxes)) {
      this.#clear(userId);
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
