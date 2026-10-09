/*
 * Port of screeps/engine `processor/intents/terminal/send.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import { calcRoomsDistance, calcTerminalEnergyCost } from '../../../utils/index.ts';
import type { IntentArgs, RoomScope } from '../../scope.ts';
import type { RoomObject, TerminalSendIntent } from '../../state.ts';
import { contains, powerEffect } from '../../support.ts';

export function terminalSend(object: RoomObject, intent: IntentArgs<'send'>, scope: RoomScope): void {
    const { bulk, gameTime, env } = scope;

    const targetRoomName = intent.targetRoomName as string;
    if (!/^(W|E)\d+(N|S)\d+$/.test(targetRoomName)) {
        return;
    }

    const resourceType = intent.resourceType as string;
    if (!contains(C.RESOURCES_ALL, resourceType)) {
        return;
    }
    const amount = intent.amount as number;
    if (!amount || !object.store || !((object.store[resourceType] as number) >= amount)) {
        return;
    }
    const store = object.store;

    const range = calcRoomsDistance(object.room, targetRoomName, true, env.worldSize);
    let cost = calcTerminalEnergyCost(amount, range);

    const effect = object.effects?.find((e) => e.power === C.PWR_OPERATE_TERMINAL);
    if (effect && effect.endTime >= gameTime) {
        cost = Math.ceil(cost * powerEffect(C.PWR_OPERATE_TERMINAL, effect.level));
    }

    if (
        (resourceType != C.RESOURCE_ENERGY && (store.energy as number) < cost) ||
        (resourceType == C.RESOURCE_ENERGY && (store.energy as number) < amount + cost)
    ) {
        return;
    }

    bulk.update(object, { send: intent as TerminalSendIntent });
}
