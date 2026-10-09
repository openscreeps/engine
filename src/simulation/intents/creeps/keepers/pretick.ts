/*
 * Port of screeps/engine `processor/intents/creeps/keepers/pretick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import { dist } from '../../../../utils/index.ts';
import { IntentList, lodashMin, moveTo } from '../../../npc/fake-runtime.ts';
import type { ObjectIntentSet, RoomScope } from '../../../scope.ts';
import type { RoomObject } from '../../../state.ts';

const damageByRange = [10, 10, 4, 1];

/** Source keeper AI: guard the nearest source/mineral and fight anything nearby. */
export function keeperPretick(creep: RoomObject, scope: RoomScope): Record<string, ObjectIntentSet> {
    const { roomObjects, bulk } = scope;

    let source: RoomObject | undefined = undefined;
    const resources: RoomObject[] = [];
    const hostilesInMeleeRange: RoomObject[] = [];
    const hostilesInRangedRange: RoomObject[] = [];

    const intents = new IntentList();

    for (const key of Object.keys(roomObjects)) {
        const object = roomObjects[key] as RoomObject;
        if (object.type === 'source' || object.type === 'mineral') {
            resources.push(object);
        }
        if ((object.type === 'creep' || object.type === 'powerCreep') && object.user !== '2' && object.user !== '3') {
            const distance = dist(creep, object);
            if (distance <= 1) {
                hostilesInMeleeRange.push(object);
            }
            if (distance <= 3) {
                hostilesInRangedRange.push(object);
            }
        }
    }

    if (creep.memory_sourceId && !!roomObjects[creep.memory_sourceId]) {
        source = roomObjects[creep.memory_sourceId];
    }

    if (!source) {
        source = resources.find((o) => dist(creep, o) <= 5);
        if (source) {
            bulk.update(creep, { memory_sourceId: source._id.toString() });
        }
    }

    if (source && dist(source, creep) > 1) {
        const direction = moveTo(creep, source, { range: 1, reusePath: 50 }, scope);
        if ((direction as number) > 0) {
            intents.set(creep._id, 'move', { direction });
        } else {
            bulk.update(creep, { memory_move: null });
        }
    }

    // lodash 3 `_.min` yields `Infinity` (truthy) for an empty list: keepers always get an attack intent
    const meleeTarget = lodashMin(hostilesInMeleeRange, (c) => c.hits);
    if (meleeTarget) {
        const target = meleeTarget as Partial<RoomObject>;
        intents.set(creep._id, 'attack', { id: target._id, x: target.x, y: target.y });
    }

    if (hostilesInRangedRange.length > 0) {
        let massDamage = 0;
        for (const c of hostilesInRangedRange) {
            massDamage += damageByRange[dist(creep, c)] ?? 0;
        }
        if (massDamage > 13) {
            intents.set(creep._id, 'rangedMassAttack', {});
        } else {
            const rangedTarget = lodashMin(hostilesInRangedRange, (c) => c.hits) as Partial<RoomObject>;
            intents.set(creep._id, 'rangedAttack', { id: rangedTarget._id });
        }
    }

    return intents.list;
}
