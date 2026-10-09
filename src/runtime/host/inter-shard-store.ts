/*
 * Account-level state shared by every shard (world) of one embedding: `InterShardMemory` data,
 * `RawMemory.interShardSegment` and `Game.cpu.shardLimits`. Pass one instance to the `BotRuntime` of
 * every world that forms a multi-shard setup; a runtime without one gets a private single-shard store.
 */

export interface ShardLimitsState {
  limits: Record<string, number>;
  /** Wall-clock time (ms) when `setShardLimits` may be used again. */
  cooldownTime: number;
}

export interface InterShardSnapshot {
  /** Inter-shard data: shard → user → data. */
  data: Record<string, Record<string, string>>;
  /** `RawMemory.interShardSegment` per user. */
  segments: Record<string, string>;
  /** Explicit shard limits per user. */
  shardLimits: Record<string, ShardLimitsState>;
  /** CPU each shard assigned to a user before explicit limits existed: user → shard → cpu. */
  defaultLimits: Record<string, Record<string, number>>;
}

/** Cooldown of `Game.cpu.setShardLimits` (official docs: once per 12 hours). */
export const SHARD_LIMITS_COOLDOWN = 12 * 60 * 60 * 1000;

export class InterShardStore {
  readonly #state: InterShardSnapshot;

  constructor(snapshot?: InterShardSnapshot) {
    this.#state = snapshot
      ? structuredClone(snapshot)
      : { data: {}, segments: {}, shardLimits: {}, defaultLimits: {} };
  }

  getData(shard: string, userId: string): string {
    return this.#state.data[shard]?.[userId] ?? '';
  }

  setData(shard: string, userId: string, data: string): void {
    (this.#state.data[shard] ??= {})[userId] = data;
  }

  /** Every other shard's data of the user, keyed by shard name. */
  getRemoteData(shard: string, userId: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, users] of Object.entries(this.#state.data)) {
      const data = users[userId];
      if (name !== shard && data !== undefined) {
        result[name] = data;
      }
    }
    return result;
  }

  getSegment(userId: string): string {
    return this.#state.segments[userId] ?? '';
  }

  setSegment(userId: string, data: string): void {
    this.#state.segments[userId] = data;
  }

  /** Records the CPU a shard assigns to the user while no explicit limits are set. */
  reportShardCpu(userId: string, shard: string, cpu: number): void {
    (this.#state.defaultLimits[userId] ??= {})[shard] = cpu;
  }

  getShardLimits(userId: string): ShardLimitsState {
    const explicit = this.#state.shardLimits[userId];
    if (explicit) {
      return { limits: { ...explicit.limits }, cooldownTime: explicit.cooldownTime };
    }
    return { limits: { ...this.#state.defaultLimits[userId] }, cooldownTime: 0 };
  }

  setShardLimits(userId: string, limits: Record<string, number>, now: number): void {
    this.#state.shardLimits[userId] = {
      limits: { ...limits },
      cooldownTime: now + SHARD_LIMITS_COOLDOWN,
    };
  }

  /** Explicit CPU limit of the user on a shard, if `setShardLimits` was used. */
  explicitLimit(userId: string, shard: string): number | undefined {
    return this.#state.shardLimits[userId]?.limits[shard];
  }

  snapshot(): InterShardSnapshot {
    return structuredClone(this.#state);
  }
}
