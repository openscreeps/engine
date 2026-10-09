/*
 * Port of screeps/engine `processor/intents/room/destroy-structure.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import { lookup } from '../../support.ts';
import { clearNewbieWalls } from '../creeps/clear-newbie-walls.ts';
import { destroyStructure } from '../structures/destroy.ts';

export function roomDestroyStructure(userId: string, intent: IntentArgs<'destroyStructure'>, scope: RoomScope): void {
    const { roomObjects, roomController } = scope;

    const object = roomObjects[String(intent.id)];

    if (!object || !lookup<number>(C.CONSTRUCTION_COST, object.type)) return;

    if (!roomController || roomController.user != userId) return;

    if (object.type == C.STRUCTURE_WALL && object.decayTime && !object.user) return;

    if (Object.values(roomObjects).some((i) => (i.type == 'creep' || i.type == 'powerCreep') && i.user != userId)) return;

    destroyStructure(object, scope);

    if (object.type == 'constructedWall' && object.decayTime && object.user) {
        clearNewbieWalls(scope);
    }
}
