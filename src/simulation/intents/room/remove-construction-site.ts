/*
 * Port of screeps/engine `processor/intents/room/remove-construction-site.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { IntentArgs, RoomScope } from '../../scope.ts';
import { createEnergy } from '../create-energy.ts';

export function removeConstructionSite(userId: string, intent: IntentArgs<'removeConstructionSite'>, scope: RoomScope): void {
    const { roomObjects, bulk, roomController } = scope;

    const object = roomObjects[String(intent.id)];

    if (!object || object.type != 'constructionSite') return;

    if (object.user != userId && !(roomController && roomController.user == userId)) return;

    bulk.remove(object._id);
    if ((object.progress as number) > 1) {
        createEnergy(object.x, object.y, object.room, Math.floor((object.progress as number) / 2), 'energy', scope);
    }
}
