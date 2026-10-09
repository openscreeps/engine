/*
 * Port of screeps/engine `processor/intents/invader-core/tick.js`.
 * Copyright (c) 2016, Artem Chivchalov <contact@screeps.com>. ISC license (see THIRD_PARTY_NOTICES.md).
 */

import * as C from '../../../constants.ts';
import type { RoomScope } from '../../scope.ts';
import type { RoomObject, SpawningInfo } from '../../state.ts';
import { isEqual } from '../../support.ts';
import { bornCreep } from '../spawns/born-creep.ts';

export function tickInvaderCore(object: RoomObject | undefined, scope: RoomScope): void {
  if (!object || object.type !== 'invaderCore') return;

  const { roomObjects, roomController, bulk, roomInfo, gameTime } = scope;

  const collapseEffect = (object.effects ?? []).find((e) => e.effect === C.EFFECT_COLLAPSE_TIMER);
  if (collapseEffect && collapseEffect.endTime <= gameTime) {
    if (roomController) {
      bulk.update(roomController, {
        user: null,
        level: 0,
        progress: 0,
        downgradeTime: null,
        safeMode: null,
        safeModeAvailable: 0,
        safeModeCooldown: null,
        isPowerEnabled: false,
        effects: null,
      });
    }
    return;
  }

  if (object.spawning) {
    const spawning = object.spawning as SpawningInfo;
    if (gameTime >= spawning.spawnTime - 1) {
      const spawningCreep = Object.values(roomObjects).find(
        (o) =>
          o.type === 'creep' && o.name === spawning.name && o.x === object.x && o.y === object.y,
      );
      const bornOk = bornCreep(object, spawningCreep, scope);

      if (bornOk) {
        bulk.update(object, { spawning: null });
      } else {
        bulk.update(object, { spawning: { spawnTime: 1 + gameTime } });
      }
    }
  }

  if (!isEqual(object.actionLog, object._actionLog)) {
    roomInfo.active = true;
    bulk.update(object, { actionLog: object.actionLog });
  }
}
