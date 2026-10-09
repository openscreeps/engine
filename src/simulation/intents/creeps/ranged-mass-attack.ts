/*
 * Port of screeps/engine `processor/intents/creeps/rangedMassAttack.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcBodyEffectiveness } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';
import { applyDamage } from '../damage.ts';

const distanceRate: readonly number[] = [1, 1, 0.4, 0.1];

export function creepRangedMassAttack(
    object: RoomObject,
    _intent: IntentArgs<'rangedMassAttack'>,
    scope: RoomScope,
): void {
    const { roomObjects, roomController, gameTime } = scope;

    if (object.type !== 'creep') {
        return;
    }
    if (object.spawning) {
        return;
    }

    const attackPower = calcBodyEffectiveness(object.body ?? [], C.RANGED_ATTACK, 'rangedMassAttack', C.RANGED_ATTACK_POWER);

    if (attackPower === 0) {
        return;
    }
    if (roomController && roomController.user !== object.user && (roomController.safeMode as number) > gameTime) {
        return;
    }

    const targets = Object.values(roomObjects).filter(
        (i) =>
            (i.user !== undefined || i.type === 'powerBank') &&
            i.user !== object.user &&
            i.x >= object.x - 3 &&
            i.x <= object.x + 3 &&
            i.y >= object.y - 3 &&
            i.y <= object.y + 3,
    );

    for (const target of targets) {
        if (
            target.type !== 'rampart' &&
            Object.values(roomObjects).some((i) => i.type === 'rampart' && i.x === target.x && i.y === target.y)
        ) {
            continue;
        }
        if (!target.hits) {
            continue;
        }
        if (target.type === 'creep' && target.spawning) {
            continue;
        }
        if (
            (target.effects ?? []).some(
                (e) => e.endTime >= gameTime && (e.power === C.PWR_FORTIFY || e.effect === C.EFFECT_INVULNERABILITY),
            )
        ) {
            continue;
        }

        const distance = Math.max(Math.abs(object.x - target.x), Math.abs(object.y - target.y));

        const targetAttackPower = Math.round(attackPower * (distanceRate[distance] as number));

        applyDamage(object, target, targetAttackPower, C.EVENT_ATTACK_TYPE_RANGED_MASS, scope);
    }

    (object.actionLog as ActionLog).rangedMassAttack = {};
}
