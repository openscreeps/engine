/*
 * Player sandbox backed by an isolated-vm `Isolate` (screeps/driver `lib/runtime/user-vm.js` and
 * `make.js`). Player code and the runtime bundle run in a separate V8 isolate with its own heap limit.
 *
 * Portions derived from screeps/driver, Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>,
 * used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import ivm from 'isolated-vm';
import { SANDBOX_ENTRY_GLOBAL, type SandboxEntry, type SandboxResultMessage } from '../protocol.ts';
import { parseResultMessage, type PlayerSandbox, type SandboxOptions, type SandboxRunInput, type TerrainPack } from './sandbox.ts';

class IsolatedVmSandbox implements PlayerSandbox {
    readonly codeTimestamp: number;
    haltRequested = false;
    readonly #isolate: ivm.Isolate;
    readonly #entry: ivm.Reference<SandboxEntry>;
    #terrainVersion = -1;

    constructor(isolate: ivm.Isolate, entry: ivm.Reference<SandboxEntry>, codeTimestamp: number) {
        this.#isolate = isolate;
        this.#entry = entry;
        this.codeTimestamp = codeTimestamp;
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
        const setTerrain = this.#entry.getSync('setStaticTerrainData', { reference: true });
        try {
            await setTerrain.apply(undefined, [
                new ivm.ExternalCopy(terrain.buffer).copyInto({ release: true }),
                terrain.roomOffsets,
            ]);
        } finally {
            setTerrain.release();
        }
        this.#terrainVersion = terrain.version;
    }

    async run(input: SandboxRunInput, timeoutMs: number): Promise<SandboxResultMessage> {
        const start = this.#entry.getSync('start', { reference: true });
        const run = this.#entry.getSync('run', { reference: true });
        try {
            await start.apply(undefined, [input.data, input.cpu, input.cpuBucket], { timeout: timeoutMs });
            const result: unknown = await run.apply(undefined, [], { timeout: timeoutMs });
            return parseResultMessage(result);
        } finally {
            if (!this.#isolate.isDisposed) {
                start.release();
                run.release();
            }
        }
    }

    cpuTime(): number {
        return this.#isolate.isDisposed ? 0 : Number(this.#isolate.cpuTime) / 1e6;
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

        const entry: ivm.Reference<SandboxEntry> = await global.get(SANDBOX_ENTRY_GLOBAL, { reference: true });
        let sandbox: IsolatedVmSandbox | undefined;
        await global.set('_isolate', isolate);
        await global.set('_context', context);
        await global.set(
            '_halt',
            new ivm.Reference(() => {
                sandbox?.requestHalt();
            }),
        );
        const install = entry.getSync('install', { reference: true });
        await install.apply(undefined, []);
        install.release();

        sandbox = new IsolatedVmSandbox(isolate, entry, options.codeTimestamp);
        await sandbox.loadTerrain(options.terrain);
        return sandbox;
    } catch (error) {
        if (!isolate.isDisposed) {
            isolate.dispose();
        }
        throw error;
    }
}
