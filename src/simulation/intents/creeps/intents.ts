/*
 * Port of screeps/engine `processor/intents/creeps/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { creepAttack } from './attack.ts';
import { creepAttackController } from './attack-controller.ts';
import { creepBuild } from './build.ts';
import { creepClaimController } from './claim-controller.ts';
import { creepDismantle } from './dismantle.ts';
import { drop } from './drop.ts';
import { creepGenerateSafeMode } from './generate-safe-mode.ts';
import { creepHarvest } from './harvest.ts';
import { creepHeal } from './heal.ts';
import { creepMove } from './move.ts';
import { creepPickup } from './pickup.ts';
import { creepPull } from './pull.ts';
import { creepRangedAttack } from './ranged-attack.ts';
import { creepRangedHeal } from './ranged-heal.ts';
import { creepRangedMassAttack } from './ranged-mass-attack.ts';
import { creepRepair } from './repair.ts';
import { creepReserveController } from './reserve-controller.ts';
import { creepSay } from './say.ts';
import { creepSignController } from './sign-controller.ts';
import { creepSuicide } from './suicide.ts';
import { creepTransfer } from './transfer.ts';
import { creepUpgradeController } from './upgrade-controller.ts';
import { creepWithdraw } from './withdraw.ts';

const creepActions = [
  'drop',
  'transfer',
  'withdraw',
  'pickup',
  'heal',
  'rangedHeal',
  'dismantle',
  'attack',
  'harvest',
  'move',
  'repair',
  'build',
  'rangedMassAttack',
  'rangedAttack',
  'say',
  'suicide',
  'claimController',
  'upgradeController',
  'reserveController',
  'attackController',
  'generateSafeMode',
  'signController',
  'pull',
] as const;

type CreepAction = (typeof creepActions)[number];

const priorities: Partial<Record<CreepAction, readonly CreepAction[]>> = {
  rangedHeal: ['heal'],
  attackController: ['rangedHeal', 'heal'],
  dismantle: ['attackController', 'rangedHeal', 'heal'],
  repair: ['dismantle', 'attackController', 'rangedHeal', 'heal'],
  build: ['repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
  attack: ['build', 'repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
  harvest: ['attack', 'build', 'repair', 'dismantle', 'attackController', 'rangedHeal', 'heal'],
  rangedMassAttack: ['build', 'repair', 'rangedHeal'],
  rangedAttack: ['rangedMassAttack', 'build', 'repair', 'rangedHeal'],
};

type Handlers = {
  [N in CreepAction]: (object: RoomObject, intent: IntentArgs<N>, scope: RoomScope) => void;
};

const modules: Handlers = {
  drop,
  transfer: creepTransfer,
  withdraw: creepWithdraw,
  pickup: creepPickup,
  heal: creepHeal,
  rangedHeal: creepRangedHeal,
  dismantle: creepDismantle,
  attack: creepAttack,
  harvest: creepHarvest,
  move: creepMove,
  repair: creepRepair,
  build: creepBuild,
  rangedMassAttack: creepRangedMassAttack,
  rangedAttack: creepRangedAttack,
  say: creepSay,
  suicide: creepSuicide,
  claimController: creepClaimController,
  upgradeController: creepUpgradeController,
  reserveController: creepReserveController,
  attackController: creepAttackController,
  generateSafeMode: creepGenerateSafeMode,
  signController: creepSignController,
  pull: creepPull,
};

function runAction<N extends CreepAction>(
  name: N,
  handler: Handlers[N],
  object: RoomObject,
  intents: ObjectIntentSet,
  scope: RoomScope,
): void {
  const intent: IntentArgs<N> | undefined = intents[name];
  if (!intent) {
    return;
  }
  const blockers = priorities[name];
  if (blockers && blockers.some((i) => !!intents[i])) {
    return;
  }
  handler(object, intent, scope);
}

export function processCreepIntents(
  object: RoomObject,
  intents: ObjectIntentSet,
  scope: RoomScope,
): void {
  for (const name of creepActions) {
    runAction(name, modules[name], object, intents, scope);
  }
}
