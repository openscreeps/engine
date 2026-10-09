/*
 * Port of screeps/engine `processor/intents/keeper-lairs/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { BodyPart, RoomObject } from '../../state.ts';

export function tickKeeperLair(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, gameTime } = scope;

    if (object.type != 'keeperLair') return;

    const keeperName = 'Keeper' + object._id;

    if (!object.nextSpawnTime) {
        const keeper = Object.values(roomObjects).find((i) => i.type == 'creep' && i.user == '3' && i.name == keeperName);
        if (!keeper || (keeper.hits as number) < 5000) {
            bulk.update(object, { nextSpawnTime: gameTime + C.ENERGY_REGEN_TIME });
        }
    }

    if (object.nextSpawnTime && gameTime >= object.nextSpawnTime - 1) {
        const keeper = Object.values(roomObjects).find((i) => i.type == 'creep' && i.user == '3' && i.name == keeperName);
        if (keeper) {
            bulk.remove(keeper._id);
        }

        const body: BodyPart[] = [];

        for (let i = 0; i < 17; i++) {
            body.push({ type: C.TOUGH, hits: 100 });
        }
        for (let i = 0; i < 13; i++) {
            body.push({ type: C.MOVE, hits: 100 });
        }
        for (let i = 0; i < 10; i++) {
            body.push({ type: C.ATTACK, hits: 100 });
            body.push({ type: C.RANGED_ATTACK, hits: 100 });
        }

        bulk.insert({
            name: keeperName,
            x: object.x,
            y: object.y,
            body,
            store: { energy: 0 },
            storeCapacity: 0,
            type: 'creep',
            room: object.room,
            user: '3',
            hits: 5000,
            hitsMax: 5000,
            spawning: false,
            fatigue: 0,
        });

        bulk.update(object, { nextSpawnTime: null });
    }
}
