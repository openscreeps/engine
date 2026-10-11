/*
 * Messages between a worker pool and its supervised worker processes (upstream launcher
 * `engine_runnerN` / `engine_processorN` processes), and the setup contract of server mods loaded
 * inside every worker process.
 */

import type { Constants } from '../constants.ts';
import type { PlayerSandboxHook, SandboxRunInput, TerrainPack } from '../runtime/host/sandbox.ts';
import type { RoomJob, RoomJobEnv } from '../simulation/room-job.ts';
import type { SimulationHooks } from '../simulation/scope.ts';

export type WorkerKind = 'runner' | 'processor';

/** Module loaded in every worker process to install trusted extensions (server mods). */
export interface WorkerSetupModule {
  /** File URL or absolute path of an ES module whose default export is a `WorkerSetupFunction`. */
  module: string;
  /** Structured-cloneable value passed to the setup function. */
  data?: unknown;
}

/** The connection of a worker process to the process owning its pool. */
export interface WorkerHost {
  readonly kind: WorkerKind;
  /** Launcher-style process name, e.g. `engine_runner1`. */
  readonly name: string;
  /**
   * Calls the pool's `onCall` handler in the owning process; arguments and result are structured
   * clones. Rejects with the handler's error message, or when the pool closes or replaces this
   * process. Pending calls never keep a tick waiting.
   */
  call(method: string, ...args: unknown[]): Promise<unknown>;
  /** Receives the pool's `broadcast(event, data)` messages; returns the unsubscribe function. */
  on(event: string, listener: (data: unknown) => void): () => void;
}

/** A worker's call into the process owning its pool. */
export interface WorkerHostCall {
  kind: WorkerKind;
  /** Name of the calling process. */
  worker: string;
  method: string;
  args: unknown[];
}

/** Extensions installed by the setup module; each kind uses its own. */
export interface WorkerSetup {
  /** Runner processes: the `playerSandbox` hook of every player run. */
  playerSandbox?: PlayerSandboxHook;
  /** Processor processes: room processing hooks. */
  hooks?: SimulationHooks;
}

export type WorkerSetupFunction = (
  data: unknown,
  kind: WorkerKind,
  host: WorkerHost,
) => WorkerSetup | Promise<WorkerSetup>;

/** Pool to worker. */
export type ParentMessage =
  | { type: 'init'; kind: WorkerKind; name: string; setup?: WorkerSetupModule; bundle?: string }
  | { type: 'request'; id: number; body: unknown }
  | { type: 'notice'; body: unknown }
  | { type: 'event'; event: string; data: unknown }
  | { type: 'callResult'; id: number; ok: true; value: unknown }
  | { type: 'callResult'; id: number; ok: false; error: string };

/** Worker to pool. */
export type ChildMessage =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'response'; id: number; body: unknown }
  | { type: 'call'; id: number; method: string; args: unknown[] };

/** One player run in a runner process. */
export interface RunnerRunBody {
  owner: number;
  codeTimestamp: number;
  memoryLimitMb: number;
  hardTimeoutMs: number;
  /** Attached when the runner does not have the owner's current terrain version yet. */
  terrain?: TerrainPack;
  /** Attached with the owner's first run on the runner; `null` selects the default constants. */
  constants?: Constants | null;
  input: SandboxRunInput;
}

export type RunnerNotice =
  { type: 'clear'; owner: number; userId: string } | { type: 'release'; owner: number };

/** One room in a processor process. */
export interface ProcessorJobBody {
  /** Owner and terrain version the job's pathfinding terrain and constants belong to. */
  context: string;
  /** Attached when the processor does not hold `context` yet. */
  load?: { terrain: Readonly<Record<string, string>>; constants: Constants | null };
  env: RoomJobEnv;
  rngSeed: number;
  job: RoomJob;
}
