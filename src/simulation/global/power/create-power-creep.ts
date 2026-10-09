/*
 * Port of screeps/engine `processor/global-intents/power/createPowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { PowerCreepDoc, UserDoc } from '../../state.ts';

function usedLevels(user: UserDoc, creeps: readonly PowerCreepDoc[]): number {
  let levels = 0;
  for (const creep of creeps) {
    const level: unknown = creep.level;
    levels += typeof level === 'number' ? level : 0;
  }
  return creeps.length + levels + (user._usedPowerLevels || 0);
}

export function createPowerCreep(
  intent: IntentArgs<'createPowerCreep'>,
  user: UserDoc | undefined,
  scope: GlobalScope,
): void {
  const { userPowerCreeps, bulkUsersPowerCreeps } = scope;
  const u = user as UserDoc;
  const thisUserPowerCreeps = userPowerCreeps.filter((i) => i.user == u._id);

  const powerLevel = Math.floor(
    Math.pow((u.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
  );
  if (usedLevels(u, thisUserPowerCreeps) >= powerLevel) {
    return;
  }

  if ((Object.values(C.POWER_CLASS) as unknown[]).indexOf(intent.className) === -1) {
    return;
  }

  const name = (intent.name as string).substring(0, 50);

  if (thisUserPowerCreeps.some((i) => i.name === name)) {
    return;
  }

  bulkUsersPowerCreeps.insert({
    name,
    className: intent.className as string,
    user: u._id,
    level: 0,
    hitsMax: 1000,
    store: {},
    storeCapacity: 100,
    spawnCooldownTime: 0,
    powers: {},
  });

  u._usedPowerLevels = (u._usedPowerLevels || 0) + 1;
}
