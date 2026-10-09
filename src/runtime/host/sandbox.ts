/*
 * Host-side player sandbox abstraction. Each player gets one sandbox holding its own copy of the
 * runtime bundle; the sandbox persists (global state, `require` cache) until a global reset.
 */

import type { SandboxResultMessage } from '../protocol.ts';

/** All room terrain packed into one buffer (driver `getAllTerrainData`). */
export interface TerrainPack {
    /** Monotonic version; sandboxes reload terrain when it changes. */
    version: number;
    buffer: ArrayBuffer;
    /** JSON encoded `Record<roomName, byteOffset>`. */
    roomOffsets: string;
    byteLength: number;
}

export interface SandboxRunInput {
    data: string;
    cpu: number;
    cpuBucket: number;
}

export interface PlayerSandbox {
    readonly codeTimestamp: number;
    readonly disposed: boolean;
    /** `Game.cpu.halt()` was called; the sandbox is unusable afterwards. */
    readonly haltRequested: boolean;
    /** Loads (or reloads) terrain into the sandbox when its version differs. */
    loadTerrain(terrain: TerrainPack): Promise<void>;
    /** Runs one tick; rejects on sandbox-level failures (timeouts, heap exhaustion, disposal). */
    run(input: SandboxRunInput, timeoutMs: number): Promise<SandboxResultMessage>;
    /** CPU time consumed by the sandbox so far, in milliseconds. */
    cpuTime(): number;
    dispose(): void;
}

export interface SandboxOptions {
    bundle: string;
    codeTimestamp: number;
    /** Base heap limit in MB (terrain size is added like upstream). */
    memoryLimitMb: number;
    terrain: TerrainPack;
}

export type SandboxFactory = (options: SandboxOptions) => Promise<PlayerSandbox>;

export function parseResultMessage(json: unknown): SandboxResultMessage {
    if (typeof json !== 'string') {
        throw new Error('Sandbox returned an invalid result');
    }
    return JSON.parse(json) as SandboxResultMessage;
}
