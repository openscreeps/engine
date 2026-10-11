/*
 * Supervision of worker processes, replicating the launcher's process management (screeps launcher
 * `lib/start.js`): a fixed number of named processes (`engine_runner1`, `engine_processor1`, ...)
 * restarted after they exit (1 s later, or immediately when deliberately terminated) and replaced
 * every `restart_interval`. Unlike the launcher, a replaced process first finishes its requests.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  ChildMessage,
  ParentMessage,
  WorkerHostCall,
  WorkerKind,
  WorkerSetupModule,
} from './protocol.ts';

export interface WorkerPoolOptions {
  /** Number of worker processes (launcher `runners_cnt` / `processors_cnt`). */
  processes: number;
  /**
   * Replace every process this long after it started (launcher `restart_interval` in seconds times
   * 1000); a replaced process stops taking work and exits once its requests finished. Absent or 0:
   * never.
   */
  restartIntervalMs?: number;
  /** Server mod setup loaded in every worker process. */
  setup?: WorkerSetupModule;
  /**
   * Serves `WorkerHost.call` from worker processes. Runs while ticks await worker results, so it
   * must not wait for the completion of the running tick.
   */
  onCall?: (call: WorkerHostCall) => unknown;
  /** Process lifecycle and output notifications (launcher log lines). */
  onEvent?: (event: WorkerEvent) => void;
  /**
   * `inherit` (default): worker stdout/stderr are this process's; `events`: delivered as `output`
   * events (e.g. for per-process log files like the launcher's).
   */
  output?: 'inherit' | 'events';
}

export type WorkerEvent =
  | { type: 'started'; name: string; pid: number }
  | { type: 'ready'; name: string; pid: number }
  | { type: 'recycling'; name: string; pid: number }
  | { type: 'failed'; name: string; pid: number | undefined; error: string }
  | {
      type: 'exited';
      name: string;
      pid: number | undefined;
      code: number | null;
      signal: string | null;
      /** A replacement process will be started in this process's place. */
      restarting: boolean;
    }
  | { type: 'output'; name: string; pid: number; stream: 'stdout' | 'stderr'; text: string };

export interface WorkerStatus {
  name: string;
  pid: number | undefined;
  /** `draining`: replaced, finishing its requests before it exits. */
  state: 'starting' | 'ready' | 'draining';
  /** Processes started in this process's place since the pool started. */
  restarts: number;
  /** Requests in flight. */
  pending: number;
}

/** Delay of the launcher before it restarts a process that exited on its own. */
const RESTART_DELAY_MS = 1000;

interface PendingRequest {
  resolve(body: unknown): void;
  reject(error: Error): void;
}

/** One supervised worker process. */
export class WorkerProcess {
  readonly name: string;
  readonly slot: number;
  readonly child: ChildProcess;
  state: 'starting' | 'ready' | 'draining' | 'exited' = 'starting';
  readonly pending = new Map<number, PendingRequest>();
  /** Why the pool terminated the process, reported instead of its exit code. */
  failure: string | undefined;
  /** The pool terminated the process (restart without delay). */
  terminated = false;
  recycleTimer: NodeJS.Timeout | undefined;
  readonly exited: Promise<void>;
  readonly markExited: () => void;

  constructor(name: string, slot: number, child: ChildProcess) {
    this.name = name;
    this.slot = slot;
    this.child = child;
    const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
    this.exited = promise;
    this.markExited = resolve;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workerEntry(): string {
  for (const candidate of ['./worker-process.ts', './worker-process.js']) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error('Worker entry (workers/worker-process.ts or .js) was not found');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/** Carry the host's module loaders, but not test, eval, inspector or entry-point arguments. */
function workerExecArgv(): string[] {
  const result = ['--no-node-snapshot'];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index];
    if (
      !argument ||
      !/^(?:--import|--require|--loader|--experimental-loader|-r)(?:=|$)/.test(argument)
    )
      continue;
    result.push(argument);
    if (!argument.includes('=')) {
      const value = process.execArgv[++index];
      if (value !== undefined) result.push(value);
    }
  }
  return result;
}

/** Ignores asynchronous IPC send failures: the exit of the process reports them. */
function ignoreSendError(): void {}

export abstract class WorkerPool implements AsyncDisposable {
  readonly #kind: WorkerKind;
  readonly #processes: number;
  readonly #restartIntervalMs: number;
  readonly #options: WorkerPoolOptions;
  readonly #entry = workerEntry();
  readonly #execArgv = workerExecArgv();
  /** Current process of each slot (`undefined` while a restart is pending). */
  readonly #slots: Array<WorkerProcess | undefined> = [];
  readonly #restartTimers: Array<NodeJS.Timeout | undefined> = [];
  readonly #restarts: number[] = [];
  /** Every live process, including replaced ones that are draining. */
  readonly #workers = new Set<WorkerProcess>();
  #nextRequest = 1;
  #closed = false;

  protected constructor(kind: WorkerKind, options: WorkerPoolOptions) {
    this.#kind = kind;
    this.#processes = positiveInteger(options.processes, 'processes');
    const restartIntervalMs = options.restartIntervalMs ?? 0;
    if (!Number.isFinite(restartIntervalMs) || restartIntervalMs < 0) {
      throw new RangeError(`restartIntervalMs must be a non-negative number`);
    }
    this.#restartIntervalMs = restartIntervalMs;
    this.#options = { ...options };
  }

  /** Starts the processes; subclasses call it once their own state is initialized. */
  protected start(): void {
    for (let slot = 0; slot < this.#processes; slot++) {
      this.#restarts[slot] = 0;
      this.#slots[slot] = this.#spawn(slot);
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Current processes of all slots that are starting or ready, in slot order. */
  protected get liveWorkers(): WorkerProcess[] {
    return this.#slots.filter(
      (worker): worker is WorkerProcess =>
        worker !== undefined && (worker.state === 'starting' || worker.state === 'ready'),
    );
  }

  /** Extra fields of the init message (e.g. the runtime bundle). */
  protected initPayload(): Promise<Partial<Extract<ParentMessage, { type: 'init' }>>> {
    return Promise.resolve({});
  }

  /** The process is ready for requests. */
  protected abstract onReady(worker: WorkerProcess): void;
  /** The process exited; its pending requests were rejected. `started`: it had become ready. */
  protected abstract onExit(worker: WorkerProcess, reason: string, started: boolean): void;
  /** The process was replaced and takes no new work; its requests in flight finish. */
  protected abstract onDrain(worker: WorkerProcess): void;
  /** The pool closed: settle queued work. */
  protected abstract onClose(): void;

  status(): WorkerStatus[] {
    return [...this.#workers]
      .filter((worker) => worker.state !== 'exited')
      .sort((a, b) => a.slot - b.slot)
      .map((worker) => ({
        name: worker.name,
        pid: worker.child.pid,
        state: worker.state as WorkerStatus['state'],
        restarts: this.#restarts[worker.slot] ?? 0,
        pending: worker.pending.size,
      }));
  }

  /** Delivers `data` to every `WorkerHost.on(event)` listener of every live process. */
  broadcast(event: string, data: unknown): void {
    for (const worker of this.#workers) {
      if (worker.state === 'ready' || worker.state === 'draining') {
        this.#send(worker, { type: 'event', event, data });
      }
    }
  }

  /** Sends a request; rejects when the process exits or the request cannot be sent. */
  protected request(worker: WorkerProcess, body: unknown): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const id = this.#nextRequest++;
    worker.pending.set(id, { resolve, reject });
    try {
      worker.child.send({ type: 'request', id, body } satisfies ParentMessage, ignoreSendError);
    } catch (error) {
      worker.pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      this.#checkDrained(worker);
    }
    return promise;
  }

  /** Sends a one-way message to a ready or draining process. */
  protected notify(worker: WorkerProcess, body: unknown): void {
    if (worker.state === 'ready' || worker.state === 'draining') {
      this.#send(worker, { type: 'notice', body });
    }
  }

  /** Kills an unresponsive process; its pending requests fail with `reason`. */
  protected terminate(worker: WorkerProcess, reason: string): void {
    if (worker.state === 'exited') {
      return;
    }
    worker.failure ??= reason;
    this.#emit({ type: 'failed', name: worker.name, pid: worker.child.pid, error: reason });
    this.#kill(worker, 'SIGKILL');
  }

  #send(worker: WorkerProcess, message: ParentMessage): boolean {
    if (worker.state === 'exited' || !worker.child.connected) {
      return false;
    }
    try {
      worker.child.send(message, ignoreSendError);
      return true;
    } catch {
      return false;
    }
  }

  #kill(worker: WorkerProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    worker.terminated = true;
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill(signal);
    }
  }

  #emit(event: WorkerEvent): void {
    this.#options.onEvent?.(event);
  }

  #spawn(slot: number): WorkerProcess {
    const name = `engine_${this.#kind}${String(slot + 1)}`;
    const events = this.#options.output === 'events';
    const child = fork(this.#entry, [], {
      // isolated-vm needs the startup snapshot disabled (the launcher passes the same flag).
      execArgv: this.#execArgv,
      serialization: 'advanced',
      stdio: events ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    });
    const worker = new WorkerProcess(name, slot, child);
    this.#workers.add(worker);
    // `close` follows `exit` once the IPC channel and pipes are drained, so every response the
    // process sent before it died has been received.
    child.on('close', (code, signal) => {
      this.#exited(worker, code, signal);
    });
    child.on('error', (error) => {
      this.#emit({ type: 'failed', name, pid: child.pid, error: error.message });
      if (child.pid === undefined) {
        worker.failure ??= `${name} could not be started: ${error.message}`;
        this.#exited(worker, null, null);
      }
    });
    child.on('message', (message) => {
      this.#received(worker, message as ChildMessage);
    });
    if (events) {
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream]?.setEncoding('utf8').on('data', (text: string) => {
          this.#emit({ type: 'output', name, pid: child.pid ?? 0, stream, text });
        });
      }
    }
    if (child.pid !== undefined) {
      this.#emit({ type: 'started', name, pid: child.pid });
    }
    void this.#initialize(worker);
    return worker;
  }

  async #initialize(worker: WorkerProcess): Promise<void> {
    let payload: Partial<Extract<ParentMessage, { type: 'init' }>>;
    try {
      payload = await this.initPayload();
    } catch (error) {
      this.terminate(worker, `${worker.name} could not be initialized: ${messageOf(error)}`);
      return;
    }
    const init: Extract<ParentMessage, { type: 'init' }> = {
      ...payload,
      type: 'init',
      kind: this.#kind,
      name: worker.name,
    };
    if (this.#options.setup) {
      init.setup = this.#options.setup;
    }
    if (worker.state === 'starting' && !this.#send(worker, init)) {
      this.terminate(worker, `${worker.name} could not be initialized`);
    }
  }

  #received(worker: WorkerProcess, message: ChildMessage): void {
    switch (message.type) {
      case 'ready': {
        if (worker.state !== 'starting') {
          return;
        }
        worker.state = 'ready';
        this.#emit({ type: 'ready', name: worker.name, pid: worker.child.pid ?? 0 });
        if (this.#restartIntervalMs > 0) {
          worker.recycleTimer = setTimeout(() => {
            this.#recycle(worker);
          }, this.#restartIntervalMs);
          worker.recycleTimer.unref();
        }
        this.onReady(worker);
        return;
      }
      case 'failed': {
        worker.failure ??= `${worker.name} setup failed: ${message.error}`;
        this.#emit({
          type: 'failed',
          name: worker.name,
          pid: worker.child.pid,
          error: message.error,
        });
        return;
      }
      case 'response': {
        const pending = worker.pending.get(message.id);
        if (pending) {
          worker.pending.delete(message.id);
          pending.resolve(message.body);
          this.#checkDrained(worker);
        }
        return;
      }
      case 'call': {
        void this.#serveCall(worker, message);
        return;
      }
    }
  }

  async #serveCall(
    worker: WorkerProcess,
    message: Extract<ChildMessage, { type: 'call' }>,
  ): Promise<void> {
    let reply: ParentMessage;
    try {
      const onCall = this.#options.onCall;
      if (!onCall) {
        throw new Error('The worker pool has no host call handler');
      }
      const value = await onCall({
        kind: this.#kind,
        worker: worker.name,
        method: message.method,
        args: message.args,
      });
      reply = { type: 'callResult', id: message.id, ok: true, value };
    } catch (error) {
      reply = { type: 'callResult', id: message.id, ok: false, error: messageOf(error) };
    }
    if (!this.#send(worker, reply) && reply.ok) {
      this.#send(worker, {
        type: 'callResult',
        id: message.id,
        ok: false,
        error: `The result of host call ${message.method} cannot be sent to the worker`,
      });
    }
  }

  /** Launcher `restart_interval`: a replacement takes over the slot; the old process drains. */
  #recycle(worker: WorkerProcess): void {
    if (this.#closed || worker.state !== 'ready') {
      return;
    }
    worker.state = 'draining';
    this.#emit({ type: 'recycling', name: worker.name, pid: worker.child.pid ?? 0 });
    if (this.#slots[worker.slot] === worker) {
      this.#restarts[worker.slot] = (this.#restarts[worker.slot] ?? 0) + 1;
      this.#slots[worker.slot] = this.#spawn(worker.slot);
    }
    this.onDrain(worker);
    this.#checkDrained(worker);
  }

  #checkDrained(worker: WorkerProcess): void {
    if (worker.state === 'draining' && worker.pending.size === 0) {
      this.#kill(worker);
    }
  }

  #exited(worker: WorkerProcess, code: number | null, signal: string | null): void {
    if (worker.state === 'exited') {
      return;
    }
    const started = worker.state !== 'starting';
    worker.state = 'exited';
    clearTimeout(worker.recycleTimer);
    this.#workers.delete(worker);
    const { slot } = worker;
    const restarting = !this.#closed && this.#slots[slot] === worker;
    this.#emit({
      type: 'exited',
      name: worker.name,
      pid: worker.child.pid,
      code,
      signal,
      restarting,
    });
    const reason =
      worker.failure ??
      `${worker.name} process ${String(worker.child.pid)} exited with ${
        signal ? `signal ${signal}` : `code ${String(code)}`
      }`;
    const error = new Error(reason);
    const pending = [...worker.pending.values()];
    worker.pending.clear();
    for (const request of pending) {
      request.reject(error);
    }
    if (restarting) {
      this.#slots[slot] = undefined;
      this.#restartTimers[slot] = setTimeout(
        () => {
          this.#restartTimers[slot] = undefined;
          if (!this.#closed) {
            this.#restarts[slot] = (this.#restarts[slot] ?? 0) + 1;
            this.#slots[slot] = this.#spawn(slot);
          }
        },
        worker.terminated ? 1 : RESTART_DELAY_MS,
      );
    }
    this.onExit(worker, reason, started);
    worker.markExited();
  }

  /**
   * Stops every process and settles queued work; resolves once all processes exited. Processes
   * also exit by themselves when this process disconnects or exits.
   */
  close(): Promise<void> {
    const workers = [...this.#workers];
    if (!this.#closed) {
      this.#closed = true;
      for (const timer of this.#restartTimers) {
        clearTimeout(timer);
      }
      this.onClose();
      for (const worker of workers) {
        this.#kill(worker);
      }
    }
    return Promise.all(workers.map((worker) => worker.exited)).then(() => undefined);
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
