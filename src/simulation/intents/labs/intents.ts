/*
 * Port of screeps/engine `processor/intents/labs/intents.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { labBoostCreep } from './boost-creep.ts';
import { labReverseReaction } from './reverse-reaction.ts';
import { labRunReaction } from './run-reaction.ts';
import { labUnboostCreep } from './unboost-creep.ts';

export function processLabIntents(object: RoomObject, objectIntents: ObjectIntentSet, scope: RoomScope): void {
    if (objectIntents.boostCreep) labBoostCreep(object, objectIntents.boostCreep, scope);

    if (objectIntents.unboostCreep) labUnboostCreep(object, objectIntents.unboostCreep, scope);

    if (objectIntents.runReaction) labRunReaction(object, objectIntents.runReaction, scope);
    else if (objectIntents.reverseReaction) labReverseReaction(object, objectIntents.reverseReaction, scope);
}
