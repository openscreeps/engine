/*
 * Port of screeps/engine `processor/intents/nukes/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject } from '../../state.ts';
import { creepDie } from '../creeps/die.ts';
import { applyDamage } from '../damage.ts';

export function tickNuke(object: RoomObject, scope: RoomScope): void {
    const { roomObjects, bulk, roomController, gameTime, roomInfo, env } = scope;

    if ((roomInfo.novice && roomInfo.novice > env.now()) || (roomInfo.respawnArea && roomInfo.respawnArea > env.now())) {
        bulk.remove(object._id);
        delete roomObjects[object._id];
        return;
    }

    if (gameTime == (object.landTime as number) - 1) {
        for (const key of Object.keys(roomObjects)) {
            const target = roomObjects[key];
            if (!target) {
                continue;
            }
            if (target.type == 'creep') {
                creepDie(target, 0, true, scope, C.EVENT_ATTACK_TYPE_NUKE);
            }
            if (target.type == 'powerCreep') {
                bulk.update(target, { hits: 0 });
            }
            if (target.type == 'constructionSite' || target.type == 'energy' || target.type == 'tombstone' || target.type == 'ruin') {
                bulk.remove(target._id);
                delete roomObjects[target._id];
            }
            if (target.type == 'spawn' && target.spawning != null) {
                bulk.update(target, {
                    spawning: null,
                });
            }
        }

        for (let dx = -2; dx <= 2; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                const x = object.x + dx;
                const y = object.y + dy;
                const range = Math.max(Math.abs(dx), Math.abs(dy));
                let damage: number = range == 0 ? C.NUKE_DAMAGE[0] : C.NUKE_DAMAGE[2];

                let objects = Object.values(roomObjects).filter((i) => i.x === x && i.y === y);
                const rampart = objects.find((i) => i.type === 'rampart');
                if (rampart) {
                    const rampartHits = rampart.hits as number;
                    objects = objects.filter((i) => i !== rampart);
                    applyDamage(object, rampart, damage, C.EVENT_ATTACK_TYPE_NUKE, scope);
                    damage -= rampartHits;
                }
                if (damage > 0) {
                    objects.forEach((target) => {
                        applyDamage(object, target, damage, C.EVENT_ATTACK_TYPE_NUKE, scope);
                    });
                }
            }
        }

        if (roomController) {
            if ((roomController.safeMode as number) > gameTime) {
                bulk.update(roomController, {
                    safeMode: gameTime,
                    safeModeCooldown: null,
                });
            }

            if (
                (roomController.user &&
                    !(roomController.effects ?? []).some((e) => e.effect == C.EFFECT_INVULNERABILITY && e.endTime > gameTime) &&
                    !roomController.upgradeBlocked) ||
                (roomController.upgradeBlocked as number) < gameTime
            ) {
                bulk.update(roomController, {
                    upgradeBlocked: gameTime + C.CONTROLLER_NUKE_BLOCKED_UPGRADE,
                });
            }
        }
    }

    if (gameTime >= (object.landTime as number)) {
        bulk.remove(object._id);
        delete roomObjects[object._id];
    }
}
