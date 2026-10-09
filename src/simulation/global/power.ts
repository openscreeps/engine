/*
 * Port of screeps/engine `processor/global-intents/power.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import type { GlobalScope, GlobalUserIntents } from '../scope.ts';
import type { UserDoc } from '../state.ts';
import { createPowerCreep } from './power/create-power-creep.ts';
import { deletePowerCreep } from './power/delete-power-creep.ts';
import { diePowerCreep } from './power/die-power-creep.ts';
import { renamePowerCreep } from './power/rename-power-creep.ts';
import { spawnPowerCreep } from './power/spawn-power-creep.ts';
import { suicidePowerCreep } from './power/suicide-power-creep.ts';
import { upgradePowerCreep } from './power/upgrade-power-creep.ts';

function processUser(iUserIntents: GlobalUserIntents, user: UserDoc | undefined, scope: GlobalScope): void {
    const intents = iUserIntents.intents;
    // upstream order: spawn, suicide, delete, upgrade, create, rename
    intents.spawnPowerCreep?.forEach((intent) => {
        spawnPowerCreep(intent, user, scope);
    });
    intents.suicidePowerCreep?.forEach((intent) => {
        suicidePowerCreep(intent, user, scope);
    });
    intents.deletePowerCreep?.forEach((intent) => {
        deletePowerCreep(intent, user, scope);
    });
    intents.upgradePowerCreep?.forEach((intent) => {
        upgradePowerCreep(intent, user, scope);
    });
    intents.createPowerCreep?.forEach((intent) => {
        createPowerCreep(intent, user, scope);
    });
    intents.renamePowerCreep?.forEach((intent) => {
        renamePowerCreep(intent, user, scope);
    });
}

export function processPowerIntents(scope: GlobalScope): void {
    const { usersById, userIntents, roomObjectsByType, gameTime } = scope;

    userIntents.forEach((iUserIntents) => {
        processUser(iUserIntents, usersById[iUserIntents.user], scope);
    });

    roomObjectsByType.powerCreep?.forEach((creep) => {
        if (gameTime >= (creep.ageTime as number) - 1 || (creep.hits as number) <= 0) {
            diePowerCreep(creep, scope);
        }
    });
}
