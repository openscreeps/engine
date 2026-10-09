/*
 * Port of screeps/engine `processor/intents/invader-core/pretick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { IntentList } from '../../npc/fake-runtime.ts';
import type { ObjectIntentSet, RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { lookup } from '../../support.ts';
import { behaviors, type StrongholdContext } from './stronghold/stronghold.ts';

/** Stronghold AI for an invader core; no intents when the behavior is unknown. */
export function invaderCorePretick(object: RoomObject, scope: RoomScope): Record<string, ObjectIntentSet> {
    const { gameTime, roomObjects, roomController, bulk } = scope;
    const user = object.user;
    const intents = new IntentList();

    const behaviorName = object.deployTime ? 'deploy' : object.strongholdBehavior || 'default';
    const behavior = lookup(behaviors, behaviorName);
    if (!behavior) {
        return intents.list;
    }

    const creeps: RoomObject[] = [];
    const defenders: RoomObject[] = [];
    const damagedDefenders: RoomObject[] = [];
    const hostiles: RoomObject[] = [];
    const towers: RoomObject[] = [];
    const ramparts: RoomObject[] = [];
    const damagedRoads: RoomObject[] = [];
    for (const key of Object.keys(roomObjects)) {
        const o = roomObjects[key] as RoomObject;
        if ((o.type === 'creep' || o.type === 'powerCreep') && !o.spawning) {
            creeps.push(o);
            if (o.user === user) {
                defenders.push(o);
                if ((o.hits as number) < (o.hitsMax as number)) {
                    damagedDefenders.push(o);
                }
            } else if (o.user !== '3') {
                hostiles.push(o);
            }
            continue;
        }
        if (o.type === C.STRUCTURE_TOWER && o.user === user) {
            towers.push(o);
            continue;
        }
        if (o.type === C.STRUCTURE_RAMPART && o.user === user) {
            ramparts.push(o);
            continue;
        }
        if (
            object.strongholdId === o.strongholdId &&
            o.type === C.STRUCTURE_ROAD &&
            (o.hits as number) < (o.hitsMax as number)
        ) {
            damagedRoads.push(o);
        }
    }

    const context: StrongholdContext = {
        scope,
        intents,
        roomObjects,
        gameTime,
        bulk,
        creeps,
        defenders,
        damagedDefenders,
        hostiles,
        towers,
        ramparts,
        damagedRoads,
        roomController,
        core: object,
    };

    behavior(context);

    return intents.list;
}
