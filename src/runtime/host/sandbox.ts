/*
 * Host-side player sandbox abstraction. Each player gets one isolate holding its own copy of the
 * runtime bundle; it persists (global state, `require` cache) until a global reset.
 */

import type ivm from 'isolated-vm';
import type { Constants } from '../../constants.ts';

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
  /** Player id, passed to the `playerSandbox` hook. */
  userId: string;
  data: string;
  cpu: number;
  cpuBucket: number;
}

/** Raw (untrusted) sandbox output plus host-measured CPU time. */
export interface SandboxRunOutput {
  /** JSON text produced inside the sandbox; must be validated before use. */
  result: unknown;
  /** Isolate CPU time consumed by the run, in milliseconds (measured by the host). */
  cpuTime: number;
}

/**
 * Trusted host view of a prepared player sandbox (the driver `make.js` `playerSandbox` event
 * argument). Only host code receives it; none of these handles is ever placed in the player global.
 */
export interface PlayerSandboxHookApi {
  /**
   * Compiles and runs trusted source in the player context (driver
   * `isolate.compileScriptSync(code).runSync(context)`): transferable completion values are
   * returned, anything else yields `undefined`.
   */
  run(code: string): unknown;
  /** Assigns a copy of `value` to the player global (driver `global.setSync(name, ExternalCopy)`). */
  set(name: string, value: unknown): void;
  /** Returns a copy of a player global property (driver `global.getSync(name).copySync()`). */
  get(name: string): unknown;
  getIsolate(): ivm.Isolate;
  getContext(): ivm.Context;
  /** Reference to the player global object. */
  getGlobal(): ivm.Reference<Record<string, unknown>>;
}

/**
 * Driver `config.engine.on('playerSandbox', (sandbox, userId) => …)`: called synchronously every
 * run after the runtime prepared `Game` and the player globals and before player code runs. Its
 * time is not billed to the player; a throwing hook fails the player's run.
 */
export type PlayerSandboxHook = (sandbox: PlayerSandboxHookApi, userId: string) => void;

export interface PlayerSandbox {
  readonly codeTimestamp: number;
  readonly disposed: boolean;
  /** `Game.cpu.halt()` was called; the sandbox is unusable afterwards. */
  readonly haltRequested: boolean;
  /** Loads (or reloads) terrain into the sandbox when its version differs. */
  loadTerrain(terrain: TerrainPack): Promise<void>;
  /**
   * Runs one tick, calling `hook` between the runtime preparation and the player code; rejects on
   * sandbox-level failures (timeouts, heap exhaustion, disposal, hook errors).
   */
  run(
    input: SandboxRunInput,
    timeoutMs: number,
    hook?: PlayerSandboxHook,
  ): Promise<SandboxRunOutput>;
  dispose(): void;
}

export interface SandboxOptions {
  bundle: string;
  codeTimestamp: number;
  /** Base heap limit in MB (terrain size is added like upstream). */
  memoryLimitMb: number;
  terrain: TerrainPack;
  /** The world's constants, copied into the isolate before the bundle evaluates. */
  constants: Constants;
}
