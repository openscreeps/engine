/*
 * Where player isolates live. `LocalSandboxHost` keeps them in the current process (upstream
 * driver `user-vm.js`); a runner pool (`RunnerPool`) forwards the same requests to supervised runner
 * processes, each running a `LocalSandboxHost` (upstream `engine_runnerN` processes). Every run
 * resolves with a reply instead of rejecting, so failures cross process boundaries unchanged.
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { Constants } from '../../constants.ts';
import { getRuntimeBundle } from './bundle.ts';
import { createIsolatedVmSandbox } from './isolated-vm-sandbox.ts';
import type {
  PlayerSandbox,
  PlayerSandboxHook,
  SandboxRunInput,
  SandboxRunOutput,
  TerrainPack,
} from './sandbox.ts';

/** One player run (upstream `makeRuntime` from isolate acquisition to the run result). */
export interface SandboxRunRequest {
  /** Code version; a newer one replaces the player's isolate (global reset). */
  codeTimestamp: number;
  /** Base heap limit in MB of a newly created isolate. */
  memoryLimitMb: number;
  /** Wall-clock limit of the run; the isolate is disposed when it is exceeded. */
  hardTimeoutMs: number;
  terrain: TerrainPack;
  /** World constants evaluated into newly created isolates. */
  constants: Constants;
  input: SandboxRunInput;
}

/** Outcome of a run; `reset` reports that a new isolate (global reset) was created for it. */
export type SandboxRunReply =
  | { ok: true; output: SandboxRunOutput; reset: boolean; haltRequested: boolean }
  | { ok: false; error: string; reset: boolean; haltRequested: boolean };

export interface SandboxHost {
  /** Runs one player; runs of the same player must not overlap. Never rejects. */
  run(request: SandboxRunRequest): Promise<SandboxRunReply>;
  /** Disposes the player's isolate; its next run starts with a global reset. */
  clear(userId: string): void;
  /** Disposes every isolate of this host; later runs fail. */
  dispose(): void;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export interface LocalSandboxHostOptions {
  /** Runtime bundle source (default: built in this process). */
  bundle?: () => Promise<string>;
  /** Trusted `playerSandbox` hook called in every run (server mods). */
  playerSandbox?: PlayerSandboxHook | undefined;
}

// Synchronous trusted hooks block every runtime on this host thread, not only their own player.
// Exclude that interval from watchdogs; isolate calls made by a hook have their own V8 timeout.
let hookTime = 0;

/** Player isolates of one runtime in the current process. */
export class LocalSandboxHost implements SandboxHost {
  readonly #sandboxes = new Map<string, PlayerSandbox>();
  readonly #bundle: () => Promise<string>;
  readonly #hook: PlayerSandboxHook | undefined;
  #disposed = false;

  constructor(options: LocalSandboxHostOptions = {}) {
    this.#bundle = options.bundle ?? getRuntimeBundle;
    const hook = options.playerSandbox;
    this.#hook =
      hook &&
      ((sandbox, userId) => {
        const started = performance.now();
        try {
          hook(sandbox, userId);
        } finally {
          hookTime += performance.now() - started;
        }
      });
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunReply> {
    let sandbox: PlayerSandbox | undefined;
    let reset = false;
    try {
      const acquired = await this.#acquire(request);
      sandbox = acquired.sandbox;
      reset = acquired.reset;
      const output = await this.#runWithHardTimeout(request, sandbox);
      return { ok: true, output, reset, haltRequested: sandbox.haltRequested };
    } catch (error) {
      return {
        ok: false,
        error: errorMessage(error),
        reset,
        haltRequested: sandbox?.haltRequested ?? false,
      };
    }
  }

  #isDisposed(): boolean {
    return this.#disposed;
  }

  async #acquire(request: SandboxRunRequest): Promise<{ sandbox: PlayerSandbox; reset: boolean }> {
    if (this.#disposed) {
      throw new Error('BotRuntime is disposed');
    }
    const { userId } = request.input;
    const existing = this.#sandboxes.get(userId);
    if (existing) {
      if (existing.disposed) {
        this.clear(userId);
        throw new Error(
          'Script execution has been terminated: your isolate disposed unexpectedly, restarting virtual machine',
        );
      }
      if (request.codeTimestamp <= existing.codeTimestamp) {
        await existing.loadTerrain(request.terrain);
        return { sandbox: existing, reset: false };
      }
      this.clear(userId);
    }
    const sandbox = await createIsolatedVmSandbox({
      bundle: await this.#bundle(),
      codeTimestamp: request.codeTimestamp,
      memoryLimitMb: request.memoryLimitMb,
      terrain: request.terrain,
      constants: request.constants,
    });
    if (this.#isDisposed()) {
      sandbox.dispose();
      throw new Error('BotRuntime is disposed');
    }
    this.#sandboxes.set(userId, sandbox);
    return { sandbox, reset: true };
  }

  async #runWithHardTimeout(
    request: SandboxRunRequest,
    sandbox: PlayerSandbox,
  ): Promise<SandboxRunOutput> {
    const { input, hardTimeoutMs } = request;
    let timer: NodeJS.Timeout | undefined;
    const started = performance.now() - hookTime;
    const hardTimeout = new Promise<never>((_, reject) => {
      const expire = (): void => {
        const remaining = hardTimeoutMs - (performance.now() - hookTime - started);
        if (remaining > 0) {
          timer = setTimeout(expire, remaining);
          return;
        }
        this.clear(input.userId);
        reject(new Error('Script execution timed out ungracefully, restarting virtual machine'));
      };
      timer = setTimeout(expire, hardTimeoutMs);
    });
    try {
      return await Promise.race([sandbox.run(input, hardTimeoutMs, this.#hook), hardTimeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  clear(userId: string): void {
    this.#sandboxes.get(userId)?.dispose();
    this.#sandboxes.delete(userId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const userId of [...this.#sandboxes.keys()]) {
      this.clear(userId);
    }
  }
}
