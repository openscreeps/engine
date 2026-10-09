/*
 * Port of screeps/engine `processor/intents/construction-sites/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';

/** Upstream construction site tick is a no-op. */
export function tickConstructionSite(object: RoomObject, scope: RoomScope): void {
    void object;
    void scope;
}
