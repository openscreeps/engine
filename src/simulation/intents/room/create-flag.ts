/*
 * Port of screeps/engine `processor/intents/room/create-flag.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope, ScopeFlag } from '../../scope.ts';
import { contains } from '../../support.ts';

/** Escapes the flag serialization separators exactly like upstream (throws on a missing name). */
export function escapeFlagName(name: string | undefined): string {
    return (name as string).replace(/\|/g, '$VLINE$').replace(/~/g, '$TILDE$');
}

/** `Array#join` renders `null`/`undefined` entries as empty strings. */
function flagPart(value: string | number | null | undefined): string {
    return value === undefined || value === null ? '' : String(value);
}

export function createFlag(userId: string, intent: IntentArgs<'createFlag'>, scope: RoomScope): void {
    const { flags } = scope;

    const name = escapeFlagName(intent.name);

    if (flags.some((i) => i.user == userId && (i._parsed ?? []).some((j) => j[0] == name))) {
        return;
    }
    if (!intent.color || !contains(C.COLORS_ALL, intent.color)) {
        return;
    }
    if (!intent.secondaryColor || !contains(C.COLORS_ALL, intent.secondaryColor)) {
        return;
    }

    if ((intent.x as number) < 0 || (intent.x as number) > 49 || (intent.y as number) < 0 || (intent.y as number) > 49) {
        return;
    }

    let flagItem: ScopeFlag | undefined = flags.find((i) => i.user === userId);
    if (!flagItem) {
        flagItem = { user: userId, room: intent.roomName as string, _parsed: [] };
        flags.push(flagItem);
    }

    flagItem._modified = true;
    // Upstream stores the raw numbers; they only ever get joined, so their string form is equivalent.
    (flagItem._parsed as string[][]).push([
        name,
        flagPart(intent.color),
        flagPart(intent.secondaryColor),
        flagPart(intent.x),
        flagPart(intent.y),
    ]);
}
