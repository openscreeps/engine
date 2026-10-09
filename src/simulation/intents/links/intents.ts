/*
 * Port of screeps/engine `processor/intents/links/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { linkTransfer } from './transfer.ts';

export function processLinkIntents(object: RoomObject, objectIntents: ObjectIntentSet, scope: RoomScope): void {
    if (objectIntents.transfer) linkTransfer(object, objectIntents.transfer, scope);
}
