/*
 * Port of screeps/engine `processor/intents/invader-core/destroy.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { calcReward } from '../../../utils/index.ts';
import { coreAmounts, coreDensities, coreRewards, templates } from '../../../utils/strongholds.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup, sample } from '../../support.ts';

/** Releases the room controller and fills the core with its stronghold loot. */
export function destroyInvaderCore(object: RoomObject, scope: RoomScope): void {
  const { bulk, roomController, env } = scope;

  if (roomController) {
    bulk.update(roomController, {
      user: null,
      level: 0,
      progress: 0,
      downgradeTime: null,
      safeMode: null,
      safeModeAvailable: 0,
      safeModeCooldown: null,
      isPowerEnabled: false,
      effects: null,
    });
  }

  const rewardsTable = lookup<readonly (string | readonly string[])[]>(
    coreRewards,
    object.depositType,
  );
  const template = lookup<{ rewardLevel: number }>(templates, object.templateName);
  if (!rewardsTable || !rewardsTable.some((r) => !!r) || !template) {
    return;
  }

  const rewardLevel = template.rewardLevel;
  const rewards = rewardsTable
    .slice(0, 1 + rewardLevel)
    .map((r) => (typeof r === 'string' ? r : sample(r, () => env.random())));
  const rewardDensities = coreDensities.slice(0, 1 + rewardLevel);
  const densities: Record<string, number> = {};
  rewards.forEach((resource, index) => {
    densities[String(resource)] = rewardDensities[index] as number;
  });

  const store = calcReward(densities, coreAmounts[rewardLevel] as number, undefined, () =>
    env.random(),
  );

  bulk.update(object, { store });

  env.hooks.strongholdDestroyed?.(object, scope);
}
