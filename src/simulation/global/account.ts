/*
 * Account-level global intents of the official game that the open-source server lacks:
 * `Game.cpu.generatePixel()`, `Game.cpu.unlock()` and `Game.shard.activateAccess()`. The runtime
 * validates and charges the caller (CPU bucket, available unlocks/keys) before recording the
 * intents; the persistent effects are applied here, during the global stage.
 */

import type { GlobalScope } from '../scope.ts';
import type { UserDoc } from '../state.ts';

const CPU_UNLOCK_DURATION = 24 * 3600 * 1000;
const SHARD_ACCESS_DURATION = 30 * 24 * 3600 * 1000;

/** Upstream `shardAccess` flag of a user on a restricted shard (`false` blocks claim/reserve/upgrade). */
export function hasShardAccess(user: UserDoc, now: number): boolean {
  return !!user.shardAccessUnlimited || (user.shardAccessTime ?? 0) > now;
}

export function processAccountIntents(scope: GlobalScope): void {
  const { userIntents, usersById, bulkUsers, env, restrictedShard } = scope;

  for (const { user: userId, intents } of userIntents) {
    const user: UserDoc | undefined = usersById[userId];
    if (!user) {
      continue;
    }
    const resources = (user.resources ??= {});

    const pixels = intents.generatePixel?.length ?? 0;
    for (let i = 0; i < pixels; i++) {
      bulkUsers.inc(user, 'resources.pixel', 1);
      resources.pixel = (resources.pixel ?? 0) + 1;
    }

    const unlocks = intents.unlockCpu?.length ?? 0;
    for (let i = 0; i < unlocks; i++) {
      if (!((resources.cpuUnlock ?? 0) >= 1)) {
        continue;
      }
      bulkUsers.inc(user, 'resources.cpuUnlock', -1);
      resources.cpuUnlock = (resources.cpuUnlock ?? 0) - 1;
      const cpuUnlockedTime = Math.max(env.now(), user.cpuUnlockedTime ?? 0) + CPU_UNLOCK_DURATION;
      bulkUsers.update(user, { cpuUnlockedTime });
    }

    const activations = intents.activateAccess?.length ?? 0;
    for (let i = 0; i < activations; i++) {
      if (!restrictedShard || user.shardAccessUnlimited || !((resources.accessKey ?? 0) >= 1)) {
        continue;
      }
      bulkUsers.inc(user, 'resources.accessKey', -1);
      resources.accessKey = (resources.accessKey ?? 0) - 1;
      const now = env.now();
      const shardAccessTime = Math.max(now, user.shardAccessTime ?? 0) + SHARD_ACCESS_DURATION;
      // the new expiry is in the future, so access is active again
      bulkUsers.update(user, { shardAccessTime, shardAccess: true });
    }
  }
}
