/*
 * Port of screeps/engine `processor/global-intents/power/suicidePowerCreep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { GlobalScope, IntentArgs } from '../../scope.ts';
import type { UserDoc } from '../../state.ts';
import { diePowerCreep } from './die-power-creep.ts';

export function suicidePowerCreep(intent: IntentArgs<'suicidePowerCreep'>, user: UserDoc | undefined, scope: GlobalScope): void {
    const u = user as UserDoc;
    const powerCreep = (scope.roomObjectsByType.powerCreep ?? []).find((i) => i.user == u._id && i._id == intent.id);
    if (!powerCreep) {
        return;
    }
    diePowerCreep(powerCreep, scope);
}
