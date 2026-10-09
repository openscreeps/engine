/*
 * Host-side player sandbox abstraction. Each player gets one isolate holding its own copy of the
 * runtime bundle; it persists (global state, `require` cache) until a global reset.
 */

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

/** Raw (untrusted) sandbox output plus host-measured CPU time. */
export interface SandboxRunOutput {
  /** JSON text produced inside the sandbox; must be validated before use. */
  result: unknown;
  /** Isolate CPU time consumed by the run, in milliseconds (measured by the host). */
  cpuTime: number;
}

export interface PlayerSandbox {
  readonly codeTimestamp: number;
  readonly disposed: boolean;
  /** `Game.cpu.halt()` was called; the sandbox is unusable afterwards. */
  readonly haltRequested: boolean;
  /** Loads (or reloads) terrain into the sandbox when its version differs. */
  loadTerrain(terrain: TerrainPack): Promise<void>;
  /** Runs one tick; rejects on sandbox-level failures (timeouts, heap exhaustion, disposal). */
  run(input: SandboxRunInput, timeoutMs: number): Promise<SandboxRunOutput>;
  dispose(): void;
}

export interface SandboxOptions {
  bundle: string;
  codeTimestamp: number;
  /** Base heap limit in MB (terrain size is added like upstream). */
  memoryLimitMb: number;
  terrain: TerrainPack;
}
