/*
 * TRUSTED-ONLY player sandbox on `node:vm`. It gives each player a separate realm (own globals and
 * intrinsics) running its own copy of the runtime bundle, but node:vm is NOT a security boundary:
 * player code can escape to the host process. Never use it for untrusted bots; use isolated-vm.
 */

import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import vm from 'node:vm';
import { SANDBOX_ENTRY_GLOBAL, type SandboxEntry, type SandboxResultMessage } from '../protocol.ts';
import { parseResultMessage, type PlayerSandbox, type SandboxOptions, type SandboxRunInput, type TerrainPack } from './sandbox.ts';

function isSandboxEntry(value: unknown): value is SandboxEntry {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof Reflect.get(value, 'install') === 'function' &&
        typeof Reflect.get(value, 'start') === 'function' &&
        typeof Reflect.get(value, 'run') === 'function' &&
        typeof Reflect.get(value, 'setStaticTerrainData') === 'function'
    );
}

class HaltError extends Error {
    constructor() {
        super('CPU halted');
    }
}

class TrustedVmSandbox implements PlayerSandbox {
    readonly codeTimestamp: number;
    haltRequested = false;
    disposed = false;
    readonly #entry: SandboxEntry;
    #terrainVersion = -1;
    #cpuTime = 0;

    constructor(entry: SandboxEntry, codeTimestamp: number) {
        this.#entry = entry;
        this.codeTimestamp = codeTimestamp;
    }

    requestHalt(): never {
        this.haltRequested = true;
        this.disposed = true;
        throw new HaltError();
    }

    loadTerrain(terrain: TerrainPack): Promise<void> {
        if (this.#terrainVersion !== terrain.version) {
            this.#entry.setStaticTerrainData(terrain.buffer, terrain.roomOffsets);
            this.#terrainVersion = terrain.version;
        }
        return Promise.resolve();
    }

    run(input: SandboxRunInput, timeoutMs: number): Promise<SandboxResultMessage> {
        if (this.disposed) {
            return Promise.reject(new Error('Isolate is disposed'));
        }
        const started = performance.now();
        try {
            this.#entry.start(input.data, input.cpu, input.cpuBucket);
            const result = this.#entry.run();
            const elapsed = performance.now() - started;
            if (elapsed > timeoutMs) {
                this.disposed = true;
                return Promise.reject(new Error('Script execution timed out.'));
            }
            return Promise.resolve(parseResultMessage(result));
        } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
            this.#cpuTime += performance.now() - started;
        }
    }

    cpuTime(): number {
        return this.#cpuTime;
    }

    dispose(): void {
        this.disposed = true;
    }
}

/** Creates a node:vm context running the runtime bundle. Trusted code only. */
export function createTrustedVmSandbox(options: SandboxOptions): Promise<PlayerSandbox> {
    const context = vm.createContext({}, { name: 'screeps-player', codeGeneration: { strings: true, wasm: true } });
    vm.runInContext('globalThis.global = globalThis;', context);
    new vm.Script(options.bundle, { filename: 'runtime.bundle.js' }).runInContext(context);
    const entry: unknown = vm.runInContext(SANDBOX_ENTRY_GLOBAL, context);
    if (!isSandboxEntry(entry)) {
        return Promise.reject(new Error('Runtime bundle did not install its entry points'));
    }

    let sandbox: TrustedVmSandbox | undefined;
    const startCpu = performance.now();
    const compiler = {
        compileScriptSync(code: string, scriptOptions: { filename: string }) {
            const script = new vm.Script(code, { filename: scriptOptions.filename });
            return {
                runSync(target: unknown, runOptions: { timeout?: number }): unknown {
                    if (!vm.isContext(target)) {
                        throw new Error('Invalid context');
                    }
                    return runOptions.timeout === undefined
                        ? script.runInContext(target)
                        : script.runInContext(target, { timeout: runOptions.timeout });
                },
            };
        },
        get cpuTime(): bigint {
            return BigInt(Math.round((performance.now() - startCpu) * 1e6));
        },
        getHeapStatisticsSync(): Record<string, number> {
            return { ...getHeapStatistics() };
        },
    };
    Object.assign(context, {
        _isolate: compiler,
        _context: context,
        _halt: () => sandbox?.requestHalt(),
    });
    entry.install();

    sandbox = new TrustedVmSandbox(entry, options.codeTimestamp);
    void sandbox.loadTerrain(options.terrain);
    return Promise.resolve(sandbox);
}
