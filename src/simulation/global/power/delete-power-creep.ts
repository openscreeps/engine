/*
 * Port of screeps/engine `processor/global-intents/power/deletePowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { UserDoc } from '../../state.ts';

/** Upstream's debug `console.log(user.powerExperimentationTime)` is omitted (not a mechanic). */
export function deletePowerCreep(intent: IntentArgs<'deletePowerCreep'>, user: UserDoc | undefined, scope: GlobalScope): void {
    const { userPowerCreeps, bulkUsersPowerCreeps } = scope;
    const u = user as UserDoc;
    const powerCreep = userPowerCreeps.find((i) => i.user == u._id && i._id == intent.id);

    if (!powerCreep || powerCreep.spawnCooldownTime === null) {
        return;
    }

    if (intent.cancel) {
        bulkUsersPowerCreeps.update(powerCreep._id, { deleteTime: null });
    } else {
        if ((u.powerExperimentationTime as number) > scope.env.now()) {
            bulkUsersPowerCreeps.remove(powerCreep._id);
            return;
        }
        if (powerCreep.deleteTime) {
            return;
        }
        bulkUsersPowerCreeps.update(powerCreep._id, { deleteTime: scope.env.now() + C.POWER_CREEP_DELETE_COOLDOWN });
    }
}
