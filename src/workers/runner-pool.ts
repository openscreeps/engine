/*
 * Player runner processes (launcher `runners_cnt` processes running `runner_threads` concurrent
 * player runs each). The player runtime keeps all accounting in its own process; runner processes
 * only host the isolates. Every player stays on one runner, so its global environment lives across
 * ticks; it moves (with a global reset) only when its runner exits or is replaced.
 */

import { defaultConstants } from '../constants.ts';
import { getRuntimeBundle } from '../runtime/host/bundle.ts';
import type {
  SandboxHost,
  SandboxRunReply,
  SandboxRunRequest,
} from '../runtime/host/sandbox-host.ts';
import { WorkerPool, type WorkerPoolOptions, type WorkerProcess } from './pool.ts';
import type { ParentMessage, RunnerNotice, RunnerRunBody } from './protocol.ts';

export interface RunnerPoolOptions extends WorkerPoolOptions {
  /** Concurrent player runs per runner process (launcher `runner_threads`). */
  threads: number;
}

interface QueuedRun {
  owner: number;
  request: SandboxRunRequest;
  resolve(reply: SandboxRunReply): void;
}

/** What a runner process holds of one runtime. */
interface OwnerState {
  terrainVersion: number | undefined;
  constants: boolean;
}

/** Extra time a runner gets beyond twice the hard timeout before it counts as unresponsive. */
const WATCHDOG_GRACE_MS = 5000;

function failure(error: string): SandboxRunReply {
  return { ok: false, error, reset: false, haltRequested: false };
}

export class RunnerPool extends WorkerPool {
  readonly #threads: number;
  /** Open runtimes: owner -> player -> runner holding the player's isolate. */
  readonly #affinity = new Map<number, Map<string, WorkerProcess>>();
  readonly #assigned = new Map<WorkerProcess, number>();
  readonly #queues = new Map<WorkerProcess, QueuedRun[]>();
  readonly #active = new Map<WorkerProcess, number>();
  readonly #owners = new Map<WorkerProcess, Map<number, OwnerState>>();
  /** Runs waiting for any runner process to start. */
  #waiting: QueuedRun[] = [];
  #nextOwner = 1;

  constructor(options: RunnerPoolOptions) {
    super('runner', options);
    if (!Number.isInteger(options.threads) || options.threads < 1) {
      throw new RangeError(`threads must be a positive integer, got ${String(options.threads)}`);
    }
    this.#threads = options.threads;
    this.start();
  }

  protected override async initPayload(): Promise<
    Partial<Extract<ParentMessage, { type: 'init' }>>
  > {
    return { bundle: await getRuntimeBundle() };
  }

  /** Opens the isolate namespace of one player runtime (`BotRuntimeOptions.runners`). */
  openHost(): SandboxHost {
    const owner = this.#nextOwner++;
    this.#affinity.set(owner, new Map());
    return {
      run: (request) => this.#run(owner, request),
      clear: (userId) => {
        this.#clear(owner, userId);
      },
      dispose: () => {
        this.#release(owner);
      },
    };
  }

  #run(owner: number, request: SandboxRunRequest): Promise<SandboxRunReply> {
    if (this.closed) {
      return Promise.resolve(failure('Runner pool is closed'));
    }
    if (!this.#affinity.has(owner)) {
      return Promise.resolve(failure('BotRuntime is disposed'));
    }
    const { promise, resolve } = Promise.withResolvers<SandboxRunReply>();
    this.#schedule({ owner, request, resolve });
    return promise;
  }

  #schedule(run: QueuedRun): void {
    const users = this.#affinity.get(run.owner);
    if (!users) {
      run.resolve(failure('BotRuntime is disposed'));
      return;
    }
    const { userId } = run.request.input;
    let worker = users.get(userId);
    if (worker?.state !== 'starting' && worker?.state !== 'ready') {
      worker = this.#leastLoaded();
      if (!worker) {
        this.#waiting.push(run);
        return;
      }
      users.set(userId, worker);
      this.#assigned.set(worker, (this.#assigned.get(worker) ?? 0) + 1);
    }
    let queue = this.#queues.get(worker);
    if (!queue) {
      queue = [];
      this.#queues.set(worker, queue);
    }
    queue.push(run);
    this.#pump(worker);
  }

  #leastLoaded(): WorkerProcess | undefined {
    let best: WorkerProcess | undefined;
    for (const worker of this.liveWorkers) {
      if (!best || (this.#assigned.get(worker) ?? 0) < (this.#assigned.get(best) ?? 0)) {
        best = worker;
      }
    }
    return best;
  }

  #pump(worker: WorkerProcess): void {
    if (worker.state !== 'ready') {
      return;
    }
    const queue = this.#queues.get(worker);
    while (queue?.length && (this.#active.get(worker) ?? 0) < this.#threads) {
      this.#dispatch(worker, queue.shift() as QueuedRun);
    }
  }

  #dispatch(worker: WorkerProcess, run: QueuedRun): void {
    const { owner, request } = run;
    let owners = this.#owners.get(worker);
    if (!owners) {
      owners = new Map();
      this.#owners.set(worker, owners);
    }
    let state = owners.get(owner);
    if (!state) {
      state = { terrainVersion: undefined, constants: false };
      owners.set(owner, state);
    }
    const body: RunnerRunBody = {
      owner,
      codeTimestamp: request.codeTimestamp,
      memoryLimitMb: request.memoryLimitMb,
      hardTimeoutMs: request.hardTimeoutMs,
      input: request.input,
    };
    if (state.terrainVersion !== request.terrain.version) {
      body.terrain = request.terrain;
      state.terrainVersion = request.terrain.version;
    }
    if (!state.constants) {
      body.constants = request.constants === defaultConstants ? null : request.constants;
      state.constants = true;
    }
    this.#active.set(worker, (this.#active.get(worker) ?? 0) + 1);
    const deadline = request.hardTimeoutMs * 2 + WATCHDOG_GRACE_MS;
    const watchdog = setTimeout(() => {
      this.terminate(
        worker,
        `${worker.name} did not finish a player run within ${String(deadline)} ms`,
      );
    }, deadline);
    this.request(worker, body)
      .then(
        (reply) => {
          run.resolve(reply as SandboxRunReply);
        },
        (error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          run.resolve(
            failure(`Script execution has been terminated: ${reason}, restarting virtual machine`),
          );
        },
      )
      .finally(() => {
        clearTimeout(watchdog);
        if (worker.state !== 'exited') {
          this.#active.set(worker, (this.#active.get(worker) ?? 1) - 1);
          this.#pump(worker);
        }
      });
  }

  #clear(owner: number, userId: string): void {
    const worker = this.#affinity.get(owner)?.get(userId);
    if (worker) {
      this.notify(worker, { type: 'clear', owner, userId } satisfies RunnerNotice);
    }
  }

  #release(owner: number): void {
    const users = this.#affinity.get(owner);
    if (!users) {
      return;
    }
    this.#affinity.delete(owner);
    for (const worker of users.values()) {
      this.#assigned.set(worker, (this.#assigned.get(worker) ?? 1) - 1);
    }
    for (const [worker, owners] of this.#owners) {
      if (owners.delete(owner)) {
        this.notify(worker, { type: 'release', owner } satisfies RunnerNotice);
      }
    }
    const disposed = (run: QueuedRun): boolean => {
      if (run.owner !== owner) {
        return true;
      }
      run.resolve(failure('BotRuntime is disposed'));
      return false;
    };
    for (const [worker, queue] of this.#queues) {
      this.#queues.set(worker, queue.filter(disposed));
    }
    this.#waiting = this.#waiting.filter(disposed);
  }

  /** Moves every player of `worker` off it; its queued runs go to other runners. */
  #evict(worker: WorkerProcess): QueuedRun[] {
    for (const users of this.#affinity.values()) {
      for (const [userId, holder] of users) {
        if (holder === worker) {
          users.delete(userId);
        }
      }
    }
    this.#assigned.delete(worker);
    const queued = this.#queues.get(worker) ?? [];
    this.#queues.delete(worker);
    return queued;
  }

  protected override onReady(worker: WorkerProcess): void {
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const run of waiting) {
      this.#schedule(run);
    }
    this.#pump(worker);
  }

  protected override onExit(worker: WorkerProcess, reason: string, started: boolean): void {
    const queued = this.#evict(worker);
    this.#owners.delete(worker);
    this.#active.delete(worker);
    if (this.closed) {
      return;
    }
    if (started || this.liveWorkers.some((live) => live.state === 'ready')) {
      // These runs never reached the process: they start on another runner (global reset).
      for (const run of queued) {
        this.#schedule(run);
      }
      return;
    }
    // No runner can take runs: fail them instead of stalling the tick until one starts.
    const failed = failure(`Script execution has been terminated: ${reason}`);
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const run of [...queued, ...waiting]) {
      run.resolve(failed);
    }
  }

  protected override onDrain(worker: WorkerProcess): void {
    for (const run of this.#evict(worker)) {
      this.#schedule(run);
    }
  }

  protected override onClose(): void {
    const closed = failure('Runner pool is closed');
    for (const queue of this.#queues.values()) {
      for (const run of queue) {
        run.resolve(closed);
      }
    }
    this.#queues.clear();
    for (const run of this.#waiting) {
      run.resolve(closed);
    }
    this.#waiting = [];
  }
}
