/*
 * Room processor processes (launcher `processors_cnt`): rooms of a tick are processed concurrently
 * from independent snapshots, like the upstream processors popping the rooms queue. The world owner
 * applies the recorded results once every room finished (`Simulation.tickAsync`).
 */

import { defaultConstants, type Constants } from '../constants.ts';
import type { RoomJob, RoomJobEnv, RoomJobOutcome } from '../simulation/room-job.ts';
import { WorkerPool, type WorkerPoolOptions, type WorkerProcess } from './pool.ts';
import type { ProcessorJobBody } from './protocol.ts';

export type ProcessorPoolOptions = WorkerPoolOptions;

/** The rooms of one tick of one world. */
export interface RoomBatch {
  /** Version of `terrain`; processors reload pathfinding terrain when it changes. */
  terrainVersion: number;
  terrain: Readonly<Record<string, string>>;
  constants: Constants;
  env: RoomJobEnv;
  jobs: ReadonlyArray<{ job: RoomJob; rngSeed: number }>;
}

/** Room processing of one world (`SimulationOptions.processors`). */
export interface RoomProcessor {
  /**
   * Processes every job; outcomes are in job order. A room whose processor process exits while
   * processing it is retried once and then fails with the exit reason; rooms the process had not
   * started yet are moved to other processes. Rejects when the pool closes or no processor process
   * can start.
   */
  process(batch: RoomBatch): Promise<RoomJobOutcome[]>;
}

interface BatchState {
  owner: number;
  batch: RoomBatch;
  outcomes: RoomJobOutcome[];
  remaining: number;
  settled: boolean;
  resolve(outcomes: RoomJobOutcome[]): void;
  reject(error: Error): void;
}

interface PendingJob {
  state: BatchState;
  index: number;
  /** Processes that exited while processing this room. */
  crashes: number;
}

/** Jobs sent ahead to a processor process, so it never idles waiting for the next room. */
const PREFETCH = 2;
/** Processor exits a room may cause before it is reported as failed. */
const MAX_CRASHES = 2;

export class ProcessorPool extends WorkerPool {
  #queue: PendingJob[] = [];
  readonly #batches = new Set<BatchState>();
  /** Jobs sent to each process, in the order it processes them. */
  readonly #inFlight = new Map<WorkerProcess, PendingJob[]>();
  /** Terrain and constants context each process holds. */
  readonly #contexts = new Map<WorkerProcess, string>();
  #nextOwner = 1;

  constructor(options: ProcessorPoolOptions) {
    super('processor', options);
    this.start();
  }

  /** Opens room processing for one world. */
  openProcessor(): RoomProcessor {
    const owner = this.#nextOwner++;
    return {
      process: (batch) => this.#process(owner, batch),
    };
  }

  #process(owner: number, batch: RoomBatch): Promise<RoomJobOutcome[]> {
    if (this.closed) {
      return Promise.reject(new Error('Processor pool is closed'));
    }
    if (batch.jobs.length === 0) {
      return Promise.resolve([]);
    }
    const { promise, resolve, reject } = Promise.withResolvers<RoomJobOutcome[]>();
    const state: BatchState = {
      owner,
      batch,
      outcomes: [],
      remaining: batch.jobs.length,
      settled: false,
      resolve,
      reject,
    };
    this.#batches.add(state);
    for (let index = 0; index < batch.jobs.length; index++) {
      this.#queue.push({ state, index, crashes: 0 });
    }
    this.#pumpAll();
    return promise;
  }

  #pumpAll(): void {
    for (const worker of this.liveWorkers) {
      this.#pump(worker);
    }
  }

  #pump(worker: WorkerProcess): void {
    if (worker.state !== 'ready') {
      return;
    }
    let jobs = this.#inFlight.get(worker);
    if (!jobs) {
      jobs = [];
      this.#inFlight.set(worker, jobs);
    }
    while (this.#queue.length && jobs.length < PREFETCH) {
      const pending = this.#queue.shift() as PendingJob;
      if (!pending.state.settled) {
        jobs.push(pending);
        this.#dispatch(worker, pending);
      }
    }
  }

  #dispatch(worker: WorkerProcess, pending: PendingJob): void {
    const { state, index } = pending;
    const { batch } = state;
    const entry = batch.jobs[index] as RoomBatch['jobs'][number];
    const context = `${String(state.owner)}:${String(batch.terrainVersion)}`;
    const body: ProcessorJobBody = {
      context,
      env: batch.env,
      rngSeed: entry.rngSeed,
      job: entry.job,
    };
    if (this.#contexts.get(worker) !== context) {
      body.load = {
        terrain: batch.terrain,
        constants: batch.constants === defaultConstants ? null : batch.constants,
      };
      this.#contexts.set(worker, context);
    }
    this.request(worker, body)
      .then(
        (outcome) => {
          if (this.#take(worker, pending)) {
            this.#complete(pending, outcome as RoomJobOutcome);
          }
        },
        (error: unknown) => {
          // An exited process's jobs were handled by `onExit`; this one could not be sent.
          if (this.#take(worker, pending)) {
            this.#requeue([pending], error instanceof Error ? error.message : String(error));
          }
        },
      )
      .finally(() => {
        this.#pumpAll();
      });
  }

  /** Removes a job from the process's jobs in flight; false when it was already removed. */
  #take(worker: WorkerProcess, pending: PendingJob): boolean {
    const jobs = this.#inFlight.get(worker);
    const position = jobs?.indexOf(pending) ?? -1;
    if (position === -1) {
      return false;
    }
    jobs?.splice(position, 1);
    return true;
  }

  /** Requeues jobs in order; the first one counts as processed when the process failed. */
  #requeue(jobs: readonly PendingJob[], reason: string): void {
    const retry: PendingJob[] = [];
    jobs.forEach((pending, position) => {
      if (pending.state.settled) {
        return;
      }
      if (position === 0) {
        pending.crashes++;
      }
      if (pending.crashes < MAX_CRASHES) {
        retry.push(pending);
        return;
      }
      const entry = pending.state.batch.jobs[pending.index] as RoomBatch['jobs'][number];
      this.#complete(pending, {
        effects: [],
        stats: {},
        error: `${reason} while processing room ${entry.job.roomName}`,
      });
    });
    this.#queue.unshift(...retry);
  }

  #complete(pending: PendingJob, outcome: RoomJobOutcome): void {
    const { state } = pending;
    if (state.settled) {
      return;
    }
    state.outcomes[pending.index] = outcome;
    state.remaining--;
    if (state.remaining === 0) {
      state.settled = true;
      this.#batches.delete(state);
      state.resolve(state.outcomes);
    }
  }

  #failAll(error: Error): void {
    for (const state of this.#batches) {
      state.settled = true;
      state.reject(error);
    }
    this.#batches.clear();
    this.#queue = [];
  }

  protected override onReady(worker: WorkerProcess): void {
    this.#pump(worker);
  }

  protected override onExit(worker: WorkerProcess, reason: string, started: boolean): void {
    // A process handles its jobs one at a time in order: only the oldest one was being processed.
    const jobs = this.#inFlight.get(worker) ?? [];
    this.#inFlight.delete(worker);
    this.#contexts.delete(worker);
    if (this.closed) {
      return;
    }
    this.#requeue(jobs, reason);
    if (!started && !this.liveWorkers.some((live) => live.state === 'ready')) {
      // No processor can take rooms: fail the waiting ticks instead of stalling them.
      this.#failAll(new Error(`No processor process could start: ${reason}`));
      return;
    }
    this.#pumpAll();
  }

  protected override onDrain(): void {
    // Rooms are queued pool-wide; the replaced process only finishes the rooms it holds.
  }

  protected override onClose(): void {
    this.#failAll(new Error('Processor pool is closed'));
  }
}
