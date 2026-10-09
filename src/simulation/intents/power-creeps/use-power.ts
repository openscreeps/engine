/*
 * Port of screeps/engine `processor/intents/power-creeps/usePower.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcResources, checkConstructionSite, comparatorDistance, dist } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, Effect, PowerCreepPowerInfo, RoomObject, Store, StoreCapacityResource } from '../../state.ts';
import { lookup } from '../../support.ts';
import { drop } from '../creeps/drop.ts';

interface PowerInfo {
    readonly className: string;
    readonly level: readonly number[];
    readonly cooldown: number;
    readonly duration?: number | readonly number[];
    readonly range?: number;
    readonly ops?: number | readonly number[];
    readonly effect?: readonly number[];
}

export function usePower(object: RoomObject, intent: IntentArgs<'usePower'>, scope: RoomScope): void {
    const { roomObjects, roomTerrain, gameTime, bulk, eventLog, roomController } = scope;

    if (roomController) {
        if (!roomController.isPowerEnabled) {
            return;
        }
        if (roomController.user != object.user && (roomController.safeMode as number) > gameTime) {
            return;
        }
    }

    const powerInfo = lookup(C.POWER_INFO as Readonly<Record<string, PowerInfo>>, intent.power);
    if (!powerInfo) {
        return;
    }
    const power = intent.power as number;
    const creepPower = (object.powers as Record<string, PowerCreepPowerInfo | undefined>)[power];
    let target: RoomObject | undefined;

    if (!creepPower || creepPower.level == 0 || (creepPower.cooldownTime as number) > gameTime) {
        return;
    }

    const rawOps = powerInfo.ops || 0;
    const ops = (Array.isArray(rawOps) ? (rawOps as readonly number[])[creepPower.level - 1] : rawOps) as number;

    object.store = object.store || {};
    const store: Store = object.store;
    if ((store.ops || 0) < ops) {
        return;
    }

    if (powerInfo.range) {
        target = roomObjects[intent.id as string];
        if (!target) {
            return;
        }
        if (dist(object, target) > powerInfo.range) {
            return;
        }
        const currentEffect = (target.effects || []).find((i) => i.power == power);
        if (currentEffect && (currentEffect.level as number) > creepPower.level && currentEffect.endTime > gameTime) {
            return;
        }
    }

    const effectValue = (powerInfo.effect as readonly number[])[creepPower.level - 1] as number;
    let applyEffectOnTarget = false;
    const t = target as RoomObject;

    switch (power) {
        case C.PWR_GENERATE_OPS: {
            bulk.update(object, {
                store: { [C.RESOURCE_OPS]: (store[C.RESOURCE_OPS] || 0) + effectValue },
            });
            const sum = calcResources(object);

            if (sum > (object.storeCapacity as number)) {
                drop(
                    object,
                    {
                        amount: Math.min(store[C.RESOURCE_OPS] as number, sum - (object.storeCapacity as number)),
                        resourceType: C.RESOURCE_OPS,
                    },
                    scope,
                );
            }
            break;
        }

        case C.PWR_OPERATE_SPAWN:
        case C.PWR_DISRUPT_SPAWN: {
            if (t.type != 'spawn') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_TOWER:
        case C.PWR_DISRUPT_TOWER: {
            if (t.type != 'tower') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_STORAGE: {
            if (t.type != 'storage') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_LAB: {
            if (t.type != 'lab') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_EXTENSION: {
            if (!t.store || (t.type != 'storage' && t.type != 'terminal' && t.type != 'factory' && t.type !== 'container')) {
                return;
            }
            const controller = roomController as RoomObject;
            if (t.user && t.user != controller.user) {
                return;
            }
            const effect = (t.effects || []).find((i) => i.power === C.PWR_DISRUPT_TERMINAL);
            if (effect && effect.endTime > gameTime) {
                return;
            }
            const extensions = Object.values(roomObjects).filter(
                (i) => i.type == 'extension' && i.user == controller.user && !i.off,
            );
            let energySent = 0;
            let capacitySum = 0;
            for (const extension of extensions) {
                const value = extension.storeCapacityResource?.energy;
                capacitySum += typeof value === 'number' ? value : 0;
            }
            const targetStore = t.store;
            const energyLimit = Math.min(targetStore.energy as number, effectValue * capacitySum);
            extensions.sort(comparatorDistance(t));
            extensions.every((extension) => {
                const extStore = extension.store as Store;
                const energy = Math.min(
                    energyLimit - energySent,
                    ((extension.storeCapacityResource as StoreCapacityResource).energy as number) - (extStore.energy as number),
                );
                bulk.update(extension, { store: { energy: (extStore.energy as number) + energy } });
                energySent += energy;
                return energySent < energyLimit;
            });
            if (energySent === 0) {
                return;
            }
            bulk.update(t, { store: { energy: (targetStore.energy as number) - energySent } });
            break;
        }

        case C.PWR_OPERATE_OBSERVER: {
            if (t.type != 'observer') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_TERMINAL:
        case C.PWR_DISRUPT_TERMINAL: {
            if (t.type != 'terminal') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_DISRUPT_SOURCE:
        case C.PWR_REGEN_SOURCE: {
            if (t.type != 'source') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_REGEN_MINERAL: {
            if (t.type != 'mineral') return;
            if (t.mineralAmount == 0) return;
            if (t.nextRegenerationTime) return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_CONTROLLER: {
            if (t.type != 'controller') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_OPERATE_POWER: {
            if (t.type != 'powerSpawn') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_FORTIFY: {
            if (t.type != 'rampart' && t.type != 'constructedWall') return;
            applyEffectOnTarget = true;
            break;
        }

        case C.PWR_SHIELD: {
            const constructionSite = Object.values(roomObjects).find(
                (i) => i.x == object.x && i.y == object.y && i.type == 'constructionSite',
            );
            if (constructionSite) {
                bulk.remove(constructionSite._id);
                // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- mirrors upstream
                delete roomObjects[constructionSite._id];
            }
            if (
                !checkConstructionSite(roomObjects, 'rampart', object.x, object.y) ||
                !checkConstructionSite(roomTerrain, 'rampart', object.x, object.y)
            ) {
                return;
            }
            const duration = powerInfo.duration as number;
            bulk.insert({
                type: 'rampart',
                room: object.room,
                x: object.x,
                y: object.y,
                user: object.user as string,
                hits: effectValue,
                hitsMax: 0,
                nextDecayTime: gameTime + duration,
                effects: [
                    {
                        power: C.PWR_SHIELD,
                        level: creepPower.level,
                        endTime: gameTime + duration,
                    } as Effect,
                ],
            });
            break;
        }

        case C.PWR_OPERATE_FACTORY: {
            if (t.type != 'factory') return;
            if (!t.level) {
                bulk.update(t, { level: creepPower.level });
            } else if (t.level != creepPower.level) {
                return;
            }
            applyEffectOnTarget = true;
            break;
        }
    }

    if (applyEffectOnTarget) {
        const effects = Object.values(t.effects || []).filter((i) => i.power !== power);
        const duration = powerInfo.duration;
        effects.push({
            effect: power,
            power,
            level: creepPower.level,
            endTime:
                gameTime +
                ((Array.isArray(duration) ? (duration as readonly number[])[creepPower.level - 1] : duration) as number),
        });
        bulk.update(t, { effects: null });
        bulk.update(t, { effects });
    }

    bulk.update(object, {
        powers: {
            [power]: {
                cooldownTime: gameTime + powerInfo.cooldown,
            },
        },
        store: { ops: (store.ops || 0) - ops },
    });

    eventLog.push({
        event: C.EVENT_POWER,
        objectId: object._id,
        data: {
            power,
            targetId: intent.id as string,
        },
    });

    (object.actionLog as ActionLog).power = {
        // upstream stores the power number under `id`
        id: power,
        x: target ? target.x : object.x,
        y: target ? target.y : object.y,
    };
}
