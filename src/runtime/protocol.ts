/*
 * Messages exchanged between the host (`BotRuntime`) and the runtime bundle inside a player isolate.
 * Only strings, numbers and an `ArrayBuffer` (terrain) cross the boundary. Everything coming back
 * from the sandbox is untrusted player-controlled data and is validated by the host.
 */

import type { ConsoleMessage } from './game/console.ts';
import type { IntentList } from './game/intents.ts';
import type { ActiveForeignSegment } from './game/raw-memory.ts';

/** Global name under which the bundle exposes its entry points until the host captures them. */
export const SANDBOX_ENTRY_GLOBAL = '__screepsRuntime';

/** Result of one player run (driver `outMessage`, CPU fields measured by the host instead). */
export interface SandboxRunMessage {
  type: 'done' | 'error';
  error?: string;
  intentsList: IntentList;
  /** The sandbox's running intent CPU accumulator (driver `intents.cpu`). */
  intentsCpu: number;
  memory: string;
  memorySegments?: Record<number, string>;
  console: { log: ConsoleMessage[]; results: string[] };
  visual?: Record<string, string>;
  activeSegments?: number[];
  activeForeignSegment?: ActiveForeignSegment | null;
  defaultPublicSegment?: number | null;
  /** Comma separated public segment ids. */
  publicSegments?: string;
  /** New `InterShardMemory.setLocal` data. */
  interShardLocal?: string;
  /** New `RawMemory.interShardSegment` value. */
  interShardSegment?: string;
  /** Accepted `Game.cpu.setShardLimits` request. */
  shardLimits?: Record<string, number>;
}

/** A failure that aborts the whole run (upstream throws from the run reference). */
export interface SandboxFatalMessage {
  type: 'fatal';
  error: string;
}

export type SandboxResultMessage = SandboxRunMessage | SandboxFatalMessage;

/** Entry points of the runtime bundle; the host keeps private references and deletes the global. */
export interface SandboxEntry {
  /** Binds host handles (`_isolate`, `_context`, `_halt`) and removes them from the global. */
  install(): void;
  setStaticTerrainData(buffer: ArrayBuffer, roomOffsets: string): void;
  /**
   * Runs one tick. `data` is JSON encoded `RuntimeData` without `cpu`/`cpuBucket` (which may be
   * `Infinity`). The result is a plain structure (null-prototype objects, arrays, primitives) that the
   * host receives as a structured-clone copy and validates as untrusted data.
   */
  run(data: string, cpu: number, cpuBucket: number): SandboxResultMessage;
}
