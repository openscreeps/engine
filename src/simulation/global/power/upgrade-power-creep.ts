/*
 * Port of screeps/engine `processor/global-intents/power/upgradePowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { PowerCreepDoc, PowerCreepPowerInfo, UserDoc } from '../../state.ts';
import { lookup } from '../../support.ts';

function usedLevels(user: UserDoc, creeps: readonly PowerCreepDoc[]): number {
  let levels = 0;
  for (const creep of creeps) {
    const level: unknown = creep.level;
    levels += typeof level === 'number' ? level : 0;
  }
  return creeps.length + levels + (user._usedPowerLevels || 0);
}

interface PowerInfoLevels {
  readonly className: string;
  readonly level: readonly number[];
}

export function upgradePowerCreep(
  intent: IntentArgs<'upgradePowerCreep'>,
  user: UserDoc | undefined,
  scope: GlobalScope,
): void {
  const { roomObjectsByType, userPowerCreeps, bulkObjects, bulkUsersPowerCreeps } = scope;
  const u = user as UserDoc;
  const thisUserPowerCreeps = userPowerCreeps.filter((i) => i.user == u._id);

  const powerLevel = Math.floor(
    Math.pow((u.power || 0) / C.POWER_LEVEL_MULTIPLY, 1 / C.POWER_LEVEL_POW),
  );
  if (usedLevels(u, thisUserPowerCreeps) >= powerLevel) {
    return;
  }

  const powerCreep = thisUserPowerCreeps.find((i) => i._id == intent.id);
  if (!powerCreep) {
    return;
  }

  if (powerCreep.level >= C.POWER_CREEP_MAX_LEVEL) {
    return;
  }
  const powerInfo = lookup(C.POWER_INFO as Readonly<Record<string, PowerInfoLevels>>, intent.power);
  if (!powerInfo) {
    return;
  }
  if (powerInfo.className !== powerCreep.className) {
    return;
  }
  const power = String(intent.power);

  let level = powerCreep.level;
  let creepPower: PowerCreepPowerInfo | undefined = powerCreep.powers[power];
  if (!creepPower) {
    creepPower = { level: 0 };
    powerCreep.powers[power] = creepPower;
  }
  if (creepPower.level == 5) {
    return;
  }

  if (level < (powerInfo.level[creepPower.level] as number)) {
    return;
  }

  level++;
  const storeCapacity = powerCreep.storeCapacity + 100;
  const hitsMax = powerCreep.hitsMax + 1000;
  creepPower.level++;

  const roomPowerCreep = (roomObjectsByType.powerCreep ?? []).find((i) => i._id == intent.id);
  if (roomPowerCreep) {
    bulkObjects.update(roomPowerCreep, {
      level,
      hitsMax,
      storeCapacity,
      powers: powerCreep.powers,
    });
  }

  bulkUsersPowerCreeps.update(powerCreep, {
    level,
    hitsMax,
    storeCapacity,
    powers: powerCreep.powers,
  });
}
