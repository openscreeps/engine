/*
 * Port of screeps/engine `processor/intents/spawns/renew-creep.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcCreepCost } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, BodyPart, RoomObject } from '../../state.ts';
import { dropResourcesWithoutSpace } from '../creeps/drop.ts';
import { recalcBody } from '../creeps/recalc-body.ts';
import { chargeEnergy } from './charge-energy.ts';

export function spawnRenewCreep(object: RoomObject, intent: IntentArgs<'renewCreep'>, scope: RoomScope): void {
    const { roomObjects, bulk, stats, gameTime } = scope;

    if (object.type !== 'spawn') {
        return;
    }
    if (object.spawning) {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'creep' || target.user !== object.user || target.spawning) {
        return;
    }
    if (Math.abs(target.x - object.x) > 1 || Math.abs(target.y - object.y) > 1) {
        return;
    }
    const body = target.body as BodyPart[];
    if (body.filter((i) => i.type === C.CLAIM).length > 0) {
        return;
    }

    const effect = Math.floor((C.SPAWN_RENEW_RATIO * C.CREEP_LIFE_TIME) / C.CREEP_SPAWN_TIME / body.length);
    if ((target.ageTime as number) + effect > gameTime + C.CREEP_LIFE_TIME) {
        return;
    }

    const cost = Math.ceil((C.SPAWN_RENEW_RATIO * calcCreepCost(body)) / C.CREEP_SPAWN_TIME / body.length);
    const result = chargeEnergy(object, cost, undefined, scope);

    if (!result) {
        return;
    }

    stats.inc('energyCreeps', object.user, cost);

    (target.actionLog as ActionLog).healed = { x: object.x, y: object.y };
    bulk.inc(target, 'ageTime', effect);

    if (body.some((i) => !!i.boost)) {
        body.forEach((i) => {
            i.boost = null;
        });
        recalcBody(target);
        // we may not be able to hold all of the resources we could before now.
        dropResourcesWithoutSpace(target, scope);
        bulk.update(target, { body: target.body, storeCapacity: target.storeCapacity });
    }
}
