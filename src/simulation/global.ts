/*
 * Global (inter-room) processing stage: port of screeps/engine `processor/global.js` with the
 * data loading of @screeps/driver `getInterRoom`.
 *
 * Portions derived from screeps/engine and screeps/driver, Copyright (c) 2016, Artem Chivchalov
 * <contact@screeps.com>, used under the ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { processMarketIntents } from './global/market.ts';
import { processPowerIntents } from './global/power.ts';
import type { GlobalScope } from './scope.ts';
import type { RoomObject } from './state.ts';

/**
 * Moves creeps that crossed room edges or portals into accessible rooms, then processes power
 * creep account intents and the market. `interRoomCreeps` are creeps/power creeps with a pending
 * `interRoom`; `accessibleRooms` are rooms with status `normal` that are already open.
 */
export function processGlobal(
    scope: GlobalScope,
    interRoomCreeps: RoomObject[],
    accessibleRooms: ReadonlySet<string>,
): void {
    const activated = new Set<string>();

    for (const creep of interRoomCreeps) {
        const interRoom = creep.interRoom;
        if (!interRoom || !accessibleRooms.has(interRoom.room)) {
            continue;
        }
        if (!activated.has(interRoom.room)) {
            scope.env.activateRoom(interRoom.room);
        }
        activated.add(interRoom.room);

        scope.bulkObjects.update(creep, { room: interRoom.room, x: interRoom.x, y: interRoom.y, interRoom: null });
    }

    processPowerIntents(scope);
    processMarketIntents(scope);
}
