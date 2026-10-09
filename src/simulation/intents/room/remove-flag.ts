/*
 * Port of screeps/engine `processor/intents/room/remove-flag.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import { escapeFlagName } from './create-flag.ts';

export function removeFlag(userId: string, intent: IntentArgs<'removeFlag'>, scope: RoomScope): void {
    const { flags } = scope;

    const flagItem = flags.find((i) => i.user === userId);
    if (!flagItem) {
        return;
    }

    const name = escapeFlagName(intent.name);

    const parsed = flagItem._parsed ?? [];
    if (!parsed.some((i) => i[0] == name)) {
        return;
    }
    flagItem._modified = true;
    // `_.remove` mutates the array in place.
    for (let index = parsed.length - 1; index >= 0; index--) {
        if ((parsed[index] as string[])[0] == name) {
            parsed.splice(index, 1);
        }
    }
}
