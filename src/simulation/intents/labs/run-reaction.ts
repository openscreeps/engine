/*
 * Port of screeps/engine `processor/intents/labs/run-reaction.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { ActionLog, RoomObject, Store, StoreCapacityResource } from '../../state.ts';
import { lookup, powerEffect } from '../../support.ts';

function labMineralType(store: Store | undefined): string | undefined {
    if (!store) return undefined;
    return Object.keys(store).find((k) => k != C.RESOURCE_ENERGY && store[k]);
}

export function labRunReaction(object: RoomObject, intent: IntentArgs<'runReaction'>, scope: RoomScope): void {
    const { roomObjects, bulk, gameTime } = scope;

    if (!!object.cooldownTime && object.cooldownTime > gameTime) {
        return;
    }

    let reactionAmount: number = C.LAB_REACTION_AMOUNT;
    const effect = object.effects?.find((e) => e.power === C.PWR_OPERATE_LAB);
    if (effect && effect.endTime > gameTime) {
        reactionAmount += powerEffect(C.PWR_OPERATE_LAB, effect.level);
    }

    const lab1 = roomObjects[String(intent.lab1)];
    if (!lab1 || lab1.type != 'lab') {
        return;
    }
    const lab1Store = lab1.store as Store;
    const lab1MineralType = labMineralType(lab1.store);
    if (!lab1MineralType || (lab1Store[lab1MineralType] as number) < reactionAmount) {
        return;
    }
    if (Math.abs(lab1.x - object.x) > 2 || Math.abs(lab1.y - object.y) > 2) {
        return;
    }

    const lab2 = roomObjects[String(intent.lab2)];
    if (!lab2 || lab2.type != 'lab') {
        return;
    }
    const lab2Store = lab2.store as Store;
    const lab2MineralType = labMineralType(lab2.store);
    if (!lab2MineralType || (lab2Store[lab2MineralType] as number) < reactionAmount) {
        return;
    }
    if (Math.abs(lab2.x - object.x) > 2 || Math.abs(lab2.y - object.y) > 2) {
        return;
    }

    const store = object.store as Store;
    const mineralType = labMineralType(object.store);
    if ((store[mineralType as string] || 0) + reactionAmount > C.LAB_MINERAL_CAPACITY) {
        return;
    }

    const product = lookup<string>(
        lookup<Readonly<Record<string, string>>>(C.REACTIONS, lab1MineralType) as Readonly<Record<string, string>>,
        lab2MineralType,
    );

    if (!product || (mineralType && mineralType != product)) {
        return;
    }

    const reactionTime = lookup<number>(C.REACTION_TIME, product) as number;
    if ((object.storeCapacityResource as StoreCapacityResource)[product]) {
        bulk.update(object, {
            store: { [product]: (store[product] || 0) + reactionAmount },
            cooldownTime: gameTime + reactionTime,
        });
    } else {
        bulk.update(object, {
            store: { [product]: (store[product] || 0) + reactionAmount },
            cooldownTime: gameTime + reactionTime,
            storeCapacityResource: { [product]: C.LAB_MINERAL_CAPACITY },
            storeCapacity: null,
        });
    }

    lab1Store[lab1MineralType] = (lab1Store[lab1MineralType] as number) - reactionAmount;
    if (lab1Store[lab1MineralType]) {
        bulk.update(lab1, { store: { [lab1MineralType]: lab1Store[lab1MineralType] } });
    } else {
        bulk.update(lab1, {
            store: { [lab1MineralType]: lab1Store[lab1MineralType] },
            storeCapacityResource: { [lab1MineralType]: null },
            storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
        });
    }
    lab2Store[lab2MineralType] = (lab2Store[lab2MineralType] as number) - reactionAmount;
    if (lab2Store[lab2MineralType]) {
        bulk.update(lab2, { store: { [lab2MineralType]: lab2Store[lab2MineralType] } });
    } else {
        bulk.update(lab2, {
            store: { [lab2MineralType]: lab2Store[lab2MineralType] },
            storeCapacityResource: { [lab2MineralType]: null },
            storeCapacity: C.LAB_ENERGY_CAPACITY + C.LAB_MINERAL_CAPACITY,
        });
    }

    (object.actionLog as ActionLog).runReaction = { x1: lab1.x, y1: lab1.y, x2: lab2.x, y2: lab2.y };
}
