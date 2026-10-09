/*
 * Port of screeps/engine `processor/global-intents/power/renamePowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { UserDoc } from '../../state.ts';

export function renamePowerCreep(
  intent: IntentArgs<'renamePowerCreep'>,
  user: UserDoc | undefined,
  scope: GlobalScope,
): void {
  const u = user as UserDoc;
  const thisUserPowerCreeps = scope.userPowerCreeps.filter((i) => i.user == u._id);
  const powerCreep = thisUserPowerCreeps.find((i) => i._id == intent.id);

  if (!powerCreep || powerCreep.spawnCooldownTime === null) {
    return;
  }

  const name = (intent.name as string).substring(0, 50);

  if (thisUserPowerCreeps.some((i) => i.name === name)) {
    return;
  }

  scope.bulkUsersPowerCreeps.update(powerCreep._id, { name });
}
