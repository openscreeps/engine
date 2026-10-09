/*
 * Messages exchanged between the host (`BotRuntime`) and the runtime bundle inside a player sandbox.
 * Both sides only exchange strings, numbers and an `ArrayBuffer` (terrain) so the protocol works for
 * isolated-vm isolates and trusted node:vm contexts alike.
 */

import type { ConsoleMessage } from './game/console.ts';
import type { IntentList } from './game/intents.ts';
import type { ActiveForeignSegment } from './game/raw-memory.ts';

/** Global name under which the runtime bundle installs its entry points. */
export const SANDBOX_ENTRY_GLOBAL = '__screepsRuntime';

/** Result of one player run (driver `outMessage`). */
export interface SandboxRunMessage {
    type: 'done' | 'error';
    error?: string;
    memorySegments?: Record<number, string>;
    usedTime: number;
    usedCleanTime: number;
    usedDirtyTime: number;
    intentsList: IntentList;
    intentsCpu: number;
    memory: { data: string; userId: string };
    console: { log: ConsoleMessage[]; results: string[] };
    visual?: Record<string, string>;
    activeSegments?: number[];
    activeForeignSegment?: ActiveForeignSegment | null;
    defaultPublicSegment?: number | null;
    /** Comma separated public segment ids. */
    publicSegments?: string;
}

/** A failure that aborts the whole run (upstream throws from the run reference). */
export interface SandboxFatalMessage {
    type: 'fatal';
    error: string;
}

export type SandboxResultMessage = SandboxRunMessage | SandboxFatalMessage;

/** Entry points installed on the sandbox global by the runtime bundle. */
export interface SandboxEntry {
    /** Binds host handles (`_isolate`, `_context`, `_halt`) and removes them from the global. */
    install(): void;
    setStaticTerrainData(buffer: ArrayBuffer, roomOffsets: string): void;
    /** `data` is JSON encoded `RuntimeData` without `cpu`/`cpuBucket` (which may be `Infinity`). */
    start(data: string, cpu: number, cpuBucket: number): void;
    /** Runs the prepared tick; returns a JSON encoded `SandboxResultMessage`. */
    run(): string;
}
