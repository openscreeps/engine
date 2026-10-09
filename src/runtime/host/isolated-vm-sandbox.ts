/*
 * Player sandbox backed by an isolated-vm `Isolate` (screeps/driver `lib/runtime/user-vm.js` and
 * `make.js`). Player code and the runtime bundle run in a separate V8 isolate with its own heap limit.
 * The host keeps private references to the bundle's entry functions and removes every host handle
 * from the player global before any player code runs.
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import ivm from 'isolated-vm';
import { SANDBOX_ENTRY_GLOBAL, type SandboxEntry } from '../protocol.ts';
import type {
  PlayerSandbox,
  SandboxOptions,
  SandboxRunInput,
  SandboxRunOutput,
  TerrainPack,
} from './sandbox.ts';

interface EntryReferences {
  run: ivm.Reference<SandboxEntry['run']>;
  setStaticTerrainData: ivm.Reference<SandboxEntry['setStaticTerrainData']>;
}

class IsolatedVmSandbox implements PlayerSandbox {
  readonly codeTimestamp: number;
  haltRequested = false;
  readonly #isolate: ivm.Isolate;
  readonly #entry: EntryReferences;
  #terrainVersion = -1;
  /** Isolate CPU time sampled by the private `_cpuMark` callback during the current run. */
  #marks: [start: bigint | undefined, end: bigint | undefined] = [undefined, undefined];

  constructor(isolate: ivm.Isolate, entry: EntryReferences, codeTimestamp: number) {
    this.#isolate = isolate;
    this.#entry = entry;
    this.codeTimestamp = codeTimestamp;
  }

  /** Called synchronously from inside the isolate at the billed-phase boundaries (0 start, 1 end). */
  mark(phase: unknown): void {
    if (
      (phase === 0 && this.#marks[0] === undefined) ||
      (phase === 1 && this.#marks[0] !== undefined && this.#marks[1] === undefined)
    ) {
      this.#marks[phase] = this.#isolate.cpuTime;
    }
  }

  get disposed(): boolean {
    return this.#isolate.isDisposed;
  }

  requestHalt(): void {
    this.haltRequested = true;
    this.dispose();
  }

  async loadTerrain(terrain: TerrainPack): Promise<void> {
    if (this.#terrainVersion === terrain.version) {
      return;
    }
    await this.#entry.setStaticTerrainData.apply(undefined, [
      new ivm.ExternalCopy(terrain.buffer).copyInto({ release: true }),
      terrain.roomOffsets,
    ]);
    this.#terrainVersion = terrain.version;
  }

  async run(input: SandboxRunInput, timeoutMs: number): Promise<SandboxRunOutput> {
    this.#marks = [undefined, undefined];
    const before = this.#isolate.cpuTime;
    try {
      const result: unknown = await this.#entry.run.apply(
        undefined,
        [input.data, input.cpu, input.cpuBucket],
        // Copy the plain result structure out of the isolate (reference `ExternalCopy`).
        { timeout: timeoutMs, result: { copy: true } },
      );
      // Bill the driver's clean phase (player code through memory serialization), not the
      // runtime preparation or the result transport.
      const [start, end] = this.#marks;
      const used =
        start !== undefined && end !== undefined ? end - start : this.#isolate.cpuTime - before;
      return { result, cpuTime: Number(used) / 1e6 };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  dispose(): void {
    if (!this.#isolate.isDisposed) {
      this.#isolate.dispose();
    }
  }
}

/** Creates an isolate, evaluates the runtime bundle in it and binds the host handles. */
export async function createIsolatedVmSandbox(options: SandboxOptions): Promise<PlayerSandbox> {
  const isolate = new ivm.Isolate({
    memoryLimit: options.memoryLimitMb + options.terrain.byteLength / 1024 / 1024,
  });
  try {
    const context = await isolate.createContext();
    const global = context.global;
    await global.set('global', global.derefInto());
    const bundle = await isolate.compileScript(options.bundle, { filename: 'runtime.bundle.js' });
    await bundle.run(context);
    bundle.release();

    // isolated-vm types `global` members as `any`; the bundle installs a `SandboxEntry` there.
    const entry = (await global.get(SANDBOX_ENTRY_GLOBAL, {
      reference: true,
    })) as ivm.Reference<SandboxEntry>;
    const references: EntryReferences = {
      run: entry.getSync('run', { reference: true }),
      setStaticTerrainData: entry.getSync('setStaticTerrainData', { reference: true }),
    };
    const install = entry.getSync('install', { reference: true });
    entry.release();

    const haltTarget: { sandbox?: IsolatedVmSandbox } = {};
    await global.set('_isolate', isolate);
    await global.set('_context', context);
    await global.set(
      '_halt',
      new ivm.Reference(() => {
        haltTarget.sandbox?.requestHalt();
      }),
    );
    await global.set(
      '_cpuMark',
      new ivm.Callback((phase: unknown) => {
        haltTarget.sandbox?.mark(phase);
      }),
    );
    // `install` captures the handles and deletes them and the entry global from the player global.
    await install.apply(undefined, []);
    install.release();

    const sandbox = new IsolatedVmSandbox(isolate, references, options.codeTimestamp);
    haltTarget.sandbox = sandbox;
    await sandbox.loadTerrain(options.terrain);
    return sandbox;
  } catch (error) {
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
    throw error;
  }
}
