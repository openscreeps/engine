/*
 * Port of screeps/engine `processor/intents/invader-core/upgradeController.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject } from '../../state.ts';

export function invaderCoreUpgradeController(
    object: RoomObject,
    intent: IntentArgs<'upgradeController'>,
    scope: RoomScope,
): void {
    const { roomObjects, bulk, gameTime, eventLog } = scope;

    if (object.type !== 'invaderCore') {
        return;
    }

    const target = roomObjects[intent.id as string];
    if (!target || target.type !== 'controller') {
        return;
    }

    if (target.level === 0 || target.user !== object.user) {
        return;
    }
    if (target.upgradeBlocked && target.upgradeBlocked > gameTime) {
        return;
    }

    const effect = (target.effects ?? []).find((e) => e.effect === C.EFFECT_INVULNERABILITY);
    if (effect) {
        effect.endTime = gameTime + C.INVADER_CORE_CONTROLLER_DOWNGRADE;
    } else {
        target.effects = [
            {
                effect: C.EFFECT_INVULNERABILITY,
                endTime: gameTime + C.INVADER_CORE_CONTROLLER_DOWNGRADE,
                duration: C.INVADER_CORE_CONTROLLER_DOWNGRADE,
            },
        ];
    }

    const upgradePower = 1;
    target.downgradeTime = gameTime + C.INVADER_CORE_CONTROLLER_DOWNGRADE;

    target._upgraded = (target._upgraded as number) + upgradePower;

    (object.actionLog as ActionLog).upgradeController = { x: target.x, y: target.y };

    const effects = target.effects;
    bulk.update(target, { effects: null });
    bulk.update(target, {
        downgradeTime: target.downgradeTime,
        effects,
    });

    eventLog.push({
        event: C.EVENT_UPGRADE_CONTROLLER,
        objectId: object._id,
        data: { amount: upgradePower, energySpent: 0 },
    });
}
